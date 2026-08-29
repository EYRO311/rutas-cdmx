/**
 * Relajación de una arista: dado un label en un nodo (parada GTFS o
 * estación Ecobici) y una fila normalizada de vecinos, produce el label
 * resultante en el vecino (o `null` si la arista no es aplicable).
 * Compartido por dijkstra.ts y raptor.ts para no duplicar la semántica de
 * las 4 clases de arista.
 *
 * Detalles no obvios del contrato de graph_stop_neighbors (ver
 * docs/handoff/02-grafo.md sección 3.5 y el SQL en
 * migrations/0012_transit_graph.sql) que hay que respetar aquí:
 * - Para `edge_type = 'transfer'`, la columna `arrive_secs` NO es un
 *   instante absoluto: es `min_transfer_time_secs`, una DURACIÓN. Tratarla
 *   como instante absoluto (como si fuera una arista `ride`) sería un bug
 *   silencioso — se descubrió leyendo el SQL fuente, no está explícito en
 *   el texto de la sección 3.5.
 * - `depart_secs`/`arrive_secs` son NULL para `walk` (se deriva del tiempo
 *   de caminata) y `depart_secs` es NULL para `transfer`.
 *
 * Agregado 2026-08-22 (ver docs/handoff/03-algoritmo.md, sección nueva):
 * ya NO se descartan vecinos `to_node_type = 'ecobici_station'`. Dos
 * aristas nuevas, ambas ya normalizadas por graph-client.ts a esta misma
 * forma `StopNeighborRow` (venga de `graph_stop_neighbors` o de
 * `graph_bike_station_neighbors`):
 * - `walk` hacia una estación Ecobici: MISMA semántica que `walk` hacia una
 *   parada GTFS (deriva el tiempo de `distance_meters` con la velocidad de
 *   caminata) — ya existía en el contrato de `graph_stop_neighbors` pero se
 *   descartaba ciegamente antes de este cambio.
 * - `bike`: el tramo pedaleado real entre dos estaciones Ecobici. Tiempo YA
 *   calculado (`duration_secs`, viene de `bike_edges`, ver
 *   docs/handoff/02-grafo.md sección 9.2) — NO se deriva de
 *   `distance_meters` como walk, porque ya viene resuelto con la velocidad
 *   mediana real medida de viajes de Ecobici. No incrementa `transfers`
 *   (se trata como cambio de modo, igual que walk/transfer, no como
 *   "abordar un vehículo distinto" — el contador de transbordos sigue
 *   atado exclusivamente a `trip_id`, ver abajo) ni `walkSecs` (no es
 *   caminata) ni `costPesos` (no hay tarifa de Ecobici modelada — mismo
 *   tipo de gap ya documentado para `flatFarePesosPerBoarding`, ver
 *   cost.ts). La disponibilidad real (bici en origen, dock en destino) se
 *   filtra ANTES de que la fila llegue aquí — ver
 *   graph-client.ts#makeNeighborFetcher y filterBikeAvailability() abajo;
 *   relaxEdge se mantiene puro y sin Postgres a propósito (permite el
 *   mismo estilo de test unitario puro que ya tenía este archivo).
 *
 * Conteo de transbordos: se cuenta un transbordo cuando se aborda un
 * `trip_id` distinto del último efectivamente abordado (`lastTripId`),
 * SIN resetear `lastTripId` al atravesar una arista `walk`/`transfer`/
 * `bike` — así "caminar o pedalear a otra parada y abordar un trip
 * distinto" sigue contando como transbordo, que es el comportamiento
 * correcto. El primer abordaje (`lastTripId === null`) nunca cuenta como
 * transbordo, aunque sí se cobra la tarifa.
 */
import type { CostWeights, EcobiciAvailability, Label, StopNeighborRow } from "./types.ts";
import { walkSecondsFromMeters } from "./cost.ts";

export function relaxEdge(params: {
  label: Label;
  edge: StopNeighborRow;
  weights: CostWeights;
  horizonEndSecs: number;
}): Label | null {
  const { label, edge, weights, horizonEndSecs } = params;

  let next: Label;

  if (edge.edge_type === "ride") {
    if (edge.trip_id === null || edge.depart_secs === null || edge.arrive_secs === null) {
      return null;
    }
    // No se puede abordar un tramo que ya salió respecto al arribo actual.
    if (edge.depart_secs < label.arrivalSecs) return null;

    const cameFromPriorRide = label.lastTripId !== null;
    const isNewBoarding = label.lastTripId !== edge.trip_id;
    const transfers = label.transfers + (cameFromPriorRide && isNewBoarding ? 1 : 0);
    if (transfers > weights.maxTransfers) return null;

    next = {
      stopId: edge.to_node_id,
      nodeType: edge.to_node_type,
      arrivalSecs: edge.arrive_secs,
      transfers,
      walkSecs: label.walkSecs,
      costPesos: label.costPesos + (isNewBoarding ? weights.flatFarePesosPerBoarding : 0),
      lastTripId: edge.trip_id,
      parent: label,
      viaEdge: {
        edgeType: "ride",
        tripId: edge.trip_id,
        routeId: edge.route_id,
        departSecs: edge.depart_secs,
        fromStopId: label.stopId,
        distanceMeters: null,
      },
    };
  } else if (edge.edge_type === "transfer") {
    // arrive_secs aquí es min_transfer_time_secs (DURACIÓN), no un instante.
    const durationSecs = edge.arrive_secs ?? 0;
    next = {
      stopId: edge.to_node_id,
      nodeType: edge.to_node_type,
      arrivalSecs: label.arrivalSecs + durationSecs,
      transfers: label.transfers,
      walkSecs: label.walkSecs + durationSecs,
      costPesos: label.costPesos,
      lastTripId: label.lastTripId,
      parent: label,
      viaEdge: {
        edgeType: "transfer",
        tripId: null,
        routeId: null,
        departSecs: null,
        fromStopId: label.stopId,
        distanceMeters: null,
      },
    };
  } else if (edge.edge_type === "walk") {
    if (edge.distance_meters === null) return null;
    const durationSecs = Math.round(walkSecondsFromMeters(edge.distance_meters, weights.walkingSpeedMps));
    next = {
      stopId: edge.to_node_id,
      nodeType: edge.to_node_type,
      arrivalSecs: label.arrivalSecs + durationSecs,
      transfers: label.transfers,
      walkSecs: label.walkSecs + durationSecs,
      costPesos: label.costPesos,
      lastTripId: label.lastTripId,
      parent: label,
      viaEdge: {
        edgeType: "walk",
        tripId: null,
        routeId: null,
        departSecs: null,
        fromStopId: label.stopId,
        distanceMeters: edge.distance_meters,
      },
    };
  } else if (edge.edge_type === "bike") {
    // Disponibilidad real (bici en origen, dock en destino) ya se filtró
    // río arriba (graph-client.ts) antes de que esta fila llegara aquí —
    // ver filterBikeAvailability() más abajo en este archivo. Si llegó
    // hasta acá con edge_type === 'bike', ya es viable para esta consulta.
    if (edge.duration_secs === null) return null;
    const durationSecs = edge.duration_secs;
    next = {
      stopId: edge.to_node_id,
      nodeType: edge.to_node_type,
      arrivalSecs: label.arrivalSecs + durationSecs,
      // No cuenta como transbordo (mismo trato que walk/transfer — el
      // contador solo se mueve al abordar un trip_id distinto, ver
      // comentario de módulo) ni como caminata (walkSecs sin cambio). Sin
      // tarifa de Ecobici modelada (costPesos sin cambio) — gap explícito,
      // ver comentario de módulo.
      transfers: label.transfers,
      walkSecs: label.walkSecs,
      costPesos: label.costPesos,
      lastTripId: label.lastTripId,
      parent: label,
      viaEdge: {
        edgeType: "bike",
        tripId: null,
        routeId: null,
        departSecs: null,
        fromStopId: label.stopId,
        distanceMeters: edge.distance_meters,
      },
    };
  } else {
    return null;
  }

  if (next.arrivalSecs > horizonEndSecs) return null;
  return next;
}

/**
 * Optimización de fan-out SIN pérdida de correctud. Para trips
 * frequency-based (1,203/1,205 — ver docs/handoff/02-grafo.md sección
 * 3.5), `graph_ride_departures` devuelve UNA FILA POR CADA salida `k`
 * dentro de la ventana pedida, todas con el MISMO `trip_id` (el patrón de
 * frequencies.txt reusa un solo trip_id para todas sus salidas). Como
 * `relaxEdge` calcula transbordos/costo únicamente a partir de `trip_id`
 * (no de `depart_secs`), todas esas filas producen el MISMO resultado en
 * transfers/costPesos — solo cambia `arrivalSecs`. La salida más temprana
 * domina en TODOS los criterios a cualquier salida posterior del mismo
 * (to_node_id, trip_id) — así que procesar las demás es trabajo
 * garantizado-desperdiciado, no una necesidad de completitud del Pareto
 * frontier.
 *
 * Medido contra Postgres real (ver docs/handoff/03-algoritmo.md): una
 * ventana de 45 min sobre una parada concurrida devolvió 32 filas `ride`
 * para solo 4 combinaciones (to_node_id, trip_id) distintas — 8x de
 * fan-out evitable por expansión de nodo. Con cientos/miles de nodos
 * expandidos por búsqueda, este factor es la diferencia entre cumplir o no
 * el presupuesto de p95 < 3s.
 */
export function dedupeRideEdges(rows: StopNeighborRow[]): StopNeighborRow[] {
  const earliestByKey = new Map<string, StopNeighborRow>();
  const passthrough: StopNeighborRow[] = [];

  for (const row of rows) {
    if (row.edge_type !== "ride") {
      passthrough.push(row);
      continue;
    }
    const key = `${row.to_node_id}::${row.trip_id ?? ""}`;
    const existing = earliestByKey.get(key);
    const rowArrive = row.arrive_secs ?? Number.POSITIVE_INFINITY;
    const existingArrive = existing?.arrive_secs ?? Number.POSITIVE_INFINITY;
    if (!existing || rowArrive < existingArrive) {
      earliestByKey.set(key, row);
    }
  }

  return [...passthrough, ...earliestByKey.values()];
}

/**
 * Segunda optimización de fan-out, medida como necesaria contra Postgres
 * real (ver docs/handoff/03-algoritmo.md): `walk_edges` tiene 178,054 filas
 * sobre 11,362 paradas (~14 aristas de caminata por parada en promedio,
 * pero MUCHO más denso en corredores centrales — varias agencias con IDs
 * GTFS distintos en la misma esquina física, ver docs/handoff/02-grafo.md
 * sección 3.3). Sin acotar esto, la relajación de footpaths dentro de
 * RAPTOR explota: cada parada recién alcanzada abre otras ~14-30 paradas
 * caminables, que a su vez abren las suyas. Conservar solo las
 * `maxWalkEdges` aristas `walk` MÁS CERCANAS por expansión es una pérdida
 * de completitud aceptada y documentada (podría existir una alternativa
 * caminable ligeramente más lejana que fuera parte de la ruta óptima real)
 * a cambio de que el presupuesto de latencia sea alcanzable — el mismo
 * tipo de trade-off que ya aceptan los topes de radio/rondas del brief.
 */
/**
 * Agregado 2026-08-22: `maxWalkToEcobiciEdges` es un tope SEPARADO y más
 * chico, solo para aristas `walk` cuyo destino es una estación Ecobici (ver
 * config.ts#MAX_WALK_TO_ECOBICI_EDGES_PER_EXPANSION para la evidencia real
 * que lo justificó) — sin este tope aparte, esas aristas competían por los
 * mismos `maxWalkEdges` cupos que las aristas walk hacia otra parada GTFS,
 * pero cada estación Ecobici admitida es MÁS CARA de expandir (1-2 queries
 * extra, ver graph-client.ts), así que necesita su propio presupuesto, más
 * estricto.
 */
export function limitWalkFanout(
  rows: StopNeighborRow[],
  maxWalkEdges: number,
  maxWalkToEcobiciEdges: number
): StopNeighborRow[] {
  const nonWalk = rows.filter((r) => r.edge_type !== "walk");
  const walkToStop = rows
    .filter((r) => r.edge_type === "walk" && r.to_node_type === "gtfs_stop")
    .sort((a, b) => (a.distance_meters ?? Infinity) - (b.distance_meters ?? Infinity))
    .slice(0, maxWalkEdges);
  const walkToEcobici = rows
    .filter((r) => r.edge_type === "walk" && r.to_node_type === "ecobici_station")
    .sort((a, b) => (a.distance_meters ?? Infinity) - (b.distance_meters ?? Infinity))
    .slice(0, maxWalkToEcobiciEdges);
  return [...nonWalk, ...walkToStop, ...walkToEcobici];
}

/**
 * Tercera optimización de fan-out (agregada 2026-08-22 junto con el tramo
 * Ecobici, ver config.ts#MAX_BIKE_EDGES_PER_EXPANSION): `bike_edges` tiene
 * un fan-out promedio real de 393.9 aristas salientes por estación (máximo
 * medido: 545 — ver docs/handoff/02-grafo.md sección 9.6). Mismo criterio
 * que limitWalkFanout: conservar solo las `maxBikeEdges` aristas `bike` MÁS
 * CERCANAS por `distance_meters`. Se llama DESDE graph-client.ts (antes de
 * la consulta de disponibilidad — ver filterBikeAvailability), no desde
 * pruneNeighbors: para cuando pruneNeighbors corre en dijkstra.ts/raptor.ts,
 * las filas `bike` que llegan del fetcher YA vienen acotadas (pasan por
 * pruneNeighbors sin tocarse, igual que ya le pasa a 'ride'/'walk' entre sí
 * — cada optimización de fan-out solo toca su propio edge_type).
 */
export function limitBikeFanout(rows: StopNeighborRow[], maxBikeEdges: number): StopNeighborRow[] {
  const nonBike = rows.filter((r) => r.edge_type !== "bike");
  const bike = rows
    .filter((r) => r.edge_type === "bike")
    .sort((a, b) => (a.distance_meters ?? Infinity) - (b.distance_meters ?? Infinity))
    .slice(0, maxBikeEdges);
  return [...nonBike, ...bike];
}

/**
 * Filtra aristas `bike` por disponibilidad REAL en el momento de la
 * consulta (agregado 2026-08-22, ver docs/handoff/03-algoritmo.md) —
 * `ecobici_snapshots` en tiempo de consulta, no algo que el grafo
 * precalcule (sería un dato caduco en minutos, ver docs/handoff/02-grafo.md
 * sección 2). Función PURA y sin Postgres a propósito: recibe el mapa de
 * disponibilidad ya resuelto (graph-client.ts hizo la consulta batched
 * ANTES de llamar aquí) para poder seguir teniendo un test unitario sin
 * base de datos, igual que el resto de este archivo.
 *
 * Reglas (documentadas explícitamente, ver .claude/agents/algoritmo-ruteo.md):
 * - Fallar CERRADO: si no hay ninguna fila en el mapa para una estación
 *   (sin snapshot, o snapshot más viejo que
 *   WINDOW.ECOBICI_AVAILABILITY_MAX_AGE_SECS — ese filtro ya lo aplicó la
 *   query en graph-client.ts), esa estación se trata como SIN
 *   disponibilidad. Nunca se asume que sí hay bici/dock por falta de dato.
 * - Origen: se necesitan >= `minBikesAvailable` bicis. Si el origen no
 *   califica, NINGUNA arista `bike` de esta expansión es viable (no importa
 *   cuál sea el destino — sin bici que desanclar, no hay tramo).
 * - Destino: cada arista `bike` se evalúa POR SEPARADO contra
 *   `minDocksAvailable` en su propia estación destino — un origen con
 *   bicis puede tener 3 destinos con dock libre y 2 sin, y eso es
 *   información real, no un todo-o-nada.
 * - Las aristas `walk` NUNCA se filtran aquí (caminar hacia/desde una
 *   estación no requiere que haya bici ni dock — solo importa para
 *   decidir si se puede pedalear).
 */
export function filterBikeAvailability(
  rows: StopNeighborRow[],
  originStationId: string,
  availability: Map<string, EcobiciAvailability>,
  thresholds: { minBikesAvailable: number; minDocksAvailable: number }
): StopNeighborRow[] {
  const hasBikeEdges = rows.some((r) => r.edge_type === "bike");
  if (!hasBikeEdges) return rows;

  const origin = availability.get(originStationId);
  const originHasBike = origin !== undefined && origin.numBikesAvailable >= thresholds.minBikesAvailable;

  return rows.filter((row) => {
    if (row.edge_type !== "bike") return true;
    if (!originHasBike) return false;
    const destination = availability.get(row.to_node_id);
    return destination !== undefined && destination.numDocksAvailable >= thresholds.minDocksAvailable;
  });
}

/** Aplica las optimizaciones de fan-out de ride/walk en el orden correcto (dedupe primero, luego el tope de caminata). El tope de bici se aplica río arriba, en graph-client.ts — ver limitBikeFanout. */
export function pruneNeighbors(
  rows: StopNeighborRow[],
  maxWalkEdges: number,
  maxWalkToEcobiciEdges: number
): StopNeighborRow[] {
  return limitWalkFanout(dedupeRideEdges(rows), maxWalkEdges, maxWalkToEcobiciEdges);
}
