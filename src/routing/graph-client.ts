/**
 * Capa de acceso a Postgres. Único punto de contacto con el grafo (nunca se
 * mantiene residente en memoria entre invocaciones — CLAUDE.md decisión #7,
 * restricción dura del brief de este agente). Cada función abre una query,
 * la resuelve, y devuelve datos planos; quien la llama decide qué hacer con
 * ellos en memoria durante ESA invocación.
 *
 * Contrato de `graph_stop_neighbors` documentado en
 * docs/handoff/02-grafo.md secciones 3.5 y 8 — no se reinterpreta aquí.
 *
 * Agregado 2026-08-22 (ver docs/handoff/03-algoritmo.md, sección nueva):
 * `graph_bike_station_neighbors` (docs/handoff/02-grafo.md sección 9.5) +
 * `ecobici_snapshots` para disponibilidad real en tiempo de consulta.
 */
import type { Pool } from "pg";
import { WINDOW } from "./config.ts";
import { filterBikeAvailability, limitBikeFanout } from "./relax.ts";
import type {
  CandidateStop,
  EcobiciAvailability,
  LonLat,
  NeighborFetcher,
  NodeType,
  StopNeighborRow,
} from "./types.ts";

/**
 * Vecinos de una parada dentro de la ventana pedida. Delgado a propósito:
 * un solo `SELECT * FROM graph_stop_neighbors($1,$2,$3,$4)`, sin lógica de
 * negocio aquí — eso vive en dijkstra.ts/raptor.ts.
 */
export async function getStopNeighbors(
  pool: Pool,
  stopId: string,
  serviceDate: string,
  fromSecs: number,
  windowSecs: number
): Promise<StopNeighborRow[]> {
  const { rows } = await pool.query<StopNeighborRow>(
    `SELECT * FROM graph_stop_neighbors($1, $2, $3, $4)`,
    [stopId, serviceDate, fromSecs, windowSecs]
  );
  return rows;
}

/**
 * Paradas GTFS dentro de `radiusMeters` de un punto, ordenadas por
 * distancia. Usa el índice GIST de `stops.geom` (ver docs/handoff/02-grafo.md
 * sección 6) vía ST_DWithin sobre geography — igual mecanismo que usó
 * `modelo-grafo` para precalcular walk_edges.
 */
export async function getCandidateStops(
  pool: Pool,
  point: LonLat,
  radiusMeters: number
): Promise<CandidateStop[]> {
  const { rows } = await pool.query<{
    stop_id: string;
    stop_name: string;
    stop_lat: number;
    stop_lon: number;
    distance_meters: number;
  }>(
    `SELECT stop_id, stop_name, stop_lat, stop_lon,
            ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_meters
     FROM stops
     WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
     ORDER BY distance_meters ASC`,
    [point.lon, point.lat, radiusMeters]
  );
  return rows.map((r) => ({
    stopId: r.stop_id,
    stopName: r.stop_name,
    lat: r.stop_lat,
    lon: r.stop_lon,
    distanceMeters: r.distance_meters,
  }));
}

/**
 * Fila cruda tal como la devuelve `SELECT * FROM
 * graph_bike_station_neighbors(...)` (docs/handoff/02-grafo.md sección
 * 9.5, agregado 2026-08-22). Columnas propias, distintas de
 * `graph_stop_neighbors`: no hay trip_id/route_id/depart_secs/arrive_secs
 * porque ninguna arista que sale de una estación Ecobici depende de
 * horario (bike/walk son estáticas).
 */
interface RawBikeStationNeighborRow {
  edge_type: "bike" | "walk";
  to_node_type: NodeType;
  to_node_id: string;
  distance_meters: number;
  duration_secs: number | null;
}

/**
 * Vecinos crudos de una estación Ecobici: un solo `SELECT * FROM
 * graph_bike_station_neighbors($1)`, sin lógica de negocio aquí (mismo
 * principio que getStopNeighbors) — la normalización a `StopNeighborRow`,
 * el tope de fan-out y el filtro de disponibilidad viven en
 * makeNeighborFetcher, más abajo.
 */
export async function getBikeStationNeighbors(pool: Pool, stationId: string): Promise<RawBikeStationNeighborRow[]> {
  const { rows } = await pool.query<RawBikeStationNeighborRow>(
    `SELECT * FROM graph_bike_station_neighbors($1)`,
    [stationId]
  );
  return rows;
}

/**
 * Disponibilidad real de un lote de estaciones Ecobici, leyendo SOLO la
 * fila más reciente por estación (`DISTINCT ON`) y descartando snapshots
 * más viejos que `maxAgeSecs` (ver config.ts#ECOBICI_AVAILABILITY_MAX_AGE_SECS
 * para la justificación del umbral). Fallar cerrado: una estación sin fila
 * en el resultado (sin snapshot, o snapshot caduco) simplemente no aparece
 * en el Map devuelto — quien consuma esto (filterBikeAvailability) trata
 * "sin entrada" como "sin disponibilidad", nunca como "no importa".
 *
 * Una sola query por lote (todas las estaciones candidatas de una
 * expansión, no una query por estación) — el mismo principio de
 * `dedupeRideEdges`/`limitWalkFanout`: minimizar consultas reales por
 * expansión de nodo, que es lo que cuenta contra el presupuesto de latencia.
 */
export async function getEcobiciAvailability(
  pool: Pool,
  stationIds: string[],
  maxAgeSecs: number
): Promise<Map<string, EcobiciAvailability>> {
  const map = new Map<string, EcobiciAvailability>();
  if (stationIds.length === 0) return map;

  const { rows } = await pool.query<{
    station_id: string;
    num_bikes_available: number | null;
    num_docks_available: number | null;
    captured_at: Date;
  }>(
    `SELECT DISTINCT ON (station_id) station_id, num_bikes_available, num_docks_available, captured_at
     FROM ecobici_snapshots
     WHERE station_id = ANY($1)
       AND captured_at >= now() - make_interval(secs => $2)
     ORDER BY station_id, captured_at DESC`,
    [stationIds, maxAgeSecs]
  );

  for (const row of rows) {
    // num_bikes_available/num_docks_available son NULLABLE en el esquema
    // de ecobici_snapshots (migrations/0005_ecobici.sql) — un snapshot con
    // el campo en NULL es un dato incompleto, se trata igual que "sin
    // snapshot utilizable" (fallar cerrado), no se asume 0 ni se asume
    // disponible.
    if (row.num_bikes_available === null || row.num_docks_available === null) continue;
    map.set(row.station_id, {
      numBikesAvailable: row.num_bikes_available,
      numDocksAvailable: row.num_docks_available,
      capturedAt: row.captured_at,
    });
  }
  return map;
}

/**
 * Coordenadas de TODAS las estaciones Ecobici (677 filas — barato, se
 * consulta una vez por intento de planRoute, no por expansión de nodo).
 * Alimenta el mismo `goalBiasFn` (heurística de orientación tipo A*, ver
 * config.ts#HEURISTIC_SPEED_MPS) que ya usaban solo las paradas GTFS del
 * universo de búsqueda — sin esto, cualquier label en una estación Ecobici
 * quedaba sin heurística de orientación (siempre 0), lo que dejaba a la
 * poda por MAX_LABELS_PER_STOP/MAX_FRONTIER_SIZE sin ninguna noción de
 * "hacia dónde pedalear" — ver docs/handoff/03-algoritmo.md.
 */
export async function getEcobiciStationCoords(pool: Pool): Promise<Map<string, { lat: number; lon: number }>> {
  const { rows } = await pool.query<{ station_id: string; lat: number; lon: number }>(
    `SELECT station_id, lat, lon FROM ecobici_stations WHERE lat IS NOT NULL AND lon IS NOT NULL`
  );
  const map = new Map<string, { lat: number; lon: number }>();
  for (const row of rows) map.set(row.station_id, { lat: row.lat, lon: row.lon });
  return map;
}

function normalizeBikeStationRows(raw: RawBikeStationNeighborRow[]): StopNeighborRow[] {
  return raw.map((r) => ({
    edge_type: r.edge_type,
    to_node_type: r.to_node_type,
    to_node_id: r.to_node_id,
    trip_id: null,
    route_id: null,
    depart_secs: null,
    arrive_secs: null,
    distance_meters: r.distance_meters,
    duration_secs: r.duration_secs,
  }));
}

/**
 * Estaciones Ecobici dentro de `radiusMeters` de un punto (agregado
 * 2026-08-22). Usada por `window.ts#resolveSearchUniverse` para acotar
 * espacialmente qué estaciones Ecobici son admisibles como nodo del grafo
 * — MISMO radio y MISMO principio que ya aplica `getCandidateStops` a
 * paradas GTFS (CLAUDE.md decisión #7: "nunca se amplía el subgrafo sin
 * límite"). Sin esto, medido contra Postgres real (ver
 * docs/handoff/03-algoritmo.md, sección nueva): dijkstra.ts/raptor.ts
 * admitían CUALQUIER estación Ecobici alcanzable por `walk_edges` desde
 * CUALQUIER parada explorada, sin importar qué tan lejos quedara del
 * corredor origen-destino — en una zona tan densa en Ecobici como el
 * centro de CDMX, eso diluía una fracción real del presupuesto de
 * expansión/tiempo en ramas irrelevantes y rompía el presupuesto de
 * latencia bajo carga (ver handoff). Acotar por radio, igual que ya se
 * acota todo lo demás, lo corrigió.
 */
export async function getNearbyEcobiciStationIds(pool: Pool, point: LonLat, radiusMeters: number): Promise<Set<string>> {
  const { rows } = await pool.query<{ station_id: string }>(
    `SELECT station_id FROM ecobici_stations
     WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)`,
    [point.lon, point.lat, radiusMeters]
  );
  return new Set(rows.map((r) => r.station_id));
}

/**
 * Cierra sobre un Pool + fecha de servicio fija para producir un
 * `NeighborFetcher` que dijkstra.ts/raptor.ts pueden consumir sin conocer
 * `pg` ni la fecha — la fecha es un parámetro del plan completo, no de cada
 * expansión de nodo. También cuenta cuántas queries reales se hicieron (útil
 * para las mediciones de latencia del handoff).
 *
 * Agregado 2026-08-22: despacha por `nodeType`. Para `"gtfs_stop"`, sin
 * cambios (1 query, `graph_stop_neighbors`). Para `"ecobici_station"`:
 * 1. `getBikeStationNeighbors` (1 query) — vecinos crudos.
 * 2. `limitBikeFanout` (sin Postgres) — tope de fan-out ANTES de decidir
 *    qué estaciones consultar en ecobici_snapshots (ver
 *    config.ts#MAX_BIKE_EDGES_PER_EXPANSION): evita que una estación con
 *    545 aristas salientes dispare un batch de 545 station_ids en la
 *    query de disponibilidad.
 * 3. Si NINGUNA arista sobrevivió con `edge_type === 'bike'` (la estación
 *    solo tenía `walk`, o ninguna arista bike pasó el tope), se devuelve
 *    directo SIN pagar la consulta de disponibilidad — las aristas `walk`
 *    no la necesitan (ver filterBikeAvailability). Esto es real: no toda
 *    expansión de una estación Ecobici paga las 2 queries, solo las que de
 *    verdad tienen candidatos `bike`.
 * 4. `getEcobiciAvailability` (1 query, batched: origen + todos los
 *    destinos candidatos en una sola consulta) + `filterBikeAvailability`
 *    (sin Postgres) — disponibilidad real en el momento de ESTA consulta,
 *    nunca precalculada (ver docs/handoff/02-grafo.md sección 2).
 *
 * Costo real: 1 query por expansión de parada GTFS (sin cambio), 1 o 2
 * queries por expansión de estación Ecobici (2 solo si hay candidatos
 * bike) — documentado y remedido contra el presupuesto de latencia en
 * docs/handoff/03-algoritmo.md.
 */
export function makeNeighborFetcher(
  pool: Pool,
  serviceDate: string,
  onQuery?: () => void
): NeighborFetcher {
  return async (nodeId, nodeType, fromSecs, windowSecs) => {
    if (nodeType === "gtfs_stop") {
      onQuery?.();
      return getStopNeighbors(pool, nodeId, serviceDate, fromSecs, windowSecs);
    }

    // nodeType === "ecobici_station". fromSecs/windowSecs se ignoran a
    // propósito (ver comentario de NeighborFetcher en types.ts).
    onQuery?.();
    const raw = await getBikeStationNeighbors(pool, nodeId);
    const capped = limitBikeFanout(normalizeBikeStationRows(raw), WINDOW.MAX_BIKE_EDGES_PER_EXPANSION);

    const bikeCandidates = capped.filter((r) => r.edge_type === "bike");
    if (bikeCandidates.length === 0) return capped;

    const candidateStationIds = [nodeId, ...bikeCandidates.map((r) => r.to_node_id)];
    onQuery?.();
    const availability = await getEcobiciAvailability(pool, candidateStationIds, WINDOW.ECOBICI_AVAILABILITY_MAX_AGE_SECS);

    return filterBikeAvailability(capped, nodeId, availability, {
      minBikesAvailable: WINDOW.MIN_BIKES_AVAILABLE,
      minDocksAvailable: WINDOW.MIN_DOCKS_AVAILABLE,
    });
  };
}
