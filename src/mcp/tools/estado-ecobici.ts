/**
 * `estado_ecobici` -- disponibilidad de bicis/espacios en una estación de
 * Ecobici. SIN equivalente HTTP hoy: `src/api/routes/` no tiene ningún
 * endpoint de Ecobici (ver docs/handoff/06-mcp.md, sección "Decisiones",
 * para el porqué de consultar Postgres directo en vez de agregar un
 * endpoint a `src/api/`, fuera del alcance de este agente).
 *
 * Importante: Ecobici NO participa del cálculo de `calcular_ruta` (el
 * grafo de `algoritmo-ruteo` no expande vecinos desde una estación
 * Ecobici -- docs/handoff/03-algoritmo.md sección 8, punto 1). Esta
 * herramienta es standalone: consulta disponibilidad, no arma un tramo
 * de ruta.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMcpPgPool } from "../db.js";
import { resolvePlace, describeUnresolved, type PlaceInput } from "../places.js";
import { formatDistance, formatRelativeTime } from "../format.js";

const placeInputSchema = z.union([
  z.string().min(1),
  z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
]);

export const estadoEcobiciInputShape = {
  estacion: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Nombre (o parte del nombre) o id de una estación Ecobici, ej. "Glorieta de la Lealtad" o "CE-407". ' +
        "Manda esto O lugar, no ambos hace falta -- si mandas los dos, se prioriza estacion."
    ),
  lugar: placeInputSchema
    .optional()
    .describe(
      'Punto de referencia para buscar la estación Ecobici MÁS CERCANA -- nombre guardado ("casa"), ' +
        'coordenadas como texto ("19.4326,-99.1332"), o {"lat":...,"lon":...}. Úsalo cuando el usuario no diga ' +
        'el nombre de una estación específica, ej. "¿hay bicis cerca de la oficina?".'
    ),
  user_id: z.string().min(1).max(128).optional().describe('Necesario si "lugar" es un nombre guardado.'),
  limite: z
    .number()
    .int()
    .positive()
    .max(10)
    .optional()
    .describe("Cuántas estaciones cercanas devolver cuando se busca por lugar. Default 3."),
};

const estadoEcobiciInputSchema = z.object(estadoEcobiciInputShape);

interface StationRow {
  station_id: string;
  name: string | null;
  lat: number;
  lon: number;
  capacity: number | null;
  distance_m?: number;
}

interface SnapshotRow {
  station_id: string;
  num_bikes_available: number | null;
  num_docks_available: number | null;
  is_renting: boolean | null;
  is_returning: boolean | null;
  captured_at: Date | null;
}

async function latestSnapshots(stationIds: string[]): Promise<Map<string, SnapshotRow>> {
  if (stationIds.length === 0) return new Map();
  const pool = getMcpPgPool();
  const rows = (
    await pool.query<SnapshotRow>(
      `SELECT DISTINCT ON (station_id) station_id, num_bikes_available, num_docks_available,
              is_renting, is_returning, captured_at
       FROM ecobici_snapshots
       WHERE station_id = ANY($1)
       ORDER BY station_id, captured_at DESC`,
      [stationIds]
    )
  ).rows;
  return new Map(rows.map((r) => [r.station_id, r]));
}

function renderStation(station: StationRow, snap: SnapshotRow | undefined, index?: number): string {
  const prefix = index !== undefined ? `${index}. ` : "";
  const dist = station.distance_m !== undefined ? ` (${formatDistance(station.distance_m)})` : "";
  if (!snap || snap.captured_at === null) {
    return `${prefix}${station.name ?? station.station_id}${dist}: sin datos de disponibilidad recientes.`;
  }
  const bikes = snap.num_bikes_available ?? "?";
  const docks = snap.num_docks_available ?? "?";
  const estado: string[] = [];
  if (snap.is_renting === false) estado.push("NO está prestando bicis ahora");
  if (snap.is_returning === false) estado.push("NO está aceptando devoluciones ahora");
  const estadoTxt = estado.length > 0 ? ` -- ${estado.join(", ")}` : "";
  return (
    `${prefix}${station.name ?? station.station_id}${dist}: ${bikes} bicis disponibles, ${docks} espacios libres` +
    `${estadoTxt} (actualizado ${formatRelativeTime(new Date(snap.captured_at))}).`
  );
}

export function registerEstadoEcobici(server: McpServer): void {
  server.registerTool(
    "estado_ecobici",
    {
      title: "Disponibilidad de Ecobici",
      description:
        'Usa esta herramienta cuando el usuario pregunte por disponibilidad de bicis o espacios de Ecobici -- ' +
        'ej. "¿hay bicis en la estación de la Glorieta de la Lealtad?", "¿tengo dónde dejar la bici cerca de ' +
        'ESCOM?", "busco una estación con bicis cerca de casa". Consulta el snapshot MÁS RECIENTE cargado (job ' +
        "de GitHub Actions cada 5 min contra el feed GBFS real) -- si el snapshot tiene más de unos minutos, la " +
        "respuesta lo dice explícito para que no se presente como dato en vivo. LIMITACIÓN IMPORTANTE: Ecobici " +
        "NO está integrado al cálculo de calcular_ruta (el motor de ruteo no arma tramos en bici todavía) -- " +
        "esta herramienta solo informa disponibilidad puntual, nunca la mezcles con una ruta calculada.",
      inputSchema: estadoEcobiciInputShape,
    },
    async (rawArgs) => {
      const args = estadoEcobiciInputSchema.parse(rawArgs);
      if (!args.estacion && !args.lugar) {
        return {
          isError: true,
          content: [{ type: "text", text: "Manda 'estacion' (nombre o id) o 'lugar' (para buscar la más cercana)." }],
        };
      }

      const pool = getMcpPgPool();

      if (args.estacion) {
        const q = args.estacion.trim();
        const byId = await pool.query<StationRow>(
          `SELECT station_id, name, lat, lon, capacity FROM ecobici_stations WHERE station_id = $1`,
          [q]
        );
        const matches =
          byId.rows.length === 1
            ? byId.rows
            : (
                await pool.query<StationRow>(
                  `SELECT station_id, name, lat, lon, capacity FROM ecobici_stations WHERE name ILIKE $1 ORDER BY name LIMIT 10`,
                  [`%${q}%`]
                )
              ).rows;

        if (matches.length === 0) {
          return { content: [{ type: "text", text: `No encontré ninguna estación Ecobici que coincida con "${q}".` }] };
        }
        if (matches.length > 1) {
          const opciones = matches.map((m) => `"${m.name}" (id ${m.station_id})`).join(", ");
          return {
            content: [
              { type: "text", text: `"${q}" coincide con varias estaciones: ${opciones}. Pregunta cuál es.` },
            ],
          };
        }

        const station = matches[0]!;
        const snaps = await latestSnapshots([station.station_id]);
        return { content: [{ type: "text", text: renderStation(station, snaps.get(station.station_id)) }] };
      }

      // Búsqueda por lugar: estaciones más cercanas.
      const res = await resolvePlace(args.user_id, args.lugar as PlaceInput);
      if (res.kind !== "resolved") {
        return { content: [{ type: "text", text: describeUnresolved(res) }] };
      }
      const limite = args.limite ?? 3;
      const nearby = await pool.query<StationRow>(
        `SELECT station_id, name, lat, lon, capacity,
                ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS distance_m
         FROM ecobici_stations
         WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, 1500)
         ORDER BY distance_m ASC
         LIMIT $3`,
        [res.coord.lon, res.coord.lat, limite]
      );

      if (nearby.rows.length === 0) {
        return { content: [{ type: "text", text: "No hay estaciones Ecobici registradas a menos de 1.5km de ese punto." }] };
      }

      const snaps = await latestSnapshots(nearby.rows.map((r) => r.station_id));
      const refLabel = res.coord.label ? `"${res.coord.label}"` : `(${res.coord.lat.toFixed(4)}, ${res.coord.lon.toFixed(4)})`;
      const lines = nearby.rows.map((s, i) => renderStation(s, snaps.get(s.station_id), i + 1));
      return { content: [{ type: "text", text: `Estaciones Ecobici cerca de ${refLabel}:\n${lines.join("\n")}` }] };
    }
  );
}
