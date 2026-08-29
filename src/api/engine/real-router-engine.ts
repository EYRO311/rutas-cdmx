import type { Pool } from "pg";
import { planRoute, type Engine, type Itinerary, type ItineraryLeg, type NodeType, type PlanRequest, type PlanResult } from "../../routing/index.js";
import { getPgPool } from "../db/prisma.js";
import { cdmxServiceDateAndSecsToDate, dateToCdmxServiceDateAndSecs } from "../lib/cdmx-time.js";
import type { Mode } from "../schemas/common.js";
import type {
  EngineComputeResult,
  EngineCoordinate,
  EngineRouteLeg,
  EngineRouteOption,
  EngineStopRef,
  RouteQuery,
  RouterEngine,
} from "./router-engine.js";

/**
 * Adapter real: envuelve `planRoute` de `algoritmo-ruteo`
 * (src/routing/index.ts, contrato en docs/handoff/03-algoritmo.md sección
 * 9) detrás de la interfaz `RouterEngine`. Reemplaza a `StubRouterEngine`
 * desde `src/api/engine/index.ts` -- ver ese archivo.
 *
 * Decisiones de mapeo tomadas aquí, documentadas explícitamente (no
 * inventadas ni ocultas -- ver docs/handoff/05-api.md sección de esta
 * fase para la versión larga):
 *
 * 1. `RouteQuery.departureAt` (Date) -> `PlanRequest.serviceDate` +
 *    `departSecs`: se convierte a hora LOCAL de Ciudad de México
 *    (`src/api/lib/cdmx-time.ts`), porque `calendar`/`graph_stop_neighbors`
 *    están en huso horario de CDMX, no UTC.
 * 2. `Itinerary` (algoritmo-ruteo) no trae `confidence` ni costo/hora POR
 *    TRAMO -- solo a nivel itinerario completo (`costPesos`,
 *    `durationSecs`). Se reconstruyen aquí:
 *    - `costMxn` por tramo: `algoritmo-ruteo` solo cobra una tarifa plana
 *      (`flatFarePesosPerBoarding`) por CADA abordaje nuevo (mismo criterio
 *      que `relaxEdge` en src/routing/relax.ts: un tramo `ride` es
 *      "abordaje nuevo" si su `tripId` es distinto del último tramo `ride`
 *      visto). El total de la tarifa por abordaje se deriva dividiendo
 *      `itinerary.costPesos` entre el número de abordajes -- exacto, no
 *      una estimación, porque el costo del itinerario NO tiene ningún otro
 *      componente monetario (verificado leyendo relax.ts/itinerary.ts).
 *    - `confidence` por tramo: heurística explícita por modo, no un dato
 *      que el motor exponga (no hay señal de tiempo real integrada al
 *      motor de ruteo -- ver limitaciones de docs/handoff/03-algoritmo.md).
 *      Caminata/transbordo = 0.9 (geometría estática, confiable). Metro =
 *      0.55 (docs/handoff/01-datos.md documenta la sospecha, no verificada
 *      con feed_info.txt, de que el GTFS del Metro es de 2022). Otras
 *      agencias = 0.65. `transit` (agencia no identificable, ver
 *      AGENCY_TO_MODE) = 0.5. `summary.confidence` = el mínimo de sus
 *      tramos (la ruta completa no puede ser más confiable que su tramo
 *      más débil).
 * 3. `summary.distance_m` siempre `null`: `Itinerary` no expone una
 *    distancia total agregada confiable (`ItineraryLeg.distanceMeters` es
 *    `null` en casi todos los tramos -- ver itinerary.ts, solo el tramo
 *    final de caminata la trae) -- se documenta como `null` en vez de
 *    fabricar una estimación.
 * 4. `RouteQuery.allowedModes`: `PlanRequest` no tiene ningún parámetro de
 *    filtrado por modo (algoritmo-ruteo explora TODOS los modos
 *    disponibles en el grafo). Se filtra DESPUÉS de recibir los
 *    itinerarios: un itinerario se descarta si alguno de sus tramos `ride`
 *    tiene un modo fuera de `allowedModes`. Los tramos `walk`/`transfer`
 *    NUNCA se filtran -- son tejido conectivo estructural, no un modo de
 *    transporte que el usuario elige, y excluirlos haría imposible
 *    devolver cualquier itinerario real (casi todos empiezan/terminan
 *    caminando). Limitación real de este enfoque: si la única forma de
 *    llegar es un itinerario mixto (ej. requiere Metrobús aunque el
 *    cliente solo pidió "metro"), se descarta por completo en vez de
 *    ofrecer una alternativa -- el motor no busca "solo con esos modos
 *    permitidos" a nivel de grafo, filtra después.
 * 5. `RouteQuery.maxResults`: trunca la lista ya filtrada (slice), después
 *    del filtro de `allowedModes`, preservando el orden ascendente por
 *    costo escalarizado que ya trae `PlanResult.itineraries`.
 * 6. `arrival_at` ("llegar antes de X"): `PlanRequest` NO tiene ningún
 *    parámetro equivalente -- no se inventa aquí. `src/api/routes/routes.ts`
 *    es quien agrega un warning explícito en la respuesta cuando
 *    `query.isArriveBy` es true, para no ocultarlo (aplica igual al stub).
 * 7. Estaciones Ecobici como `stopId` de un tramo (agregado 2026-08-28,
 *    corrige un 503 real: `algoritmo-ruteo` ya puede devolver un tramo
 *    `walk` o `bike` cuyo `fromStopId`/`toStopId` es una estación Ecobici,
 *    no una parada GTFS -- este adapter nunca se actualizó cuando eso pasó
 *    en `src/routing/`, así que `resolveStopRef` tronaba buscando la
 *    estación en `stops`). Se resuelve por `fromNodeType`/`toNodeType`
 *    (`"gtfs_stop" | "ecobici_station"`, en `ItineraryLeg` desde
 *    2026-08-22) en vez de adivinar por la forma del id -- ver
 *    `lookupEcobiciStations` y `resolveStopRef`. Un tramo `bike` se mapea a
 *    `Mode` `"ecobici"` (ya existía en `KNOWN_MODES`, sin usarse hasta
 *    ahora) en `resolveLegMode`, en vez de caer en el default `"walk"`.
 */

const AGENCY_TO_MODE: Record<string, Mode> = {
  METRO: "metro",
  MB: "metrobus",
  RTP: "rtp",
  CC: "cc",
  TROLE: "trole",
  CBB: "cablebus",
  PUMABUS: "pumabus",
  TL: "tren_ligero",
  SUB: "suburbano",
  INTERURBANO: "interurbano",
};

/** Ver AGENCY_TO_MODE: fallback explícito para agency_id sucio (ej. 'SEMOVI', ver docs/handoff/01-datos.md) o route_id no encontrado. */
const FALLBACK_MODE: Mode = "transit";

function confidenceForMode(mode: Mode): number {
  if (mode === "walk" || mode === "transfer") return 0.9;
  if (mode === "metro") return 0.55;
  if (mode === "transit") return 0.5;
  return 0.65;
}

interface StopInfo {
  name: string;
  lat: number;
  lon: number;
}

async function lookupStops(pool: Pool, stopIds: string[]): Promise<Map<string, StopInfo>> {
  const map = new Map<string, StopInfo>();
  if (stopIds.length === 0) return map;
  const { rows } = await pool.query<{ stop_id: string; stop_name: string; stop_lat: number; stop_lon: number }>(
    `SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops WHERE stop_id = ANY($1);`,
    [stopIds]
  );
  for (const r of rows) {
    map.set(r.stop_id, { name: r.stop_name, lat: r.stop_lat, lon: r.stop_lon });
  }
  return map;
}

/** Análogo a lookupStops, pero contra `ecobici_stations` -- ver punto 7 del comentario de módulo. `name` es NULLABLE en esa tabla (migrations/0005_ecobici.sql), a diferencia de `stops.stop_name`; se cubre con un fallback explícito en vez de propagar null a un campo que StopInfo declara string. */
async function lookupEcobiciStations(pool: Pool, stationIds: string[]): Promise<Map<string, StopInfo>> {
  const map = new Map<string, StopInfo>();
  if (stationIds.length === 0) return map;
  const { rows } = await pool.query<{ station_id: string; name: string | null; lat: number; lon: number }>(
    `SELECT station_id, name, lat, lon FROM ecobici_stations WHERE station_id = ANY($1);`,
    [stationIds]
  );
  for (const r of rows) {
    map.set(r.station_id, { name: r.name ?? `Estación Ecobici ${r.station_id}`, lat: r.lat, lon: r.lon });
  }
  return map;
}

async function lookupRouteModes(pool: Pool, routeIds: string[]): Promise<Map<string, Mode>> {
  const map = new Map<string, Mode>();
  if (routeIds.length === 0) return map;
  const { rows } = await pool.query<{ route_id: string; agency_id: string | null }>(
    `SELECT route_id, agency_id FROM routes WHERE route_id = ANY($1);`,
    [routeIds]
  );
  for (const r of rows) {
    map.set(r.route_id, (r.agency_id && AGENCY_TO_MODE[r.agency_id]) || FALLBACK_MODE);
  }
  return map;
}

function resolveLegMode(leg: ItineraryLeg, modeByRouteId: Map<string, Mode>): Mode {
  if (leg.mode === "ride") {
    return (leg.routeId && modeByRouteId.get(leg.routeId)) || FALLBACK_MODE;
  }
  if (leg.mode === "transfer") return "transfer";
  if (leg.mode === "bike") return "ecobici";
  return "walk"; // "walk_access" | "walk"
}

function resolveStopRef(
  stopId: string | null,
  nodeType: NodeType | null,
  boundaryPoint: EngineCoordinate,
  stops: Map<string, StopInfo>,
  ecobiciStations: Map<string, StopInfo>
): EngineStopRef {
  if (stopId === null) {
    return { stopId: null, name: null, lat: boundaryPoint.lat, lon: boundaryPoint.lon };
  }
  // nodeType viene poblado siempre que stopId no es null (mismos tramos que
  // lo dejan null -- ver ItineraryLeg en src/routing/types.ts), así que no
  // hace falta un tercer caso para "no se sabe cuál tabla".
  const source = nodeType === "ecobici_station" ? ecobiciStations : stops;
  const sourceLabel = nodeType === "ecobici_station" ? "ecobici_stations" : "stops";
  const s = source.get(stopId);
  if (!s) {
    // No debería pasar: todo stopId no-null en un itinerario viene de
    // graph_stop_neighbors/graph_bike_station_neighbors, que solo
    // referencian paradas/estaciones reales. Si pasa, es una inconsistencia
    // de datos real -- se deja que reviente hacia arriba (routes.ts lo
    // convierte en 503 tipado, nunca un 500 crudo).
    throw new Error(`RealRouterEngine: nodo '${stopId}' referenciado por un itinerario pero no encontrado en '${sourceLabel}'.`);
  }
  return { stopId, name: s.name, lat: s.lat, lon: s.lon };
}

/** Índices (0-based) de los tramos `ride` que son "abordaje nuevo" -- mismo criterio que relaxEdge en src/routing/relax.ts. */
function findBoardingLegIndexes(legs: ItineraryLeg[]): number[] {
  const indexes: number[] = [];
  let lastTripId: string | null = null;
  legs.forEach((leg, i) => {
    if (leg.mode === "ride") {
      if (leg.tripId !== lastTripId) indexes.push(i);
      lastTripId = leg.tripId;
    }
  });
  return indexes;
}

function toEngineRouteOption(
  itinerary: Itinerary,
  index: number,
  query: RouteQuery,
  serviceDate: string,
  stops: Map<string, StopInfo>,
  ecobiciStations: Map<string, StopInfo>,
  modeByRouteId: Map<string, Mode>
): EngineRouteOption {
  const boardingIndexes = new Set(findBoardingLegIndexes(itinerary.legs));
  const perBoardingFare = boardingIndexes.size > 0 ? itinerary.costPesos / boardingIndexes.size : 0;

  let cursorSecs = itinerary.departSecs;
  const legs: EngineRouteLeg[] = itinerary.legs.map((leg, i) => {
    const effectiveDepartSecs = leg.departSecs ?? cursorSecs;
    if (leg.arriveSecs === null) {
      // No debería pasar: reconstructLegs/buildItinerary (src/routing/itinerary.ts)
      // siempre pueblan arriveSecs con un número real -- el tipo lo declara
      // nullable para generalidad, pero un itinerario sin arriveSecs es una
      // inconsistencia real del motor, no un caso degradado esperado.
      throw new Error(`RealRouterEngine: tramo #${i} sin arriveSecs -- inconsistencia real del itinerario.`);
    }
    const effectiveArriveSecs = leg.arriveSecs;
    cursorSecs = effectiveArriveSecs;

    const mode = resolveLegMode(leg, modeByRouteId);

    return {
      mode,
      durationS: Math.max(0, effectiveArriveSecs - effectiveDepartSecs),
      costMxn: boardingIndexes.has(i) ? perBoardingFare : 0,
      confidence: confidenceForMode(mode),
      from: resolveStopRef(leg.fromStopId, leg.fromNodeType, query.origin, stops, ecobiciStations),
      to: resolveStopRef(leg.toStopId, leg.toNodeType, query.destination, stops, ecobiciStations),
      routeId: leg.routeId,
      tripId: leg.tripId,
      departureAt: cdmxServiceDateAndSecsToDate(serviceDate, effectiveDepartSecs),
      arrivalAt: cdmxServiceDateAndSecsToDate(serviceDate, effectiveArriveSecs),
      polyline: null,
    };
  });

  const confidences = legs.map((l) => l.confidence);

  return {
    id: `real-${index}`,
    legs,
    summary: {
      durationS: itinerary.durationSecs,
      costMxn: itinerary.costPesos,
      confidence: confidences.length > 0 ? Math.min(...confidences) : 1,
      transfers: itinerary.transfers,
      // Ver punto 3 del comentario de módulo: no hay distancia agregada confiable en Itinerary.
      distanceM: null,
    },
  };
}

function matchesAllowedModes(option: EngineRouteOption, allowedModes: Mode[] | null): boolean {
  if (!allowedModes) return true;
  const allowed = new Set(allowedModes);
  return option.legs.every((leg) => leg.mode === "walk" || leg.mode === "transfer" || allowed.has(leg.mode));
}

export class RealRouterEngine implements RouterEngine {
  readonly name = "algoritmo-ruteo";
  readonly version = "1.0.0";
  readonly isStub = false;

  private readonly searchEngine: Engine;

  constructor(searchEngine: Engine = "dijkstra") {
    // Default 'dijkstra': la misma decisión de rendimiento que ya tomó
    // algoritmo-ruteo por defecto en planRoute() (medido, ver
    // docs/handoff/03-algoritmo.md sección 2.3) -- no la re-litigamos aquí.
    this.searchEngine = searchEngine;
  }

  async computeRoutes(query: RouteQuery): Promise<EngineComputeResult> {
    const pool = getPgPool();
    const { serviceDate, secs: departSecs } = dateToCdmxServiceDateAndSecs(query.departureAt);

    const request: PlanRequest = {
      origin: { lon: query.origin.lon, lat: query.origin.lat },
      destination: { lon: query.destination.lon, lat: query.destination.lat },
      serviceDate,
      departSecs,
      ...(query.userId ? { userId: query.userId } : {}),
    };

    const result: PlanResult = await planRoute(pool, request, this.searchEngine);

    const stopIds = new Set<string>();
    const ecobiciStationIds = new Set<string>();
    const routeIds = new Set<string>();
    for (const itinerary of result.itineraries) {
      for (const leg of itinerary.legs) {
        if (leg.fromStopId) (leg.fromNodeType === "ecobici_station" ? ecobiciStationIds : stopIds).add(leg.fromStopId);
        if (leg.toStopId) (leg.toNodeType === "ecobici_station" ? ecobiciStationIds : stopIds).add(leg.toStopId);
        if (leg.routeId) routeIds.add(leg.routeId);
      }
    }

    const [stops, ecobiciStations, modeByRouteId] = await Promise.all([
      lookupStops(pool, [...stopIds]),
      lookupEcobiciStations(pool, [...ecobiciStationIds]),
      lookupRouteModes(pool, [...routeIds]),
    ]);

    const options = result.itineraries
      .map((itinerary, index) => toEngineRouteOption(itinerary, index, query, serviceDate, stops, ecobiciStations, modeByRouteId))
      .filter((option) => matchesAllowedModes(option, query.allowedModes))
      .slice(0, Math.max(1, query.maxResults));

    return {
      options,
      meta: {
        plan_confidence: result.confidence,
        search_engine: this.searchEngine,
        search_radius_meters: result.meta.searchRadiusMeters,
        candidate_origin_stops: result.meta.candidateOriginStops,
        candidate_destination_stops: result.meta.candidateDestinationStops,
        expanded_node_count: result.meta.expandedNodeCount,
        db_query_count: result.meta.dbQueryCount,
        elapsed_ms: result.meta.elapsedMs,
        truncated_by_expansion_cap: result.meta.truncatedByExpansionCap,
      },
    };
  }
}
