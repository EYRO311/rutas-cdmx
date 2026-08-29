/**
 * `calcular_ruta` -- envuelve `POST /v1/routes` (motor real conectado,
 * `src/routing/index.ts` vía `RealRouterEngine`, ver docs/handoff/05-api.md
 * sección 9). Esta es LA herramienta principal de este servidor: "¿cómo
 * llego más rápido a ESCOM saliendo en 20 minutos?".
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiClient } from "../http-client.js";
import { resolvePlace, describeUnresolved, type PlaceInput } from "../places.js";
import { renderRouteOption, type ApiRouteOption } from "../route-summary.js";

const KNOWN_MODES = [
  "metro",
  "metrobus",
  "rtp",
  "cc",
  "trole",
  "cablebus",
  "pumabus",
  "tren_ligero",
  "suburbano",
  "interurbano",
  "ecobici",
  "walk",
  "auto",
  "transfer",
  "transit",
] as const;

const placeInputSchema = z
  .union([
    z
      .string()
      .min(1)
      .describe('Nombre guardado del usuario ("casa", "ESCOM") o coordenadas como texto "19.4326,-99.1332".'),
    z
      .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
      .describe("Coordenadas WGS84 explícitas."),
  ])
  .describe('Lugar de origen/destino. Ejemplos válidos: "casa", "ESCOM", "19.4326,-99.1332", o {"lat":19.4326,"lon":-99.1332}.');

export const calcularRutaInputShape = {
  origen: placeInputSchema,
  destino: placeInputSchema,
  user_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Id del usuario. OBLIGATORIO si origen/destino usan un nombre guardado ("casa") en vez de coordenadas -- sin user_id no hay forma de saber de quién es "casa". También permite que el motor personalice con sus modos habilitados.'
    ),
  hora_salida: z
    .string()
    .optional()
    .describe(
      'Hora de salida deseada, ISO 8601 CON offset, ej. "2025-06-16T08:00:00-06:00". Si se omite, se calcula saliendo "ahora". Excluyente con hora_llegada.'
    ),
  hora_llegada: z
    .string()
    .optional()
    .describe(
      'Hora en la que el usuario quiere LLEGAR, ISO 8601 con offset. Ojo: el motor real todavía no resuelve "llegar antes de X" (gap documentado) -- si se manda, la ruta se calcula saliendo ahora y se avisa explícitamente que hora_llegada fue ignorada. Excluyente con hora_salida.'
    ),
  modos_permitidos: z
    .array(z.enum(KNOWN_MODES))
    .min(1)
    .optional()
    .describe(
      'Restringe los modos que puede usar la ruta, ej. ["metro","walk"] si el usuario dice "sin camión". Si se omite, se consideran todos los modos disponibles. Nota: Ecobici NO participa del cálculo de rutas todavía (limitación conocida del motor), aunque aparezca en este enum.'
    ),
  max_resultados: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("Cuántas opciones de ruta devolver como máximo (1-5). Default 3."),
};

const calcularRutaInputSchema = z.object(calcularRutaInputShape);
export type CalcularRutaInput = z.infer<typeof calcularRutaInputSchema>;

export function registerCalcularRuta(server: McpServer): void {
  server.registerTool(
    "calcular_ruta",
    {
      title: "Calcular ruta CDMX",
      description:
        "Usa esta herramienta cuando el usuario pregunte cómo llegar de un punto A a un punto B en la Ciudad " +
        'de México -- ej. "¿cómo llego a ESCOM desde el Ángel?", "¿cuál es la ruta más rápida a Reforma 222 ' +
        'saliendo a las 8am?", "salgo en 20 minutos de la oficina, ¿qué combinación de Metro y Metrobús me conviene?". ' +
        "Calcula rutas reales combinando Metro, Metrobús, RTP, Corredores Concesionados, Trolebús, Cablebús, " +
        "Pumabús, Tren Ligero, Suburbano, Interurbano y caminata, con horarios y transbordos reales del GTFS " +
        "cargado. NO uses esta herramienta para disponibilidad de Ecobici (usa estado_ecobici) ni para saber si " +
        "un auto puede circular hoy (usa puede_circular_hoy) -- el motor de ruteo no mete tramos en bici ni en " +
        "auto intercalados (el auto, si acaso, es un modo terminal completo, no algo que esta herramienta arma). " +
        'origen/destino aceptan un lugar guardado ("casa", "ESCOM") o coordenadas -- si el usuario menciona un ' +
        'lugar ambiguo o no guardado ("al centro", "la oficina" sin que exista ese lugar guardado), esta ' +
        "herramienta NO adivina: devuelve candidatos o pide coordenadas para que tú se lo preguntes al usuario. " +
        "IMPORTANTE sobre fechas: el GTFS cargado solo tiene vigencia real aproximadamente entre 2024-12-01 y " +
        "2025-12-31. Si el usuario no da una fecha y hoy está fuera de ese rango, vas a recibir 'sin cobertura " +
        "para esa fecha' -- no es que la herramienta esté rota, es que no hay horarios cargados para hoy. Para " +
        'demostrar o probar la herramienta usa una fecha dentro de esa vigencia, ej. "2025-06-16T08:00:00-06:00" (lunes).',
      inputSchema: calcularRutaInputShape,
    },
    async (args) => {
      if (args.hora_salida && args.hora_llegada) {
        return {
          isError: true,
          content: [{ type: "text", text: "Manda hora_salida o hora_llegada, no ambas." }],
        };
      }

      const [origenRes, destinoRes] = await Promise.all([
        resolvePlace(args.user_id, args.origen as PlaceInput),
        resolvePlace(args.user_id, args.destino as PlaceInput),
      ]);

      const problems: string[] = [];
      if (origenRes.kind !== "resolved") problems.push(`Origen: ${describeUnresolved(origenRes)}`);
      if (destinoRes.kind !== "resolved") problems.push(`Destino: ${describeUnresolved(destinoRes)}`);
      if (problems.length > 0) {
        return { content: [{ type: "text", text: problems.join("\n") }] };
      }
      // TypeScript no lo infiere tras el push condicional -- ya se validó arriba que ambos son "resolved".
      const origen = (origenRes as Extract<typeof origenRes, { kind: "resolved" }>).coord;
      const destino = (destinoRes as Extract<typeof destinoRes, { kind: "resolved" }>).coord;

      const result = await apiClient.post<{ routes: ApiRouteOption[] }>("/v1/routes", {
        origin: { lat: origen.lat, lon: origen.lon },
        destination: { lat: destino.lat, lon: destino.lon },
        ...(args.hora_salida ? { departure_at: args.hora_salida } : {}),
        ...(args.hora_llegada ? { arrival_at: args.hora_llegada } : {}),
        ...(args.modos_permitidos ? { allowed_modes: args.modos_permitidos } : {}),
        ...(args.max_resultados ? { max_results: args.max_resultados } : {}),
        ...(args.user_id ? { user_id: args.user_id } : {}),
      });

      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `No se pudo calcular la ruta: ${result.message} (${result.code}).` }],
        };
      }

      const routes = result.data.routes;
      const engineMeta = (result.meta["engine"] ?? {}) as Record<string, unknown>;
      const warnings = (result.meta["warnings"] as string[] | undefined) ?? [];

      const originLabel = origen.label ? `"${origen.label}"` : `(${origen.lat.toFixed(4)}, ${origen.lon.toFixed(4)})`;
      const destLabel = destino.label ? `"${destino.label}"` : `(${destino.lat.toFixed(4)}, ${destino.lon.toFixed(4)})`;

      if (routes.length === 0) {
        const planConfidence = engineMeta["plan_confidence"];
        const noCoverageNote =
          planConfidence === "no_coverage"
            ? " Sin cobertura de horarios para esa fecha/hora (el GTFS cargado tiene vigencia real " +
              "aproximadamente 2024-12-01 a 2025-12-31 -- si no mandaste hora_salida se usó 'ahora', que puede " +
              "caer fuera de ese rango). Prueba con una fecha dentro de esa vigencia."
            : "";
        return {
          content: [
            {
              type: "text",
              text: `No encontré ninguna ruta de ${originLabel} a ${destLabel}.${noCoverageNote}`,
            },
          ],
        };
      }

      const parts = [
        `${routes.length} ruta(s) de ${originLabel} a ${destLabel}:`,
        ...routes.map((r, i) => renderRouteOption(r, i + 1)),
      ];
      if (warnings.length > 0) parts.push(...warnings.map((w) => `Aviso: ${w}`));

      return { content: [{ type: "text", text: parts.join("\n\n") }] };
    }
  );
}
