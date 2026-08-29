/**
 * Tipos compartidos del motor de ruteo (Fase 3, agente `algoritmo-ruteo`).
 *
 * Contrato de entrada real: `graph_stop_neighbors(stop_id, fecha,
 * segundos_desde_medianoche, ventana_segundos)`, documentado en
 * docs/handoff/02-grafo.md secciones 3.5 y 8. No se reinterpreta aquí más
 * de lo que esa función ya garantiza.
 *
 * Agregado 2026-08-22 (ver docs/handoff/03-algoritmo.md, sección nueva):
 * `graph_bike_station_neighbors(station_id)` (docs/handoff/02-grafo.md
 * sección 9.5) expande vecinos DESDE una estación Ecobici — devuelve
 * `edge_type` `'bike'` (tramo pedaleado real, tiempo ya calculado) o
 * `'walk'` (acceso a pie desde la estación, mismo contrato que ya usa
 * `graph_stop_neighbors` para `'walk'`). graph-client.ts normaliza esas
 * filas a la MISMA forma `StopNeighborRow` para que relax.ts/dijkstra.ts/
 * raptor.ts no necesiten conocer dos contratos de datos distintos.
 */

/**
 * Tipo de arista. `ride`/`transfer`/`walk` vienen de `graph_stop_neighbors`;
 * `bike` viene de `graph_bike_station_neighbors` (agregado 2026-08-22).
 */
export type EdgeType = "ride" | "transfer" | "walk" | "bike";

/** Tipo de nodo en `walk_edges`/`bike_edges` (parada GTFS o estación Ecobici). */
export type NodeType = "gtfs_stop" | "ecobici_station";

/**
 * Fila normalizada de vecinos, ya sea de `graph_stop_neighbors` (ride,
 * transfer, walk desde una parada GTFS) o de `graph_bike_station_neighbors`
 * (bike, walk desde una estación Ecobici — graph-client.ts hace el mapeo).
 * Columnas exactas de docs/handoff/02-grafo.md secciones 3.5 y 9.5.
 */
export interface StopNeighborRow {
  edge_type: EdgeType;
  to_node_type: NodeType;
  to_node_id: string;
  trip_id: string | null;
  route_id: string | null;
  depart_secs: number | null;
  arrive_secs: number | null;
  distance_meters: number | null;
  /**
   * SOLO poblado para `edge_type === "bike"`: la duración YA calculada por
   * `bike_edges` (distancia con factor de circuidad ÷ velocidad mediana
   * medida de viajes reales — ver docs/handoff/02-grafo.md sección 9.2).
   * A diferencia de `walk`, donde el tiempo se sigue derivando de
   * `distance_meters` con la velocidad de `user_preferences` — bici usa un
   * tiempo YA calculado, no una constante ni una velocidad genérica. NULL
   * para ride/transfer/walk.
   */
  duration_secs: number | null;
}

/**
 * Disponibilidad real de una estación Ecobici en el momento de la consulta,
 * leída de la fila más reciente de `ecobici_snapshots` (agregado
 * 2026-08-22, ver docs/handoff/03-algoritmo.md). `capturedAt` permite
 * decidir "qué tan reciente es aceptable" en el punto de uso (graph-client.ts)
 * sin que este tipo tenga que saber el umbral.
 */
export interface EcobiciAvailability {
  numBikesAvailable: number;
  numDocksAvailable: number;
  capturedAt: Date;
}

/** Punto geográfico (lon/lat, WGS84 — mismo orden que ST_MakePoint). */
export interface LonLat {
  lon: number;
  lat: number;
}

/** Parada candidata cerca de un punto (origen/destino/frontera de ventana). */
export interface CandidateStop {
  stopId: string;
  stopName: string;
  lat: number;
  lon: number;
  distanceMeters: number;
}

/**
 * Pesos de la función de costo. Los que existen como columna real en
 * `user_preferences` (ver migrations/0010_user_tables.sql) se leen de ahí;
 * el resto son constantes de configuración documentadas en cost.ts porque
 * el esquema actual no tiene columnas para ellas (ver docs/handoff/03-algoritmo.md
 * sección "Función de costo" para la justificación completa). Nunca están
 * hardcodeadas dentro del algoritmo: siempre se pasan como parámetro.
 */
export interface CostWeights {
  /** De user_preferences.weight_time (default 0.7). */
  weightTime: number;
  /** De user_preferences.weight_cost (default 0.3). */
  weightCost: number;
  /** De user_preferences.walking_speed_mps (default 1.4 m/s ~ 5 km/h). */
  walkingSpeedMps: number;
  /** De user_preferences.max_transfers (default 3), acotado por el tope duro de 6. */
  maxTransfers: number;
  /** De user_preferences.crowding_tolerance, 1-5 (default 3). */
  crowdingTolerance: number;
  /**
   * Penalización de transbordo expresada en "segundos equivalentes" que se
   * suman al costo escalarizado de una etiqueta al abordar un viaje distinto
   * del anterior. No existe columna en user_preferences para esto — es una
   * constante de configuración (no hardcodeada dentro del algoritmo, se pasa
   * como parte de CostWeights). Default documentado en cost.ts.
   */
  transferPenaltySecs: number;
  /**
   * Multiplicador sobre el tiempo de caminata al escalarizar (el usuario
   * "odia" caminar bajo el sol más de lo que el tiempo puro sugiere, según
   * .claude/agents/algoritmo-ruteo.md). >1 = penaliza caminar más que ir
   * sentado en transporte.
   */
  walkPenaltyMultiplier: number;
  /**
   * Segundos equivalentes de penalización por abordaje, escalados por
   * `crowdingTolerance` (a menor tolerancia, mayor penalización). Proxy
   * estático: no hay fuente de datos de saturación por viaje futuro
   * planeado (ver limitaciones en el handoff).
   */
  crowdingPenaltySecsPerBoarding: number;
  /**
   * Tarifa plana estimada en pesos por abordaje de un tramo `ride`. No hay
   * fare_attributes/fare_rules en el GTFS de este proyecto (verificado: 0
   * archivos con la palabra "fare" en migrations/). Placeholder explícito,
   * no una tarifa real medida — ver limitaciones del handoff.
   */
  flatFarePesosPerBoarding: number;
}

/** Etiqueta multicriterio (Dijkstra/RAPTOR). Vector de Pareto = 4 criterios. */
export interface Label {
  stopId: string;
  /**
   * Tipo de nodo de `stopId` (agregado 2026-08-22). `"gtfs_stop"` para todo
   * lo sembrado por `window.ts#buildOriginLabels` y todo lo alcanzado vía
   * `graph_stop_neighbors`; `"ecobici_station"` cuando el label representa
   * haber llegado a una estación Ecobici (vía una arista `walk` o `bike`).
   * Determina qué función SQL se consulta al expandir este label —
   * ver graph-client.ts#makeNeighborFetcher.
   */
  nodeType: NodeType;
  /** Segundos desde medianoche del día de servicio en que se llega a stopId. */
  arrivalSecs: number;
  /** Transbordos acumulados (abordar un trip_id distinto del anterior). */
  transfers: number;
  /** Caminata acumulada, en segundos. */
  walkSecs: number;
  /** Costo monetario acumulado, en pesos (heurístico, ver flatFarePesosPerBoarding). */
  costPesos: number;
  /** trip_id del último tramo `ride` abordado, o null si el último tramo fue walk/transfer. */
  lastTripId: string | null;
  /** Puntero al label predecesor, para reconstruir el itinerario. Null en el origen. */
  parent: Label | null;
  /** Arista que produjo este label desde el parent (null en el origen). */
  viaEdge: {
    edgeType: EdgeType;
    tripId: string | null;
    routeId: string | null;
    departSecs: number | null;
    fromStopId: string;
    /** Distancia real de la arista (walk/bike), null para ride/transfer. Agregado 2026-08-22 junto con el tramo bike. */
    distanceMeters: number | null;
  } | null;
}

/** Un tramo de itinerario ya reconstruido, listo para serializar. */
export interface ItineraryLeg {
  mode: "walk_access" | "walk" | "transfer" | "ride" | "bike";
  /** null en el primer tramo (caminata desde el punto de origen, no una parada). */
  fromStopId: string | null;
  /** null en el último tramo si es caminata hacia el punto de destino exacto (no una parada). */
  toStopId: string | null;
  /** null solo en el primer tramo (walk_access desde el punto exacto de origen, no un nodo del grafo). Agregado 2026-08-22. */
  fromNodeType: NodeType | null;
  /** null solo en el último tramo si es walk_access hacia el punto exacto de destino. Agregado 2026-08-22. */
  toNodeType: NodeType | null;
  tripId: string | null;
  routeId: string | null;
  departSecs: number | null;
  arriveSecs: number | null;
  distanceMeters: number | null;
}

export interface Itinerary {
  legs: ItineraryLeg[];
  departSecs: number;
  arriveSecs: number;
  durationSecs: number;
  transfers: number;
  walkSecs: number;
  costPesos: number;
  /** Costo escalarizado usado para ordenar/comparar itinerarios (menor = mejor). */
  scalarCost: number;
}

export type PlanConfidence = "full" | "degraded_radius_8km" | "no_coverage";

export interface PlanResult {
  confidence: PlanConfidence;
  itineraries: Itinerary[];
  /** Metadatos de depuración/observabilidad, no forman parte del contrato de la API HTTP. */
  meta: {
    searchRadiusMeters: number;
    candidateOriginStops: number;
    candidateDestinationStops: number;
    expandedNodeCount: number;
    dbQueryCount: number;
    elapsedMs: number;
    /** true si la búsqueda se cortó por WINDOW.MAX_NODE_EXPANSIONS antes de agotar la cola/rondas — ver config.ts. */
    truncatedByExpansionCap: boolean;
  };
}

/**
 * Función que resuelve los vecinos de un NODO (parada GTFS o estación
 * Ecobici) dentro de una ventana. dijkstra.ts/raptor.ts dependen SOLO de
 * esta forma, no de `pg`/`Pool` directamente — permite inyectar un grafo
 * sintético en tests unitarios puros (sin Postgres) y, en producción, un
 * cierre sobre graph-client.ts + un Pool real y una fecha de servicio fija
 * por request.
 *
 * `nodeType` (agregado 2026-08-22) le dice a la implementación real
 * (graph-client.ts#makeNeighborFetcher) qué función SQL consultar:
 * `graph_stop_neighbors` para `"gtfs_stop"` (usa fromSecs/windowSecs) o
 * `graph_bike_station_neighbors` para `"ecobici_station"` (ignora
 * fromSecs/windowSecs — sus aristas son estáticas, no dependen de
 * horario). Se mantiene una sola firma para que dijkstra.ts/raptor.ts no
 * necesiten dos tipos de fetcher ni saber ellos mismos qué contrato de
 * datos corresponde a cada nodo.
 */
export type NeighborFetcher = (
  nodeId: string,
  nodeType: NodeType,
  fromSecs: number,
  windowSecs: number
) => Promise<StopNeighborRow[]>;

export interface PlanRequest {
  origin: LonLat;
  destination: LonLat;
  /** Fecha de servicio (YYYY-MM-DD), NO un Date con hora — graph_stop_neighbors espera DATE. */
  serviceDate: string;
  /** Segundos desde medianoche de la hora de salida deseada. */
  departSecs: number;
  userId?: string;
  /**
   * Horizonte temporal en segundos desde `departSecs`. Default
   * WINDOW.TIME_HORIZON_SECS_DEFAULT (90 min) si se omite.
   * `departure-profile.ts` pasa WINDOW.TIME_HORIZON_SECS_PROFILE (120 min)
   * explícitamente, tal como pide el brief para perfil de salida.
   */
  horizonSecs?: number;
}
