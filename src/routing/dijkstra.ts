/**
 * Etapa 1 del brief: Dijkstra multicriterio.
 *
 * Multi-Label Correcting (MLC) — literatura estándar de ruteo
 * multicriterio: en vez de una sola distancia mínima por nodo, cada parada
 * mantiene una "bolsa" de labels Pareto-óptimos (labels.ts). La cola de
 * prioridad global se ordena por `arrivalSecs` (criterio primario, el que
 * hace que el algoritmo siga siendo "Dijkstra": nunca se re-abre un label
 * ya extraído con mejor arrivalSecs). La poda real que hace que esto no
 * explote combinatoriamente es la dominancia de Pareto sobre las 4
 * dimensiones (tiempo, transbordos, caminata, costo) — ver labels.ts.
 *
 * Complejidad: con B = tamaño máximo de bolsa Pareto por parada (acotado en
 * la práctica por los 4 criterios y el tope de transbordos), es equivalente
 * a Dijkstra con como mucho B labels por nodo: O(B * E * log(B * V)) sobre
 * el subgrafo explorado, donde V/E están acotados por la ventana espacial
 * (WINDOW.SEARCH_RADIUS_METERS_*) y temporal (horizonEndSecs), NUNCA por el
 * grafo completo — no hay grafo completo en memoria en ningún momento (ver
 * CLAUDE.md decisión #7).
 *
 * NO respeta rondas de transbordo como unidad de iteración (eso es RAPTOR,
 * ver raptor.ts) — aquí el orden de expansión es por tiempo de llegada, sin
 * estructura de rondas. Se deja como etapa independiente porque el brief
 * las pide como dos entregables separados y compararlas (mismo resultado,
 * caminos distintos para llegar a él) es en sí mismo una validación de
 * ambos motores — ver docs/handoff/03-algoritmo.md.
 *
 * Agregado 2026-08-22: como este bucle relaja UNA arista a la vez sin
 * importar el tipo de nodo (gtfs_stop o ecobici_station, `fetchNeighbors`
 * despacha por `label.nodeType` — ver graph-client.ts), una cadena real
 * "camina a estación Ecobici -> pedalea a otra -> camina de vuelta a una
 * parada con servicio" se encuentra de forma completamente natural, sin
 * ningún cambio estructural en este archivo — a diferencia de raptor.ts,
 * que sí necesitó un ajuste (ver comentario ahí). Ver
 * docs/handoff/03-algoritmo.md para la evidencia real de un caso así.
 */
import { ParetoBag, primaryOrderKey } from "./labels.ts";
import { relaxEdge, pruneNeighbors } from "./relax.ts";
import { MinHeap } from "./heap.ts";
import { WINDOW } from "./config.ts";
import { scalarCost } from "./cost.ts";
import type { CostWeights, Label, NeighborFetcher } from "./types.ts";

export interface DijkstraParams {
  fetchNeighbors: NeighborFetcher;
  origins: Label[];
  allowedStopIds: Set<string>;
  horizonEndSecs: number;
  weights: CostWeights;
  /**
   * Paradas de destino conocidas de antemano (opcional). Si se pasa, la
   * búsqueda deja de expandir en cuanto ha agotado todos los labels con
   * `arrivalSecs <= primer arribo a un destino + WINDOW.EARLY_STOP_SLACK_SECS`
   * — gracias a que la cola de prioridad procesa en orden estrictamente
   * ascendente de `arrivalSecs`, este corte es EXACTO: ningún label mejor
   * para ningún destino puede aparecer después de ese punto. Sin
   * `targetStopIds`, la búsqueda solo se acota por horizonte/rondas/tope de
   * expansiones (comportamiento "mapear todo lo alcanzable", útil para
   * quien quiera explorar el subgrafo completo en vez de un plan puntual).
   */
  targetStopIds?: Set<string>;
  /** Ver raptor.ts — misma heurística de orientación, aplicada al ranking de trimToSize. */
  goalBiasFn?: (stopId: string) => number;
  /**
   * Deadline de tiempo de PARED (performance.now() + presupuesto), no de
   * CPU. Ver config.ts#SEARCH_TIME_BUDGET_MS — salvaguarda directa y
   * precisa del criterio de aceptación real (p95 < 3s en frío);
   * MAX_NODE_EXPANSIONS es un proxy imperfecto (la latencia real de cada
   * query a Postgres varía).
   */
  deadlineAt?: number;
  /**
   * Agregado 2026-08-22: tope de fan-out para aristas `walk` hacia una
   * estación Ecobici, por expansión (ver relax.ts#limitWalkFanout,
   * config.ts#MAX_WALK_TO_ECOBICI_EDGES_PER_EXPANSION). Parametrizado (en
   * vez de leer WINDOW directamente, como sí hacen los demás topes) porque
   * index.ts necesita poder pasar un valor DISTINTO por motor — medido
   * contra Postgres real, Dijkstra tolera bien el valor por defecto, pero
   * RAPTOR no (ver raptor.ts para el detalle completo). Default:
   * `WINDOW.MAX_WALK_TO_ECOBICI_EDGES_PER_EXPANSION` si se omite.
   */
  maxWalkToEcobiciEdges?: number;
}

export interface DijkstraResult {
  bags: Map<string, ParetoBag>;
  expandedNodeCount: number;
  dbQueryCount: number;
  /** true si se cortó la búsqueda por WINDOW.MAX_NODE_EXPANSIONS o por deadlineAt antes de agotar la cola — ver config.ts. */
  truncatedByExpansionCap: boolean;
}

export async function dijkstraMultiCriteria(params: DijkstraParams): Promise<DijkstraResult> {
  const { fetchNeighbors, origins, allowedStopIds, horizonEndSecs, weights, targetStopIds, goalBiasFn, deadlineAt } =
    params;
  const maxWalkToEcobiciEdges = params.maxWalkToEcobiciEdges ?? WINDOW.MAX_WALK_TO_ECOBICI_EDGES_PER_EXPANSION;

  const bags = new Map<string, ParetoBag>();
  const heap = new MinHeap<Label>(primaryOrderKey);
  let expandedNodeCount = 0;
  let dbQueryCount = 0;
  let truncatedByExpansionCap = false;
  let earliestTargetArrival: number | null = null;

  // scalarCost(label, weights, 0) se usa solo como heurística de ranking
  // interno para trimToSize — el corrimiento por originDepartSecs es una
  // constante para todos los labels de ESTA búsqueda, así que no afecta el
  // orden relativo. No es el mismo valor que verá el usuario final (ese lo
  // calcula itinerary.ts con el originDepartSecs real).
  const rankScore = (label: Label) => scalarCost(label, weights, 0) + (goalBiasFn?.(label.stopId) ?? 0);

  const bagFor = (stopId: string): ParetoBag => {
    let bag = bags.get(stopId);
    if (!bag) {
      bag = new ParetoBag();
      bags.set(stopId, bag);
    }
    return bag;
  };

  const tryAdmit = (label: Label): boolean => {
    const bag = bagFor(label.stopId);
    if (!bag.tryInsert(label)) return false;
    bag.trimToSize(WINDOW.MAX_LABELS_PER_STOP, rankScore);
    return bag.all.includes(label);
  };

  for (const origin of origins) {
    if (tryAdmit(origin)) heap.push(origin);
  }

  while (heap.size > 0) {
    if (expandedNodeCount >= WINDOW.MAX_NODE_EXPANSIONS || (deadlineAt !== undefined && performance.now() >= deadlineAt)) {
      truncatedByExpansionCap = true;
      break;
    }

    const label = heap.pop();
    if (!label) break;

    // Corte por destino (solo si se pasó targetStopIds): la cola procesa en
    // orden ascendente estricto de arrivalSecs, así que en cuanto el
    // siguiente label a expandir llega después de la franja de gracia
    // posterior al primer arribo a un destino, NINGÚN label restante en la
    // cola puede mejorar ningún destino — es seguro parar del todo.
    if (earliestTargetArrival !== null && label.arrivalSecs > earliestTargetArrival + WINDOW.EARLY_STOP_SLACK_SECS) {
      break;
    }

    // Lazy deletion: si el label ya fue podado del bag desde que se
    // insertó en el heap (porque llegó un label mejor, o porque
    // trimToSize lo desalojó), se descarta sin volver a expandir.
    if (!bagFor(label.stopId).all.includes(label)) continue;

    if (targetStopIds?.has(label.stopId)) {
      earliestTargetArrival =
        earliestTargetArrival === null ? label.arrivalSecs : Math.min(earliestTargetArrival, label.arrivalSecs);
    }

    if (label.arrivalSecs >= horizonEndSecs) continue;

    const windowSecs = Math.min(WINDOW.EXPANSION_WINDOW_SECS, horizonEndSecs - label.arrivalSecs);
    if (windowSecs <= 0) continue;

    expandedNodeCount++;
    const rawNeighbors = await fetchNeighbors(label.stopId, label.nodeType, label.arrivalSecs, windowSecs);
    dbQueryCount++;
    const neighbors = pruneNeighbors(rawNeighbors, WINDOW.MAX_WALK_EDGES_PER_EXPANSION, maxWalkToEcobiciEdges);

    for (const edge of neighbors) {
      // Agregado 2026-08-22: el filtro por universo de búsqueda ahora
      // aplica a AMBOS tipos de nodo (antes solo a gtfs_stop) — ver
      // window.ts#resolveSearchUniverse para por qué esto era necesario.
      if (!allowedStopIds.has(edge.to_node_id)) continue;

      const next = relaxEdge({ label, edge, weights, horizonEndSecs });
      if (!next) continue;

      if (tryAdmit(next)) heap.push(next);
    }
  }

  return { bags, expandedNodeCount, dbQueryCount, truncatedByExpansionCap };
}
