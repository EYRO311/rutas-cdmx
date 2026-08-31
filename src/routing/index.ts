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
import {
  applyCorridorFilter,
  buildOriginLabels,
  haversineMeters,
  resolveAccessStops,
  resolveSearchUniverse,
} from "./window.ts";
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
  /** Ver dijkstra.ts#DijkstraResult.hitNodeCap. Agregado 2026-08-30 (sección 13). */
  hitNodeCap: boolean;
}

interface AttemptOptions {
  /**
   * Agregado 2026-08-30 (ver docs/handoff/03-algoritmo.md sección 12,
   * window.ts#applyCorridorFilter). Si se pasa, restringe
   * `universe.allowedStopIds` a las paradas dentro de la elipse
   * origen-destino con este factor, ANTES de correr el motor de búsqueda —
   * solo lo usa el tier de distancia larga de `planRoute`.
   */
  corridorEllipseFactor?: number;
  /** Ver dijkstra.ts#maxNodeExpansions/raptor.ts#maxNodeExpansions. */
  maxNodeExpansions?: number;
}

async function attemptPlan(
  pool: Pool,
  request: PlanRequest,
  weights: CostWeights,
  radiusMeters: number,
  engine: Engine,
  deadlineAt: number,
  options: AttemptOptions = {}
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
      hitNodeCap: false,
    };
  }

  const origins = buildOriginLabels(originAccessStops, request.departSecs, weights);
  const horizonEndSecs = request.departSecs + (request.horizonSecs ?? WINDOW.TIME_HORIZON_SECS_DEFAULT);
  const fetchNeighbors = makeNeighborFetcher(pool, request.serviceDate);
  const targetStopIds = new Set(destinationAccessStops.map((s) => s.stopId));

  // Agregado 2026-08-30 (ver docs/handoff/03-algoritmo.md sección 12): filtro
  // de corredor, SOLO aplicado por el tier de distancia larga de planRoute()
  // (options.corridorEllipseFactor). El tier normal (corto/mediano) sigue
  // usando universe.allowedStopIds tal cual, sin ningún cambio de
  // comportamiento respecto de antes de este entregable.
  const allowedStopIds =
    options.corridorEllipseFactor !== undefined
      ? applyCorridorFilter(universe, request.origin, request.destination, options.corridorEllipseFactor)
      : universe.allowedStopIds;

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

  // Heurística ADMISIBLE de A* (agregado 2026-08-30, ver
  // docs/handoff/03-algoritmo.md sección 12). Distinta de goalBiasFn: esta
  // ordena la EXPANSIÓN (la cola de prioridad de dijkstra.ts), aquella solo
  // la PODA. Debe ser una cota INFERIOR del tiempo restante para no perder
  // rutas Pareto-óptimas (config.ts#ASTAR_ADMISSIBLE_SPEED_MPS explica por
  // qué 15 m/s es una cota superior segura de la velocidad efectiva, lo que
  // hace del tiempo estimado una cota inferior admisible). Para nodos sin
  // coordenadas conocidas baratas (estaciones Ecobici — no se pagan queries
  // extra por su ubicación, misma decisión que goalBiasFn) se devuelve 0, que
  // siempre es una cota inferior válida del tiempo restante (admisible): a lo
  // sumo hace que A* explore esos nodos un poco más ansiosamente, nunca que
  // pierda una ruta.
  const heuristicFn = (stopId: string): number => {
    const coords = stopCoords.get(stopId);
    if (!coords) return 0;
    return haversineMeters(coords, request.destination) / WINDOW.ASTAR_ADMISSIBLE_SPEED_MPS;
  };

  const searchParams = {
    fetchNeighbors,
    origins,
    allowedStopIds,
    horizonEndSecs,
    weights,
    targetStopIds,
    goalBiasFn,
    // A* admisible: solo lo consume dijkstra.ts (motor por defecto). raptor.ts
    // lo acepta e ignora (es round-based, no tiene una cola de prioridad
    // global que ordenar) — ver docs/handoff/03-algoritmo.md sección 12.
    heuristicFn,
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
    // Agregado 2026-08-30: ver DijkstraParams#maxNodeExpansions. undefined
    // (tier normal) cae al default WINDOW.MAX_NODE_EXPANSIONS de siempre.
    maxNodeExpansions: options.maxNodeExpansions,
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
    hitNodeCap: result.hitNodeCap,
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
  const weights = await loadCostWeights(pool, request.userId);

  // Agregado 2026-08-30 (ver docs/handoff/03-algoritmo.md sección 12,
  // seguimiento del hallazgo crítico de qa-rutas — commute largo real que
  // daba no_coverage). Viajes cuya distancia recta origen-destino supera
  // WINDOW.LONG_DISTANCE_THRESHOLD_METERS usan un tier de búsqueda distinto
  // (corredor + presupuesto extendido) en vez del tier normal de abajo —
  // ver attemptLongDistancePlan. El tier normal (este archivo, resto de la
  // función) queda EXACTAMENTE igual que antes de este cambio: ningún caso
  // corto/mediano ya medido (El Ángel↔Zócalo, Chapultepec↔Merced, los 5
  // smoke de Ecobici) cambia de comportamiento ni de presupuesto.
  const odMeters = haversineMeters(request.origin, request.destination);
  if (odMeters > WINDOW.LONG_DISTANCE_THRESHOLD_METERS) {
    return attemptLongDistancePlan(pool, request, weights, engine, startedAt, {
      successConfidence: "degraded_long_distance",
      maxNodeExpansions: WINDOW.MAX_NODE_EXPANSIONS_LONG_DISTANCE,
      timeBudgetMs: WINDOW.SEARCH_TIME_BUDGET_MS_LONG_DISTANCE,
    });
  }

  const overallDeadline = startedAt + WINDOW.SEARCH_TIME_BUDGET_MS;

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
      hitNodeCap: outcome.hitNodeCap || retryOutcome.hitNodeCap,
    };
    confidence = retryOutcome.itineraries.length > 0 ? "degraded_radius_8km" : "no_coverage";
  }

  // Agregado 2026-08-30 (ver docs/handoff/03-algoritmo.md sección 13 —
  // hallazgo del orquestador: un viaje CORTO ~4.3km, Nápoles/Del Valle→Xoco,
  // bien dentro del tier normal, daba no_coverage por agotar el presupuesto).
  // Fallback adaptativo por DENSIDAD/DIFICULTAD, no por distancia: el tier
  // normal agotó su presupuesto (`truncatedByExpansionCap`) sin alcanzar el
  // destino, pese a que sí había paradas de acceso en ambos extremos. Medido
  // (sección 13): ni la distancia recta (4.3km < 6km) ni la densidad de
  // paradas candidatas (2,431, MENOS que El Ángel↔Zócalo, que sí converge)
  // predicen esta dificultad — el único indicador es que el tier normal se
  // quedó sin presupuesto sin cobertura. Se reintenta con el filtro de
  // corredor + un presupuesto ACOTADO propio (MAX_NODE_EXPANSIONS_DENSE_FALLBACK
  // / SEARCH_TIME_BUDGET_MS_DENSE_FALLBACK, ~12s, NO los 60s del tier largo),
  // que reduce las expansiones de este corredor de ~9,718 a ~1,440 y sí
  // encuentra ruta. Confianza propia (`degraded_dense`), no
  // `degraded_long_distance`: sería engañoso etiquetar un viaje de 4.3km como
  // "larga distancia".
  //
  // Se dispara con `truncatedByExpansionCap` (cortó por tope de NODOS O por
  // deadline de TIEMPO), NO con `hitNodeCap` a secas. Se PROBÓ disparar solo
  // con `hitNodeCap` (tope de nodos, para no reintentar cuando la lentitud es
  // contención pasajera) y se DESCARTÓ con evidencia (sección 13): qué límite
  // se alcanza primero (nodos vs tiempo) depende de la latencia por-query,
  // que en producción (Supabase sobre red, más lenta que Postgres local) hace
  // que el deadline de TIEMPO se alcance ANTES que el tope de nodos incluso
  // en un caso denso legítimo — con `hitNodeCap` el fallback casi nunca se
  // dispararía justo donde se necesita. `hitNodeCap` se conserva en el
  // resultado solo como observabilidad. Un no_coverage por FALTA de paradas
  // de acceso (candidate*Stops = 0) retorna temprano con
  // truncatedByExpansionCap=false y NO gasta este reintento; uno por agotar
  // el universo alcanzable sin truncar tampoco. Costo real y su interacción
  // con la contención de test documentados en la sección 13.
  if (outcome.itineraries.length === 0 && outcome.truncatedByExpansionCap) {
    return attemptLongDistancePlan(pool, request, weights, engine, startedAt, {
      successConfidence: "degraded_dense",
      maxNodeExpansions: WINDOW.MAX_NODE_EXPANSIONS_DENSE_FALLBACK,
      timeBudgetMs: WINDOW.SEARCH_TIME_BUDGET_MS_DENSE_FALLBACK,
    });
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

/**
 * Tier de distancia larga (ver docs/handoff/03-algoritmo.md sección 12).
 * Diferencias deliberadas respecto del tier normal (`planRoute` arriba):
 *
 * 1. Va DIRECTO a `SEARCH_RADIUS_METERS_RETRY` (8km) — evidencia real
 *    (docs/handoff/08-qa.md sección 1.1): un viaje >6km casi con certeza
 *    necesita las paradas de transbordo que solo aparecen a 8km, así que
 *    intentar primero a 5km solo gastaría presupuesto en un intento que va
 *    a fallar de todos modos. Nunca excede 8km — sigue siendo el tope duro
 *    del brief ("no más").
 * 2. Aplica el filtro de corredor (`WINDOW.CORRIDOR_ELLIPSE_FACTOR`) —
 *    reduce el universo de paradas candidatas ~55% en el caso real medido.
 * 3. Usa el presupuesto extendido (`MAX_NODE_EXPANSIONS_LONG_DISTANCE`,
 *    `SEARCH_TIME_BUDGET_MS_LONG_DISTANCE`) — deliberadamente incumple
 *    p95 < 3s para esta clase de consulta, ver justificación en config.ts.
 * 4. Si encuentra un itinerario, la confianza es `successConfidence` (nunca
 *    `"full"`) — refleja el costo real de obtenerlo, no su validez. Vale
 *    `"degraded_long_distance"` cuando se llega aquí por distancia (>6km) o
 *    `"degraded_dense"` cuando se llega como FALLBACK adaptativo de un tier
 *    normal que agotó su presupuesto sin cobertura (viaje corto en corredor
 *    denso — ver docs/handoff/03-algoritmo.md sección 13). La maquinaria
 *    (corredor + presupuesto extendido) es idéntica en ambos casos; solo
 *    cambia la etiqueta de confianza para no llamar "larga distancia" a un
 *    viaje que no lo es.
 */
async function attemptLongDistancePlan(
  pool: Pool,
  request: PlanRequest,
  weights: CostWeights,
  engine: Engine,
  startedAt: number,
  opts: {
    successConfidence: "degraded_long_distance" | "degraded_dense";
    maxNodeExpansions: number;
    timeBudgetMs: number;
  }
): Promise<PlanResult> {
  const { successConfidence, maxNodeExpansions, timeBudgetMs } = opts;
  const radiusMeters = WINDOW.SEARCH_RADIUS_METERS_RETRY;
  const deadlineAt = startedAt + timeBudgetMs;

  const outcome = await attemptPlan(pool, request, weights, radiusMeters, engine, deadlineAt, {
    corridorEllipseFactor: WINDOW.CORRIDOR_ELLIPSE_FACTOR,
    maxNodeExpansions,
  });

  const confidence: PlanConfidence = outcome.itineraries.length > 0 ? successConfidence : "no_coverage";

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
