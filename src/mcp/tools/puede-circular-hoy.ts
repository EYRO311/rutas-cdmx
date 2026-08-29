/**
 * `puede_circular_hoy` -- respuesta directa de Hoy No Circula (CDMX).
 *
 * DECISIÓN TÉCNICA (documentada también en docs/handoff/06-mcp.md,
 * sección "Decisiones"): `evaluarHoyNoCircula` (`src/modes/auto/
 * hoy-no-circula.ts`) no tiene NINGÚN endpoint HTTP que la exponga --
 * `modo-auto` (Fase 3) la construyó y la probó, pero `api-http` nunca
 * conectó el modo AUTO a ningún endpoint (confirmado leyendo
 * `src/api/app.ts`: solo registra health/routes/stops/trips/modes). Se
 * decidió IMPORTAR la función directamente (dependencia de código entre
 * módulos, no vía HTTP) en vez de dejar esta herramienta con una
 * implementación parcial, por:
 *
 * 1. Es una función pura: cero imports, cero I/O, cero conexión a
 *    Postgres (se puede confirmar leyendo el archivo completo) -- no
 *    arrastra ningún estado ni configuración de `modo-auto` (a diferencia
 *    de, digamos, `eta-provider.ts`, que sí necesita `GOOGLE_ROUTES_API_KEY`
 *    y hace red). Importarla no acopla este servidor a nada más que un
 *    cálculo de calendario.
 * 2. El brief de esta fase EXPLÍCITAMENTE prohíbe inventar un endpoint
 *    HTTP nuevo en `src/api/` (fuera de alcance, tocaría código de otro
 *    agente) -- la alternativa realista a "documentar el gap y dejar la
 *    tool a medias" es esta, no las dos juntas.
 * 3. El costo de NO ofrecer esta herramienta con lógica real (dejarla
 *    devolver solo "no implementado") le quita valor real al caso de uso
 *    principal del brief ("¿me conviene sacar el coche hoy?") sin ganar
 *    nada -- la función ya existe, está probada (`modo-auto`, Fase 3), y
 *    HNC no depende de datos con vigencia (a diferencia de calcular_ruta,
 *    la evaluación de HNC es pura lógica de calendario, nunca da
 *    "sin cobertura").
 *
 * El costo real de esta decisión: si `modo-auto` cambia la firma o el
 * comportamiento de `evaluarHoyNoCircula`, este servidor se rompe en
 * build time (import directo), no en runtime -- se considera preferible
 * a un endpoint HTTP nuevo fuera de mi alcance o una tool muda.
 *
 * La config del vehículo (terminación de placa, holograma) si se manda
 * `user_id` en vez de explícita SÍ viene por HTTP real (`GET /v1/modes`,
 * tabla `user_modes`) -- solo la función de evaluación en sí es import
 * directo.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiClient } from "../http-client.js";
import { evaluarHoyNoCircula, type Holograma, type HoyNoCirculaInput } from "../../modes/auto/hoy-no-circula.js";

const HOLOGRAMAS = ["00", "0", "1", "2", "exento", "foraneo"] as const;

export const puedeCircularHoyInputShape = {
  user_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Id del usuario, para leer su terminación de placa y holograma guardados (GET /v1/modes, configurados " +
        "antes vía PUT /v1/modes). Si no lo mandas, tienes que mandar terminacion_placa y holograma directo."
    ),
  terminacion_placa: z
    .number()
    .int()
    .min(0)
    .max(9)
    .optional()
    .describe("Último dígito de la placa, 0-9. Si no se manda, se intenta leer de user_id."),
  holograma: z
    .enum(HOLOGRAMAS)
    .optional()
    .describe(
      '"00"/"0" = hologramas exentos del programa regular (circulan siempre salvo contingencia), "1"/"2" = ' +
        'los que sí descansan por terminación, "exento" = discapacidad/escolar/etc (circula siempre), ' +
        '"foraneo" = placas de fuera de CDMX/Edomex. Si no se manda, se intenta leer de user_id.'
    ),
  fecha: z
    .string()
    .optional()
    .describe(
      'Fecha/hora del viaje planeado, ISO 8601 con offset, ej. "2026-08-17T09:00:00-06:00". Si se omite, se ' +
        "evalúa para ahora mismo, hora de Ciudad de México."
    ),
  contingencia_activa: z
    .boolean()
    .optional()
    .describe("Si hoy hay contingencia ambiental activa (Fase 1 o 2). Si no se sabe, se omite (default: no activa)."),
  contingencia_fase: z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .describe("Fase de la contingencia ambiental, si contingencia_activa es true."),
};

const puedeCircularHoyInputSchema = z.object(puedeCircularHoyInputShape);

interface ModesData {
  user_id: string;
  modes: Array<{
    mode: string;
    is_enabled: boolean;
    tiene_auto: boolean | null;
    terminacion_placa: number | null;
    holograma: string | null;
  }>;
}

/**
 * Un `Date` cuyos getters LOCALES (getDay/getDate/getMonth -- lo único
 * que usa `evaluarHoyNoCircula`) reflejan el calendario de Ciudad de
 * México, sin importar en qué zona horaria corre el proceso (Vercel
 * puede correr en UTC). Se deriva year/month/day vía `Intl.DateTimeFormat`
 * con `timeZone: "America/Mexico_City"` y se construye un `Date` con esos
 * componentes como "locales" -- el día de la semana de una fecha
 * calendario es un hecho absoluto (no depende de zona horaria), así que
 * mientras se escriban y se lean los componentes de forma consistente
 * (ambos "locales" al proceso), el resultado es correcto. Mismo problema
 * que resolvió `src/api/lib/cdmx-time.ts` para el motor de ruteo, pero
 * con una forma de salida distinta (un `Date` para `evaluarHoyNoCircula`,
 * no un `{serviceDate, secs}`) -- no se reutiliza ese helper porque no
 * devuelve lo que esta función necesita.
 */
function cdmxCalendarDate(iso: string | undefined): Date {
  const instant = iso ? new Date(iso) : new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return new Date(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
}

export function registerPuedeCircularHoy(server: McpServer): void {
  server.registerTool(
    "puede_circular_hoy",
    {
      title: "Hoy No Circula",
      description:
        'Usa esta herramienta cuando el usuario pregunte si puede sacar el coche hoy (o un día específico) -- ' +
        'ej. "¿puedo circular hoy?", "mi placa termina en 7, holograma 2, ¿me toca Hoy No Circula el jueves?", ' +
        '"hay contingencia ambiental, ¿puedo usar el coche?". Responde SÍ/NO directo con el motivo (programa ' +
        "regular por terminación de placa, o contingencia ambiental). Si hay contingencia activa y no se conoce " +
        "el boletín exacto del día, aplica un criterio CONSERVADOR (prefiere decir que no puede circular antes " +
        "que arriesgar una multa) y lo marca con confianza baja -- avísale al usuario que verifique el boletín " +
        "oficial de CAME/SEDEMA ese día si la confianza es baja. NO calcula rutas ni ETAs de auto (para eso no " +
        "hay herramienta en este servidor -- el modo AUTO de la API HTTP real no está expuesto todavía, ver " +
        "docs/handoff/06-mcp.md).",
      inputSchema: puedeCircularHoyInputShape,
    },
    async (rawArgs) => {
      const args = puedeCircularHoyInputSchema.parse(rawArgs);

      let terminacionPlaca = args.terminacion_placa;
      let holograma = args.holograma;

      if ((terminacionPlaca === undefined || holograma === undefined) && args.user_id) {
        const result = await apiClient.get<ModesData>("/v1/modes", { user_id: args.user_id });
        if (!result.ok) {
          return {
            isError: true,
            content: [
              { type: "text", text: `No pude leer la configuración de auto de ${args.user_id}: ${result.message}.` },
            ],
          };
        }
        const autoMode = result.data.modes.find((m) => m.mode === "auto");
        if (autoMode) {
          terminacionPlaca ??= autoMode.terminacion_placa ?? undefined;
          if (holograma === undefined && autoMode.holograma && (HOLOGRAMAS as readonly string[]).includes(autoMode.holograma)) {
            holograma = autoMode.holograma as Holograma;
          }
        }
      }

      if (terminacionPlaca === undefined || holograma === undefined) {
        return {
          content: [
            {
              type: "text",
              text:
                "Me falta terminación de placa y/o holograma para evaluar Hoy No Circula. Mándalos directo " +
                "(terminacion_placa, holograma), o configúralos antes con PUT /v1/modes (modo 'auto') y pásame " +
                "user_id.",
            },
          ],
        };
      }

      const fecha = cdmxCalendarDate(args.fecha);

      const input: HoyNoCirculaInput = {
        terminacionPlaca,
        holograma,
        fecha,
        ...(args.contingencia_activa
          ? { contingencia: { activa: true, fase: args.contingencia_fase ?? 1 } }
          : {}),
      };

      let resultado;
      try {
        resultado = evaluarHoyNoCircula(input);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        };
      }

      const diaTxt = new Intl.DateTimeFormat("es-MX", {
        timeZone: "America/Mexico_City",
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(args.fecha ? new Date(args.fecha) : new Date());

      const veredicto = resultado.restringido ? "NO puede circular" : "SÍ puede circular";
      const confianzaTxt =
        resultado.confianza === "baja"
          ? " (confianza BAJA -- es un estimado conservador por contingencia sin boletín oficial confirmado, verifica con SEDEMA/CAME)"
          : "";

      return {
        content: [
          {
            type: "text",
            text: `${veredicto} el ${diaTxt}. ${resultado.motivo}${confianzaTxt}`,
          },
        ],
      };
    }
  );
}
