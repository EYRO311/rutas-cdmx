/**
 * `registrar_viaje` -- envuelve `POST /v1/trips` (real, inserta en
 * `trip_history`, insumo de `aprendizaje-beta` Fase 5). Pensada para que
 * el asistente capture el viaje REAL después del hecho ("ya llegué,
 * tardé 25 minutos") -- no para planear, para eso es calcular_ruta.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiClient } from "../http-client.js";
import { resolvePlace, describeUnresolved, type PlaceInput } from "../places.js";

const placeInputSchema = z
  .union([
    z.string().min(1).describe('Nombre guardado ("casa", "ESCOM") o coordenadas como texto "19.4326,-99.1332".'),
    z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
  ])
  .describe('Lugar. Ejemplos: "casa", "19.4326,-99.1332", o {"lat":19.4326,"lon":-99.1332}.');

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

export const registrarViajeInputShape = {
  user_id: z.string().min(1).max(128).describe('Id del usuario que hizo el viaje, ej. "emiliano".'),
  origen: placeInputSchema,
  destino: placeInputSchema,
  duracion_real_min: z
    .number()
    .positive()
    .optional()
    .describe("Cuánto tardó el viaje REAL, en minutos (no segundos) -- ej. 25 para un viaje de 25 minutos."),
  duracion_planeada_min: z
    .number()
    .positive()
    .optional()
    .describe("Cuánto había estimado calcular_ruta para este viaje, en minutos, si se quiere comparar."),
  hora_salida_real: z.string().optional().describe("Hora real de salida, ISO 8601 con offset."),
  hora_llegada_real: z.string().optional().describe("Hora real de llegada, ISO 8601 con offset."),
  modos_usados: z
    .array(z.enum(KNOWN_MODES))
    .optional()
    .describe('Modos que realmente se usaron, ej. ["walk","metrobus","metro"].'),
  calificacion: z.number().int().min(1).max(5).optional().describe("Qué tan bien le fue al usuario con este viaje, 1-5."),
  notas: z.string().max(2000).optional().describe('Comentario libre, ej. "el Metrobús venía repleto".'),
};

const registrarViajeInputSchema = z.object(registrarViajeInputShape);

interface TripCreatedData {
  id: string;
  created_at: string;
}

export function registerRegistrarViaje(server: McpServer): void {
  server.registerTool(
    "registrar_viaje",
    {
      title: "Registrar viaje real",
      description:
        'Usa esta herramienta DESPUÉS de que el usuario ya hizo un viaje, para guardar cómo le fue de verdad -- ' +
        'ej. "ya llegué, tardé 25 minutos", "el viaje a ESCOM de hoy en la mañana estuvo pésimo, tardé el doble". ' +
        "NO es para planear un viaje futuro (para eso usa calcular_ruta) -- es para capturar el dato real y " +
        "alimentar la calibración del sistema con el historial real del usuario (CLAUDE.md decisión #4: 'el " +
        "usuario es el beta'). Si el usuario menciona cuánto había calculado la app contra cuánto tardó de " +
        "verdad, captura ambos (duracion_planeada_min y duracion_real_min) -- esa comparación es justo lo que " +
        "hace útil este registro.",
      inputSchema: registrarViajeInputShape,
    },
    async (rawArgs) => {
      const args = registrarViajeInputSchema.parse(rawArgs);

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
      const origen = (origenRes as Extract<typeof origenRes, { kind: "resolved" }>).coord;
      const destino = (destinoRes as Extract<typeof destinoRes, { kind: "resolved" }>).coord;

      const result = await apiClient.post<TripCreatedData>("/v1/trips", {
        user_id: args.user_id,
        origin: { lat: origen.lat, lon: origen.lon },
        destination: { lat: destino.lat, lon: destino.lon },
        ...(args.hora_salida_real ? { actual_departure_at: args.hora_salida_real } : {}),
        ...(args.hora_llegada_real ? { actual_arrival_at: args.hora_llegada_real } : {}),
        ...(args.duracion_real_min ? { actual_duration_secs: Math.round(args.duracion_real_min * 60) } : {}),
        ...(args.duracion_planeada_min ? { planned_duration_secs: Math.round(args.duracion_planeada_min * 60) } : {}),
        ...(args.modos_usados ? { modes_used: args.modos_usados } : {}),
        ...(args.calificacion ? { user_rating: args.calificacion } : {}),
        ...(args.notas ? { notes: args.notas } : {}),
      });

      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `No se pudo registrar el viaje: ${result.message} (${result.code}).` }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Viaje registrado (id ${result.data.id}). Gracias -- esto ayuda a calibrar mejor las próximas rutas.`,
          },
        ],
      };
    }
  );
}
