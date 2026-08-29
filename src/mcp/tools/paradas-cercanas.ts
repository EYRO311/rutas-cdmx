/**
 * `paradas_cercanas` -- envuelve `GET /v1/stops/near` (real desde Fase 3,
 * nunca fue stub -- ver docs/handoff/05-api.md sección 1). PostGIS
 * `ST_DWithin`/`ST_Distance` sobre las 11,362 paradas reales del GTFS.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiClient } from "../http-client.js";
import { resolvePlace, describeUnresolved, type PlaceInput } from "../places.js";
import { formatDistance } from "../format.js";

const placeInputSchema = z
  .union([
    z.string().min(1).describe('Nombre guardado ("casa", "ESCOM") o coordenadas como texto "19.4326,-99.1332".'),
    z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
  ])
  .describe('Punto de referencia. Ejemplos: "casa", "19.4326,-99.1332", o {"lat":19.4326,"lon":-99.1332}.');

export const paradasCercanasInputShape = {
  lugar: placeInputSchema,
  user_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Id del usuario. OBLIGATORIO si "lugar" es un nombre guardado en vez de coordenadas.'),
  radio_m: z
    .number()
    .positive()
    .max(2000)
    .optional()
    .describe("Radio de búsqueda en metros, línea recta. Default 400m, tope 2000m."),
  limite: z.number().int().positive().max(50).optional().describe("Máximo de paradas a devolver. Default 10."),
};

const paradasCercanasInputSchema = z.object(paradasCercanasInputShape);

interface StopsNearData {
  stops: Array<{
    stop_id: string;
    name: string;
    lat: number;
    lon: number;
    distance_m: number;
    wheelchair_boarding: number | null;
  }>;
}

export function registerParadasCercanas(server: McpServer): void {
  server.registerTool(
    "paradas_cercanas",
    {
      title: "Paradas de transporte cercanas",
      description:
        'Usa esta herramienta cuando el usuario pregunte qué paradas de transporte tiene cerca -- ej. "¿qué ' +
        'estación de Metro me queda más cerca de casa?", "paradas de camión a 5 cuadras de aquí", "estoy en ' +
        'Reforma 222, ¿hay Metrobús cerca?". Busca en línea recta (no caminando por calles) sobre las paradas ' +
        "reales de Metro/Metrobús/RTP/etc. del GTFS cargado. NO es para estaciones de Ecobici (usa " +
        "estado_ecobici) -- esta herramienta solo conoce paradas de transporte con ruta fija (GTFS), no " +
        'estaciones de bici. "lugar" acepta un nombre guardado ("casa") o coordenadas -- si es un nombre ' +
        "ambiguo o no guardado, la herramienta devuelve candidatos o pide coordenadas en vez de adivinar.",
      inputSchema: paradasCercanasInputShape,
    },
    async (rawArgs) => {
      const args = paradasCercanasInputSchema.parse(rawArgs);
      const res = await resolvePlace(args.user_id, args.lugar as PlaceInput);
      if (res.kind !== "resolved") {
        return { content: [{ type: "text", text: describeUnresolved(res) }] };
      }

      const result = await apiClient.get<StopsNearData>("/v1/stops/near", {
        lat: res.coord.lat,
        lon: res.coord.lon,
        radius_m: args.radio_m,
        limit: args.limite,
      });

      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `No se pudieron buscar paradas: ${result.message} (${result.code}).` }],
        };
      }

      const refLabel = res.coord.label ? `"${res.coord.label}"` : `(${res.coord.lat.toFixed(4)}, ${res.coord.lon.toFixed(4)})`;
      const stops = result.data.stops;
      if (stops.length === 0) {
        return { content: [{ type: "text", text: `No hay paradas registradas cerca de ${refLabel} en ese radio.` }] };
      }

      const lines = stops.map((s, i) => {
        const accesible = s.wheelchair_boarding === 1 ? " (accesible en silla de ruedas)" : "";
        return `${i + 1}. ${s.name} -- ${formatDistance(s.distance_m)}${accesible}`;
      });

      return {
        content: [{ type: "text", text: `Paradas cerca de ${refLabel}:\n${lines.join("\n")}` }],
      };
    }
  );
}
