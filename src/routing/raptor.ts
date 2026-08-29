/**
 * Etapa 2 del brief: RAPTOR por rondas, respetando horarios reales.
 *
 * Adaptación de RAPTOR (Delling, Pajor, Werneck — "Round-Based Public
 * Transit Routing") a multicriterio (variante conocida en la literatura
 * como McRAPTOR: cada parada mantiene una bolsa Pareto en vez de un único
 * mejor arribo) y al contrato de datos real disponible aquí:
 * `graph_stop_neighbors` no expone una tabla de "rutas"/patrones
 * (route-scanning clásico de RAPTOR necesita "para cada ruta, para cada
 * parada en orden, encontrar el trip más próximo abordable"), expone
 * directamente aristas ya resueltas por trip/salida concreta dentro de la
 * ventana pedida. Así que cada ronda hace, por cada parada de la frontera:
 *
 *   1. Escaneo de viaje: relaja aristas `ride` — una ronda = "un transbordo
 *      más" (el criterio del brief). Como `graph_stop_neighbors` da UN
 *      salto (parada -> siguiente parada del mismo trip) por fila, no la
 *      ruta completa de un trip hasta su destino, seguir sentado en el
 *      MISMO vehículo varias paradas seguidas se ENCADENA dentro del mismo
 *      escaneo (sin gastar ronda extra): se sigue relajando aristas `ride`
 *      mientras el `trip_id` no cambie. Abordar un trip DISTINTO sí espera
 *      a la siguiente ronda. Medido contra Postgres real: sin este
 *      encadenamiento, un camión de 10 paradas agotaba el tope de 6 rondas
 *      solo "viajando" sin haber hecho ningún transbordo real — ver
 *      docs/handoff/03-algoritmo.md.
 *   2. Relajación de footpaths: desde TODAS las paradas alcanzadas por el
 *      escaneo de viaje (intermedias y finales — te puedes bajar en
 *      cualquier parada de la ruta), relaja SOLO aristas `walk`/`transfer`
 *      — esto NO consume una ronda (mismo `transfers`), igual que en
 *      RAPTOR clásico el paso de transferencias es parte de la misma ronda
 *      que el escaneo de rutas que la originó.
 *
 * El tope de rondas (`weights.maxTransfers`, acotado siempre por el límite
 * duro `WINDOW.MAX_ROUNDS = 6`) bota el bucle externo. El límite EXACTO de
 * transbordos (no solo el de rondas) se sigue enforzando en cada arista
 * individual dentro de `relaxEdge` (relax.ts), así que aunque el número de
 * rondas fuera mayor, ningún label podría superar `maxTransfers`
 * transbordos reales — el tope de rondas es una cota adicional sobre
 * cuántas veces se vuelve a golpear la base de datos, no la única
 * salvaguarda de correctud.
 *
 * Complejidad por ronda: O(paradas en frontera * costo de
 * graph_stop_neighbors) para el escaneo de viaje, más lo mismo para
 * footpaths — acotado por el tamaño de la frontera, que a su vez está
 * acotado por la ventana espacial/temporal (nunca por el grafo completo).
 *
 * Hallazgo real del entregable de bici (2026-08-22, ver
 * docs/handoff/03-algoritmo.md): las estaciones Ecobici NUNCA producen
 * aristas `ride` (no tienen rutas fijas — ver
 * graph_bike_station_neighbors, docs/handoff/02-grafo.md sección 9.5), así
 * que `scanTripsChained` nunca las "continúa" hacia una ronda futura (esa
 * función solo relaja `ride`). Sin un ajuste, un label que llega a una
 * estación Ecobici por footpath quedaría congelado ahí para siempre: nunca
 * podría pedalear a la siguiente estación ni caminar de regreso a una
 * parada con servicio, porque el paso de footpaths de cada ronda solo se
 * alimenta de `tripImproved` (las llegadas nuevas por `ride`), no de la
 * frontera completa. Se corrigió re-alimentando explícitamente, cada
 * ronda, la porción de la frontera que está en un nodo Ecobici
 * (`ecobiciCarryover`, ver el bucle principal abajo) al mismo paso de
 * footpaths — así SÍ tiene otra oportunidad de pedalear/caminar. Dijkstra
 * (dijkstra.ts) no necesitó este ajuste: relaja una arista a la vez sin
 * importar el tipo de nodo, así que encadena esto de forma natural.
 */
import { ParetoBag } from "./labels.ts";
import { relaxEdge, pruneNeighbors } from "./relax.ts";
import { WINDOW } from "./config.ts";
import { scalarCost } from "./cost.ts";
import type { CostWeights, EdgeType, Label, NeighborFetcher } from "./types.ts";

export interface RaptorParams {
  fetchNeighbors: NeighborFetcher;
  origins: Label[];
  allowedStopIds: Set<string>;
  horizonEndSecs: number;
  weights: CostWeights;
  /** Tope de rondas pedido. Nunca excede WINDOW.MAX_ROUNDS aunque se pida más. */
  maxRounds?: number;
  /**
   * Paradas de destino conocidas de antemano (opcional). RAPTOR no procesa
   * en orden estricto de tiempo (procesa por rondas, en bloque), así que el
   * corte aquí es más conservador que en dijkstra.ts: en cuanto CUALQUIER
   * parada de destino queda alcanzada al final de una ronda, se corre UNA
   * ronda más (para dar oportunidad a alternativas con menos transbordos
   * que sigan llegando) y se detiene, en vez de agotar `maxRounds`.
   */
  targetStopIds?: Set<string>;
  /**
   * Heurística de orientación (segundos de penalización por "qué tan lejos
   * en línea recta queda este stop del destino"), usada SOLO para decidir
   * qué labels conservar al aplicar MAX_LABELS_PER_STOP/MAX_FRONTIER_SIZE.
   * Ver config.ts#HEURISTIC_SPEED_MPS para la justificación completa.
   * Opcional: sin ella, el ranking de poda es puramente por scalarCost
   * (funciona bien sin poda agresiva, pero puede alejarse del destino
   * cuando MAX_FRONTIER_SIZE fuerza a elegir).
   */
  goalBiasFn?: (stopId: string) => number;
  /** Ver dijkstra.ts#deadlineAt — mismo mecanismo, salvaguarda de tiempo de pared real. */
  deadlineAt?: number;
  /**
   * Ver dijkstra.ts#maxWalkToEcobiciEdges — mismo parámetro. Default
   * `WINDOW.MAX_WALK_TO_ECOBICI_EDGES_PER_EXPANSION` si se omite (usado
   * tal cual por los tests sintéticos de este archivo). `index.ts` pasa
   * `0` explícitamente cuando arma los parámetros para el motor `raptor`
   * — ver el comentario largo en index.ts para la evidencia real de por
   * qué: el fan-out hacia Ecobici, incluso acotado a 1 por expansión,
   * mide una degradación real y reproducible en RAPTOR (El Ángel ->
   * Zócalo pasó de encontrar ruta de forma confiable a fallar 6/6 veces)
   * que Dijkstra no sufre. La función `raptor()` en sí SIGUE siendo
   * capaz de encadenar walk->bike->walk (ver el hallazgo de
   * `ecobiciCarryover` en el comentario de módulo y el test sintético
   * correspondiente) — lo que se ajustó es la CONFIGURACIÓN con la que
   * `planRoute` la invoca en producción, no la capacidad del algoritmo.
   */
  maxWalkToEcobiciEdges?: number;
}

export interface RaptorResult {
  bags: Map<string, ParetoBag>;
  expandedNodeCount: number;
  dbQueryCount: number;
  roundsUsed: number;
  /** true si se cortó la búsqueda por WINDOW.MAX_NODE_EXPANSIONS o por deadlineAt antes de agotar las rondas — ver config.ts. */
  truncatedByExpansionCap: boolean;
}

export async function raptor(params: RaptorParams): Promise<RaptorResult> {
  const { fetchNeighbors, origins, allowedStopIds, horizonEndSecs, weights, targetStopIds, goalBiasFn, deadlineAt } =
    params;
  const maxRounds = Math.min(params.maxRounds ?? WINDOW.MAX_ROUNDS, WINDOW.MAX_ROUNDS);
  const maxWalkToEcobiciEdges = params.maxWalkToEcobiciEdges ?? WINDOW.MAX_WALK_TO_ECOBICI_EDGES_PER_EXPANSION;

  const bags = new Map<string, ParetoBag>();
  const bagFor = (stopId: string): ParetoBag => {
    let bag = bags.get(stopId);
    if (!bag) {
      bag = new ParetoBag();
      bags.set(stopId, bag);
    }
    return bag;
  };

  let expandedNodeCount = 0;
  let dbQueryCount = 0;
  let truncatedByExpansionCap = false;

  const budgetExceeded = (): boolean =>
    expandedNodeCount >= WINDOW.MAX_NODE_EXPANSIONS || (deadlineAt !== undefined && performance.now() >= deadlineAt);

  // Ver dijkstra.ts: mismo uso de scalarCost(..., 0) como heurística de
  // ranking interno para trimToSize, no como el costo final mostrado al
  // usuario. Se le suma goalBiasFn (si se pasó) para que la poda por
  // MAX_LABELS_PER_STOP/MAX_FRONTIER_SIZE favorezca ramas que sí avanzan
  // hacia el destino — ver config.ts#HEURISTIC_SPEED_MPS.
  const rankScore = (label: Label) => scalarCost(label, weights, 0) + (goalBiasFn?.(label.stopId) ?? 0);

  const insertMany = (labels: Label[]): Label[] => {
    const improved: Label[] = [];
    for (const l of labels) {
      const bag = bagFor(l.stopId);
      if (!bag.tryInsert(l)) continue;
      bag.trimToSize(WINDOW.MAX_LABELS_PER_STOP, rankScore);
      // Si trimToSize desalojó el label recién insertado (era el peor del
      // grupo), no tiene caso seguir expandiéndolo.
      if (bag.all.includes(l)) improved.push(l);
    }
    return improved;
  };

  /**
   * WINDOW.MAX_FRONTIER_SIZE (ver config.ts): conserva solo los mejores
   * labels por costo escalarizado antes de que alimenten la siguiente
   * expansión — sin esto, la frontera crece de forma genuinamente
   * exponencial en redes densas (medido, ver comentario de config.ts).
   */
  const capFrontier = (labels: Label[]): Label[] => {
    if (labels.length <= WINDOW.MAX_FRONTIER_SIZE) return labels;
    return [...labels].sort((a, b) => rankScore(a) - rankScore(b)).slice(0, WINDOW.MAX_FRONTIER_SIZE);
  };

  /** Expande una tanda de labels relajando SOLO las aristas que pase `accept`. Un query real por label. */
  const expandOnce = async (
    labels: Label[],
    accept: (edgeType: EdgeType) => boolean
  ): Promise<Label[]> => {
    const produced: Label[] = [];
    for (const label of labels) {
      if (budgetExceeded()) {
        truncatedByExpansionCap = true;
        break;
      }

      const windowSecs = Math.min(WINDOW.EXPANSION_WINDOW_SECS, horizonEndSecs - label.arrivalSecs);
      if (windowSecs <= 0) continue;

      expandedNodeCount++;
      const rawNeighbors = await fetchNeighbors(label.stopId, label.nodeType, label.arrivalSecs, windowSecs);
      dbQueryCount++;
      const neighbors = pruneNeighbors(rawNeighbors, WINDOW.MAX_WALK_EDGES_PER_EXPANSION, maxWalkToEcobiciEdges);

      for (const edge of neighbors) {
        if (!accept(edge.edge_type)) continue;
        // Agregado 2026-08-22: aplica a AMBOS tipos de nodo (antes solo
        // gtfs_stop) — ver window.ts#resolveSearchUniverse.
        if (!allowedStopIds.has(edge.to_node_id)) continue;
        const next = relaxEdge({ label, edge, weights, horizonEndSecs });
        if (next) produced.push(next);
      }
    }
    return produced;
  };

  /** Footpaths (walk/transfer): un solo salto, no se encadenan (ver comentario de módulo). */
  const expand = (labels: Label[], accept: (edgeType: EdgeType) => boolean): Promise<Label[]> =>
    expandOnce(labels, accept);

  /**
   * Escaneo de viaje CON encadenamiento de continuaciones del mismo trip
   * (ver comentario de módulo, punto 1). `seedLabels` puede traer
   * `lastTripId` de cualquier procedencia (recién transbordado, recién
   * caminado, o la semilla de origen); el primer salto desde cada uno
   * relaja CUALQUIER arista `ride` disponible (abordar por primera vez o
   * continuar, si por casualidad el vecino ofrece el mismo trip_id que ya
   * traía). Los saltos SIGUIENTES de la cadena (mientras el `trip_id` no
   * cambie) no cuentan ronda extra: se seguyen resolviendo aquí mismo. En
   * cuanto un salto requeriría cambiar de trip_id, NO se relaja dentro de
   * la cadena — esa parada ya quedó en `produced` y se re-escaneará
   * completa (incluida esa opción de transbordo) en la ronda siguiente.
   */
  const scanTripsChained = async (seedLabels: Label[]): Promise<Label[]> => {
    const produced: Label[] = [];
    let queue = seedLabels;
    let isFirstHop = true;
    const MAX_CHAIN_STEPS = 60; // salvaguarda: ningún trip real de CDMX tiene tantas paradas dentro de una ventana de 45 min.

    for (let step = 0; step < MAX_CHAIN_STEPS && queue.length > 0; step++) {
      if (truncatedByExpansionCap) break;
      const nextQueue: Label[] = [];

      for (const label of queue) {
        if (budgetExceeded()) {
          truncatedByExpansionCap = true;
          break;
        }
        const windowSecs = Math.min(WINDOW.EXPANSION_WINDOW_SECS, horizonEndSecs - label.arrivalSecs);
        if (windowSecs <= 0) continue;

        expandedNodeCount++;
        const rawNeighbors = await fetchNeighbors(label.stopId, label.nodeType, label.arrivalSecs, windowSecs);
        dbQueryCount++;
        const neighbors = pruneNeighbors(rawNeighbors, WINDOW.MAX_WALK_EDGES_PER_EXPANSION, maxWalkToEcobiciEdges);

        for (const edge of neighbors) {
          if (edge.edge_type !== "ride") continue;
          // Agregado 2026-08-22: aplica a AMBOS tipos de nodo (antes solo
          // gtfs_stop) — ver window.ts#resolveSearchUniverse.
          if (!allowedStopIds.has(edge.to_node_id)) continue;
          // En saltos encadenados (no el primero), solo seguir el MISMO trip
          // que ya se traía — un trip distinto es un transbordo real, que
          // espera a la siguiente ronda (se re-descubre porque `label`
          // también queda en `produced` y por lo tanto en la frontera).
          if (!isFirstHop && edge.trip_id !== label.lastTripId) continue;

          const next = relaxEdge({ label, edge, weights, horizonEndSecs });
          if (!next) continue;
          produced.push(next);

          if (label.lastTripId !== null && edge.trip_id === label.lastTripId) {
            nextQueue.push(next);
          }
        }
        if (truncatedByExpansionCap) break;
      }

      queue = capFrontier(nextQueue);
      isFirstHop = false;
    }

    return produced;
  };

  // Ronda 0 (no cuenta como transbordo): sembrar orígenes y su primer salto
  // de caminata/transbordo directo, para no penalizar "caminar a la mejor
  // parada de arranque" como si fuera una ronda de transporte.
  const seeded = insertMany(origins);
  const initialFootpaths = await expand(seeded, (t) => t !== "ride");
  const initialFootpathsImproved = insertMany(initialFootpaths);
  let frontier: Label[] = [...seeded, ...initialFootpathsImproved];

  const anyTargetReached = (): boolean =>
    targetStopIds !== undefined &&
    [...targetStopIds].some((stopId) => (bags.get(stopId)?.size ?? 0) > 0);

  let roundsUsed = 0;
  let targetReachedAtRound: number | null = anyTargetReached() ? 0 : null;
  for (let round = 1; round <= maxRounds; round++) {
    if (frontier.length === 0 || truncatedByExpansionCap) break;
    if (targetReachedAtRound !== null && round > targetReachedAtRound + 1) break;
    roundsUsed = round;

    const tripCandidates = await scanTripsChained(frontier);
    const tripImproved = capFrontier(insertMany(tripCandidates));

    // Ver comentario de módulo (hallazgo del entregable de bici): las
    // estaciones Ecobici en la frontera nunca produjeron nada en
    // scanTripsChained (no tienen aristas `ride`) — sin re-alimentarlas
    // aquí, quedarían congeladas para siempre en cuanto se alcanzaran. Se
    // filtra SOLO esta porción de la frontera (no toda, para no re-pagar
    // el costo de volver a relajar footpaths de paradas GTFS que
    // scanTripsChained ya intentó continuar por `ride` en esta misma
    // ronda).
    const ecobiciCarryover = frontier.filter((l) => l.nodeType === "ecobici_station");
    if (tripImproved.length === 0 && ecobiciCarryover.length === 0) break;

    const footpathCandidates = await expand([...tripImproved, ...ecobiciCarryover], (t) => t !== "ride");
    const footpathImproved = capFrontier(insertMany(footpathCandidates));

    frontier = [...tripImproved, ...footpathImproved];

    if (targetReachedAtRound === null && anyTargetReached()) {
      targetReachedAtRound = round;
    }
  }

  return { bags, expandedNodeCount, dbQueryCount, roundsUsed, truncatedByExpansionCap };
}
