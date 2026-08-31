/**
 * Resolución de la ventana espacial (brief: "radio de 5 km alrededor de
 * origen y destino, reintento único a 8 km") y de las paradas de acceso a
 * pie desde el punto exacto de origen/destino.
 */
import type { Pool } from "pg";
import { getCandidateStops, getNearbyEcobiciStationIds } from "./graph-client.ts";
import { WINDOW, COST_DEFAULTS } from "./config.ts";
import { walkSecondsFromMeters } from "./cost.ts";
import type { CandidateStop, CostWeights, Label, LonLat } from "./types.ts";

export interface SearchUniverse {
  allowedStopIds: Set<string>;
  radiusMeters: number;
  originCandidates: CandidateStop[];
  destinationCandidates: CandidateStop[];
}

/**
 * Universo de paradas candidatas: unión de paradas dentro de `radiusMeters`
 * de origen y de destino. Ninguna expansión de Dijkstra/RAPTOR sale de este
 * conjunto — así es como se cumple la restricción dura de "nunca se amplía
 * el subgrafo sin límite para forzar una respuesta" (CLAUDE.md decisión #7).
 *
 * Agregado 2026-08-22: `allowedStopIds` también incluye las estaciones
 * Ecobici dentro del MISMO radio (`getNearbyEcobiciStationIds`) — antes de
 * este cambio, una estación Ecobici alcanzada por `walk` desde CUALQUIER
 * parada explorada quedaba admitida sin ninguna restricción espacial
 * (el chequeo de `allowedStopIds` en dijkstra.ts/raptor.ts solo aplicaba a
 * `to_node_type === 'gtfs_stop'`), lo que en zonas densas en Ecobici
 * diluía presupuesto real de expansión/tiempo en ramas lejanas del
 * corredor origen-destino y rompía el presupuesto de latencia medido bajo
 * carga concurrente — ver docs/handoff/03-algoritmo.md, sección nueva.
 * dijkstra.ts/raptor.ts ahora aplican `allowedStopIds` a AMBOS tipos de
 * nodo por igual.
 */
export async function resolveSearchUniverse(
  pool: Pool,
  origin: LonLat,
  destination: LonLat,
  radiusMeters: number
): Promise<SearchUniverse> {
  const [originCandidates, destinationCandidates, originEcobiciIds, destinationEcobiciIds] = await Promise.all([
    getCandidateStops(pool, origin, radiusMeters),
    getCandidateStops(pool, destination, radiusMeters),
    getNearbyEcobiciStationIds(pool, origin, radiusMeters),
    getNearbyEcobiciStationIds(pool, destination, radiusMeters),
  ]);
  const allowedStopIds = new Set<string>();
  for (const c of originCandidates) allowedStopIds.add(c.stopId);
  for (const c of destinationCandidates) allowedStopIds.add(c.stopId);
  for (const id of originEcobiciIds) allowedStopIds.add(id);
  for (const id of destinationEcobiciIds) allowedStopIds.add(id);
  return { allowedStopIds, radiusMeters, originCandidates, destinationCandidates };
}

/**
 * Agregado 2026-08-30 (ver docs/handoff/03-algoritmo.md sección 12,
 * candidato (c) de docs/handoff/08-qa.md sección 1.2). Filtro de corredor:
 * en vez de aceptar TODA parada dentro de las dos burbujas de radio fijo
 * (origen y destino, unión ya calculada por `resolveSearchUniverse`), se
 * descarta cualquiera cuyo "desvío" real (distancia recta a origen +
 * distancia recta a destino) supere `ellipseFactor` veces la distancia
 * recta origen-destino — una elipse con origen/destino como focos. Pura
 * (no consulta Postgres) — reusa las coordenadas que `resolveSearchUniverse`
 * ya trajo en `originCandidates`/`destinationCandidates`.
 *
 * Estaciones Ecobici (u otro `stopId` sin coordenadas conocidas aquí, ver
 * `resolveSearchUniverse`) NUNCA se excluyen por este filtro: filtrarlas
 * sin saber su posición real arriesgaría perder cobertura de bici sin
 * ninguna ganancia medible de rendimiento (ya son un subconjunto acotado
 * por `MAX_BIKE_EDGES_PER_EXPANSION`/`MAX_WALK_TO_ECOBICI_EDGES_PER_EXPANSION`,
 * nunca la fuente real del problema de fan-out que motiva este filtro).
 *
 * Ver `WINDOW.CORRIDOR_ELLIPSE_FACTOR` (config.ts) para la calibración real
 * de qué valor de `ellipseFactor` preserva la ruta óptima conocida.
 */
export function applyCorridorFilter(
  universe: SearchUniverse,
  origin: LonLat,
  destination: LonLat,
  ellipseFactor: number
): Set<string> {
  const odMeters = haversineMeters(origin, destination);
  const maxDetourMeters = ellipseFactor * odMeters;
  const knownCoords = new Map<string, LonLat>();
  for (const c of [...universe.originCandidates, ...universe.destinationCandidates]) {
    knownCoords.set(c.stopId, { lon: c.lon, lat: c.lat });
  }
  const filtered = new Set<string>();
  for (const stopId of universe.allowedStopIds) {
    const coords = knownCoords.get(stopId);
    if (!coords) {
      filtered.add(stopId); // sin coordenadas conocidas -- no se excluye, ver comentario arriba.
      continue;
    }
    const detourMeters = haversineMeters(coords, origin) + haversineMeters(coords, destination);
    if (detourMeters <= maxDetourMeters) filtered.add(stopId);
  }
  return filtered;
}

/**
 * Paradas de ACCESO a pie desde el punto exacto (origen o destino). Radio
 * deliberadamente más chico que el de búsqueda (WINDOW.ACCESS_WALK_RADIUS_METERS)
 * — ver justificación en config.ts.
 */
export async function resolveAccessStops(pool: Pool, point: LonLat): Promise<CandidateStop[]> {
  const stops = await getCandidateStops(pool, point, WINDOW.ACCESS_WALK_RADIUS_METERS);
  // Ya vienen ordenadas ascendente por distancia (ver getCandidateStops) — tomar solo las N más cercanas.
  return stops.slice(0, WINDOW.MAX_ACCESS_STOPS);
}

/**
 * Distancia de caminata estimada, ajustada por el mismo factor de
 * circuidad (línea recta x 1.3) que usa `walk_edges` (ver
 * docs/handoff/02-grafo.md sección 3.3) — consistencia deliberada: la
 * distancia que devuelve `getCandidateStops` es geodésica en línea recta
 * "cruda" (ST_Distance sobre geography), igual que la distancia que
 * `modelo-grafo` ajustó con el mismo factor antes de guardarla en
 * `walk_edges`.
 */
export function estimateWalkSecs(straightLineMeters: number, walkingSpeedMps: number): number {
  const adjustedMeters = straightLineMeters * COST_DEFAULTS.walkCircuityFactor;
  return Math.round(walkSecondsFromMeters(adjustedMeters, walkingSpeedMps));
}

/**
 * Distancia geodésica en línea recta (fórmula de Haversine), en metros.
 * Pura, sin Postgres — se usa como heurística de "qué tan cerca del
 * destino" para dirigir la búsqueda (ver `goalBiasFn` en index.ts), NO como
 * fuente de verdad de distancia de caminata (esa sigue viniendo de
 * `walk_edges`/`ST_Distance` real, ver graph-client.ts).
 */
export function haversineMeters(a: LonLat, b: LonLat): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Labels iniciales de origen: uno por parada de acceso, con la caminata de acceso ya sumada. */
export function buildOriginLabels(accessStops: CandidateStop[], departSecs: number, weights: CostWeights): Label[] {
  return accessStops.map((stop) => {
    const walkSecs = estimateWalkSecs(stop.distanceMeters, weights.walkingSpeedMps);
    const label: Label = {
      stopId: stop.stopId,
      // Los orígenes SIEMPRE se siembran desde una parada GTFS cercana
      // (getCandidateStops solo consulta `stops`, nunca `ecobici_stations`
      // — ver graph-client.ts). Sembrar un origen directamente en una
      // estación Ecobici (si el punto de partida real del usuario está más
      // cerca de una que de cualquier parada) NO se implementó en este
      // entregable — ver limitación nueva en docs/handoff/03-algoritmo.md.
      nodeType: "gtfs_stop",
      arrivalSecs: departSecs + walkSecs,
      transfers: 0,
      walkSecs,
      costPesos: 0,
      lastTripId: null,
      parent: null,
      viaEdge: null,
    };
    return label;
  });
}
