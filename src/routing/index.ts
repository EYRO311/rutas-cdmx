/**
 * Entrada pública del motor de ruteo (Fase 3). `api-http` (agente en
 * paralelo) es quien debería envolver `planRoute` en un endpoint HTTP — este
 * módulo no expone servidor ni conoce Fastify, solo la función de
 * planificación en sí. Contrato esperado por quien construya esa capa:
 * `planRoute(pool, request)` recibe un `Pool` de `pg` ya abierto (una
 * conexión por invocación serverless, no uno persistente entre requests) y
 * un `PlanRequest`; devuelve un `PlanResult` con 0+ itinerarios
 * Pareto-óptimos y una `confidence` explícita quedegrada la respuesta en
 * vez de forzarla (CLAUDE.md decisión #7).
 */
import type { Pool } from "pg";
import { dijkstraMultiCriteria } from "./dijkstra.ts";
import { raptor } from "./raptor.ts";
import { loadCostWeights } from "./cost.ts";
import { makeNeighborFetcher } from "./graph-client.ts";
import { buildItinerary } from "./itinerary.ts";
import { WINDOW } from "./config.ts";
import { buildOriginLabels, haversineMeters, resolveAccessStops, resolveSearchUniverse } from "./window.ts";
import type { CostWeights, Itinerary, Label, PlanConfidence, PlanRequest, PlanResult } from "./types.ts";
import type { CandidateStop } from "./types.ts";
import { ParetoBag } from "./labels.ts";

export type Engine = "raptor" | "dijkstra";

interface AttemptOutcome {
  itineraries: Itinerary[];
  candidateOriginStops: number;
  candidateDestinationStops: number;
  expandedNodeCount: number;
  dbQueryCount: number;
  truncatedByExpansionCap: boolean;
}

async function attemptPlan(
  pool: Pool,
  request: PlanRequest,
  weights: CostWeights,
  radiusMeters: number,
  engine: Engine,
  deadlineAt: number
): Promise<AttemptOutcome> {
  // Solo cuenta las queries de resolución de candidatos (universo + acceso);
  // las queries de expansión del algoritmo las cuenta dijkstra.ts/raptor.ts
  // por su cuenta (result.dbQueryCount) — sumar ambas contaría cada query
  // de expansión dos veces, porque makeNeighborFetcher recibe el pool
  // directamente, no un callback duplicado.
  let dbQueryCount = 0;

  const [universe, originAccessStops, destinationAccessStops] = await Promise.all([
    resolveSearchUniverse(pool, request.origin, request.destination, radiusMeters).then((u) => {
      dbQueryCount += 4; // getCandidateStops x2 + getNearbyEcobiciStationIds x2 (agregado 2026-08-22) dentro de resolveSearchUniverse
      return u;
    }),
    resolveAccessStops(pool, request.origin).then((s) => {
      dbQueryCount += 1;
      return s;
    }),
    resolveAccessStops(pool, request.destination).then((s) => {
      dbQueryCount += 1;
      return s;
    }),
  ]);

  if (originAccessStops.length === 0 || destinationAccessStops.length === 0) {
    return {
      itineraries: [],
      candidateOriginStops: originAccessStops.length,
      candidateDestinationStops: destinationAccessStops.length,
      expandedNodeCount: 0,
      dbQueryCount,
      truncatedByExpansionCap: false,
    };
  }

  const origins = buildOriginLabels(originAccessStops, request.departSecs, weights);
  const horizonEndSecs = request.departSecs + (request.horizonSecs ?? WINDOW.TIME_HORIZON_SECS_DEFAULT);
  const fetchNeighbors = makeNeighborFetcher(pool, request.serviceDate);
  const targetStopIds = new Set(destinationAccessStops.map((s) => s.stopId));

  // Heurística de orientación (ver config.ts#HEURISTIC_SPEED_MPS): distancia
  // en línea recta de cada parada del universo de búsqueda al punto de
  // destino, convertida a segundos. universe.originCandidates +
  // destinationCandidates cubren exactamente universe.allowedStopIds, así
  // que toda parada que el motor pueda alcanzar tiene coordenadas aquí.
  const stopCoords = new Map<string, { lat: number; lon: number }>();
  for (const c of [...universe.originCandidates, ...universe.destinationCandidates]) {
    stopCoords.set(c.stopId, { lat: c.lat, lon: c.lon });
  }
  // Limitación nueva (2026-08-22, ver docs/handoff/03-algoritmo.md): a
  // propósito NO se agregan coordenadas de estaciones Ecobici aquí. Se
  // probó (getEcobiciStationCoords, ver graph-client.ts) y se midió que
  // agregaba una query más por intento de planRoute (hasta 2 intentos, más
  // si dijkstra/raptor corren concurrentes contra el mismo pool, como en
  // el caso de prueba de index.test.ts) — suficiente para tumbar el
  // presupuesto de latencia bajo carga concurrente real (ver sección
  // nueva del handoff).
  //
  // PERO devolver 0 (sin bias) para cualquier stopId desconocido resultó
  // ser un bug de ranking real, no un simple "sin ayuda extra": rankScore
  // sale de scalarCost + goalBias, y la poda (trimToSize/capFrontier)
  // conserva los MENORES rankScore — un bias de 0 hace que una estación
  // Ecobici (de la que no sabemos qué tan lejos está del destino) parezca
  // ARTIFICIALMENTE mejor que una parada GTFS real cuyo bias sí refleja su
  // distancia real (positiva). Medido contra Postgres real: esto hacía que
  // ramas Ecobici desplazaran a paradas GTFS legítimamente más cercanas al
  // destino en la frontera de RAPTOR, y RAPTOR (a diferencia de Dijkstra)
  // no tenía margen para recuperarse de esa mala poda dentro de
  // MAX_NODE_EXPANSIONS — El Ángel -> Zócalo pasó de encontrar ruta de
  // forma confiable (Dijkstra) a NUNCA encontrarla (RAPTOR, 6/6 corridas
  // limpias en `no_coverage`) incluso con un tope de fan-out muy chico
  // (MAX_WALK_TO_ECOBICI_EDGES_PER_EXPANSION=1). Corregido con un default
  // conservador y SIN costo de query: para cualquier stopId sin
  // coordenadas conocidas, se asume que está tan lejos del destino como el
  // BORDE del radio de búsqueda (`radiusMeters`) — ni "gratis" (0) ni una
  // estimación real, un piso pesimista honesto que evita que lo
  // desconocido gane competencias de poda que no debería ganar.
  const unknownStopBiasSecs = radiusMeters / WINDOW.HEURISTIC_SPEED_MPS;
  const goalBiasFn = (stopId: string): number => {
    const coords = stopCoords.get(stopId);
    if (!coords) return unknownStopBiasSecs;
    return haversineMeters(coords, request.destination) / WINDOW.HEURISTIC_SPEED_MPS;
  };

  const searchParams = {
    fetchNeighbors,
    origins,
    allowedStopIds: universe.allowedStopIds,
    horizonEndSecs,
    weights,
    targetStopIds,
    goalBiasFn,
    deadlineAt,
    // Agregado 2026-08-22: RAPTOR recibe 0 aquí a propósito — ver
    // raptor.ts#maxWalkToEcobiciEdges para la evidencia real completa.
    // Dijkstra usa el default (WINDOW.MAX_WALK_TO_ECOBICI_EDGES_PER_EXPANSION,
    // sin pasar el campo) porque SÍ tolera el fan-out real de Ecobici dentro
    // del presupuesto de latencia; RAPTOR medido no. planRoute() sigue
    // usando `dijkstra` como motor por defecto, así que esto no afecta el
    // caso de uso normal — es una limitación explícita de usar `raptor`
    // explícitamente con tramos Ecobici, no del motor por defecto.
    maxWalkToEcobiciEdges: engine === "raptor" ? 0 : undefined,
  };

  const result =
    engine === "dijkstra" ? await dijkstraMultiCriteria(searchParams) : await raptor(searchParams);

  const itineraries = buildItinerariesFromBags(result.bags, destinationAccessStops, weights);

  return {
    itineraries,
    candidateOriginStops: originAccessStops.length,
    candidateDestinationStops: destinationAccessStops.length,
    expandedNodeCount: result.expandedNodeCount,
    dbQueryCount: dbQueryCount + result.dbQueryCount,
    truncatedByExpansionCap: result.truncatedByExpansionCap,
  };
}

function buildItinerariesFromBags(
  bags: Map<string, ParetoBag>,
  destinationAccessStops: CandidateStop[],
  weights: CostWeights
): Itinerary[] {
  const itineraries: Itinerary[] = [];
  for (const destStop of destinationAccessStops) {
    const bag = bags.get(destStop.stopId);
    if (!bag) continue;
    for (const label of bag.all as readonly Label[]) {
      itineraries.push(buildItinerary({ finalLabel: label, destinationStop: destStop, weights }));
    }
  }
  // Ranking global: escalar ascendente, y entre iguales, menos transbordos.
  itineraries.sort((a, b) => a.scalarCost - b.scalarCost || a.transfers - b.transfers);
  return dedupePareto(itineraries);
}

/**
 * Varias paradas de acceso al destino pueden producir itinerarios
 * dominados entre sí (ej. llegar a la parada A y caminar 200m vs. llegar a
 * la parada B, peor en todo). Se aplica dominancia de Pareto también sobre
 * el conjunto final de itinerarios puerta a puerta antes de devolverlos.
 */
function dedupePareto(itineraries: Itinerary[]): Itinerary[] {
  const kept: Itinerary[] = [];
  for (const candidate of itineraries) {
    const dominated = kept.some(
      (k) =>
        k.durationSecs <= candidate.durationSecs &&
        k.transfers <= candidate.transfers &&
        k.walkSecs <= candidate.walkSecs &&
        k.costPesos <= candidate.costPesos &&
        (k.durationSecs < candidate.durationSecs ||
          k.transfers < candidate.transfers ||
          k.walkSecs < candidate.walkSecs ||
          k.costPesos < candidate.costPesos)
    );
    if (!dominated) kept.push(candidate);
  }
  return kept;
}

export async function planRoute(
  pool: Pool,
  request: PlanRequest,
  // Default = 'dijkstra': medido contra Postgres real (ver
  // docs/handoff/03-algoritmo.md), la cola de prioridad estrictamente
  // ordenada por arrivalSecs de Dijkstra da un corte temprano EXACTO en
  // cuanto se alcanza el destino, mientras que RAPTOR (procesamiento por
  // rondas en bloque) necesita un presupuesto de nodos más generoso para
  // converger de forma confiable en las mismas consultas — ambos motores
  // están completos y correctos, esto es una decisión de rendimiento, no de
  // corrección. `raptor` sigue disponible pasándolo explícitamente.
  engine: Engine = "dijkstra"
): Promise<PlanResult> {
  const startedAt = performance.now();
  const overallDeadline = startedAt + WINDOW.SEARCH_TIME_BUDGET_MS;
  const weights = await loadCostWeights(pool, request.userId);

  let radiusMeters: number = WINDOW.SEARCH_RADIUS_METERS_DEFAULT;
  let confidence: PlanConfidence = "full";
  let outcome = await attemptPlan(pool, request, weights, radiusMeters, engine, overallDeadline);

  if (outcome.itineraries.length === 0 && radiusMeters < WINDOW.SEARCH_RADIUS_METERS_RETRY) {
    radiusMeters = WINDOW.SEARCH_RADIUS_METERS_RETRY;
    const retryOutcome = await attemptPlan(pool, request, weights, radiusMeters, engine, overallDeadline);
    outcome = {
      itineraries: retryOutcome.itineraries,
      candidateOriginStops: retryOutcome.candidateOriginStops,
      candidateDestinationStops: retryOutcome.candidateDestinationStops,
      expandedNodeCount: outcome.expandedNodeCount + retryOutcome.expandedNodeCount,
      dbQueryCount: outcome.dbQueryCount + retryOutcome.dbQueryCount,
      truncatedByExpansionCap: outcome.truncatedByExpansionCap || retryOutcome.truncatedByExpansionCap,
    };
    confidence = retryOutcome.itineraries.length > 0 ? "degraded_radius_8km" : "no_coverage";
  }

  return {
    confidence,
    itineraries: outcome.itineraries,
    meta: {
      searchRadiusMeters: radiusMeters,
      candidateOriginStops: outcome.candidateOriginStops,
      candidateDestinationStops: outcome.candidateDestinationStops,
      expandedNodeCount: outcome.expandedNodeCount,
      dbQueryCount: outcome.dbQueryCount,
      elapsedMs: performance.now() - startedAt,
      truncatedByExpansionCap: outcome.truncatedByExpansionCap,
    },
  };
}

export { dijkstraMultiCriteria } from "./dijkstra.ts";
export { raptor } from "./raptor.ts";
export { loadCostWeights, defaultCostWeights, scalarCost } from "./cost.ts";
export * from "./types.ts";
