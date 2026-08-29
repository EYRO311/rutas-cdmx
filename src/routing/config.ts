/**
 * Topes de ventana espacial/temporal y constantes de configuración del
 * motor de ruteo. Todo lo que .claude/agents/algoritmo-ruteo.md exige que
 * esté documentado y nunca implícito vive en este único archivo.
 *
 * Restricción dura (CLAUDE.md decisión #7, brief de este agente): sin grafo
 * residente en memoria entre invocaciones. Estos topes existen precisamente
 * para acotar cuánto se carga a memoria DENTRO de una sola invocación.
 */

export const WINDOW = {
  /** Radio espacial por defecto alrededor de origen y destino, en metros. */
  SEARCH_RADIUS_METERS_DEFAULT: 5_000,
  /** Segundo intento (una sola vez) si no hay ruta viable a radio default. */
  SEARCH_RADIUS_METERS_RETRY: 8_000,
  /**
   * Radio de "acceso a pie" desde el punto exacto de origen/destino hasta la
   * primera/última parada. Deliberadamente MENOR que el radio de búsqueda:
   * el radio de búsqueda acota qué paradas son candidatas a formar parte del
   * grafo explorado, pero caminar mucho para llegar a la primera parada no
   * es realista. No está en .claude/agents/algoritmo-ruteo.md explícito —
   * es una decisión de este agente. Bajado de 1,200m a 800m tras medir
   * contra Postgres real: 1,200m en zona céntrica de CDMX (El Ángel)
   * devolvía 170 paradas candidatas de acceso — cada una se vuelve un label
   * semilla independiente, y con eso solo ya se consumía ~40% del
   * presupuesto de MAX_NODE_EXPANSIONS antes de abordar un solo viaje. Ver
   * MAX_ACCESS_STOPS abajo para el segundo tope que resuelve esto de raíz.
   */
  ACCESS_WALK_RADIUS_METERS: 800,
  /**
   * Tope duro de CUÁNTAS paradas de acceso se usan como semillas, sin
   * importar cuántas haya dentro de ACCESS_WALK_RADIUS_METERS (se toman las
   * más cercanas — getCandidateStops ya devuelve ordenado ascendente por
   * distancia). En zonas densas del centro de CDMX puede haber decenas de
   * paradas de agencias distintas en la misma esquina física (ver
   * docs/handoff/02-grafo.md sección 3.3, el hallazgo de IDs GTFS duplicados
   * en la misma coordenada); tratarlas todas como semillas independientes
   * es trabajo redundante, no cobertura real adicional.
   */
  MAX_ACCESS_STOPS: 12,
  /** Horizonte temporal por defecto desde la hora de salida, en segundos. */
  TIME_HORIZON_SECS_DEFAULT: 90 * 60,
  /** Horizonte extendido para perfil de salida (hasta 120 min). */
  TIME_HORIZON_SECS_PROFILE: 120 * 60,
  /** Tope duro de rondas RAPTOR = transbordos máximos. */
  MAX_ROUNDS: 6,
  /**
   * Tamaño de "chunk" de ventana temporal que se le pide a
   * graph_stop_neighbors en cada expansión de nodo (p_window_secs), acotado
   * además por el horizonte restante (nunca se pide más de lo que queda de
   * horizonte). 45 min balancea dos riesgos medidos: una ventana chica
   * puede no alcanzar a ver la siguiente salida de un trip de headway largo
   * (hay 2/1205 trips sin frequencies, con horario fijo, que podrían caer
   * fuera de una ventana más chica — límite conocido, documentado en el
   * handoff); una ventana grande genera más filas en generate_series por
   * cada expansión. Con headways típicos de CDMX (Metro/Metrobús: 3-10 min)
   * 45 min es holgado. No se pide todo el horizonte restante de una sola
   * vez para no volver cada expansión tan cara como la búsqueda completa.
   */
  EXPANSION_WINDOW_SECS: 45 * 60,
  /**
   * Salvaguarda adicional de latencia, NO pedida textualmente por
   * .claude/agents/algoritmo-ruteo.md pero necesaria en la práctica: medido
   * contra Postgres real, el universo de paradas candidatas dentro de 5 km
   * de origen Y destino en zona céntrica de CDMX puede superar las 3,000
   * paradas (medido: 2,991 para El Ángel -> Zócalo). Sin este tope, una
   * búsqueda multicriterio en una zona densa puede expandir miles de nodos
   * — cada uno una consulta real a `graph_stop_neighbors` — y violar el
   * presupuesto de p95 < 3s (criterio de aceptación, no aspiración, según
   * el brief). Al llegar a este tope, dijkstra.ts/raptor.ts dejan de
   * expandir más nodos y devuelven lo mejor encontrado hasta ese punto —
   * misma filosofía de "la respuesta se degrada, nunca se amplía sin
   * límite" que ya aplica al radio/horizonte/rondas. Ver
   * docs/handoff/03-algoritmo.md para la medición real de cuántas
   * expansiones toma un plan típico y por qué este número.
   */
  MAX_NODE_EXPANSIONS: 1200,
  /**
   * Tope de labels Pareto-óptimos que se conservan POR PARADA. En teoría el
   * conjunto Pareto-óptimo real puede crecer bastante (hasta ~7 solo por la
   * dimensión de transbordos); en la práctica, los labels con transbordos
   * altos y tiempo apenas mejor casi nunca son la respuesta que se le
   * muestra a un usuario. Se conservan los mejores `MAX_LABELS_PER_STOP`
   * por costo escalarizado (cost.ts#scalarCost) y se descartan el resto —
   * una segunda salvaguarda de latencia, independiente de MAX_NODE_EXPANSIONS
   * (esta acota el tamaño de las bolsas: menos bolsas grandes = menos
   * heap/cola y menos comparaciones de dominancia por inserción).
   */
  MAX_LABELS_PER_STOP: 4,
  /**
   * Tope de aristas `walk` que se relajan por expansión de nodo (las más
   * cercanas de todas las que devuelva `graph_stop_neighbors` — ver
   * relax.ts#limitWalkFanout). Necesario porque `walk_edges` es denso
   * (178,054 filas / 11,362 paradas) y sin este tope la relajación de
   * footpaths de RAPTOR explota en corredores con muchas paradas de
   * agencias distintas en la misma esquina física.
   */
  MAX_WALK_EDGES_PER_EXPANSION: 6,
  /**
   * Una vez que la búsqueda alcanza CUALQUIER parada candidata de destino,
   * no tiene caso seguir mapeando todo el radio de 5-8km — solo vale la
   * pena seguir buscando alternativas Pareto-óptimas (menos transbordos,
   * menos caminata, etc.) que lleguen dentro de esta franja de tiempo
   * extra después del primer arribo al destino. Pasada la franja, se
   * detiene la búsqueda por completo. Ver dijkstra.ts (donde el corte es
   * exacto, gracias al orden de la cola de prioridad) y raptor.ts (donde el
   * corte es aproximado: una ronda extra después de la primera vez que se
   * alcanza el destino).
   */
  EARLY_STOP_SLACK_SECS: 15 * 60,
  /**
   * Tope de cuántos labels alimentan la frontera de la SIGUIENTE ronda de
   * RAPTOR (raptor.ts), quedándose con los `MAX_FRONTIER_SIZE` mejores por
   * costo escalarizado. Sin este tope, medido contra Postgres real (ver
   * docs/handoff/03-algoritmo.md): la frontera crece ~2.3x por ronda en una
   * zona céntrica densa de CDMX (123 -> 285 -> 707 -> 1,680 -> 2,817 labels
   * en 5 rondas, El Ángel -> Zócalo) — crecimiento genuinamente exponencial
   * porque cada parada alcanzada puede reabrir docenas de rutas/caminatas
   * distintas, y `graph_stop_neighbors` no expone una tabla de
   * rutas/patrones que permita el escaneo por-ruta clásico de RAPTOR (ver
   * docs/handoff/02-grafo.md sección 3.5) para acotar el trabajo de otra
   * forma. Con este tope, el trabajo por ronda es O(MAX_FRONTIER_SIZE), así
   * que el total en el peor caso (agotando las 6 rondas) es acotado y
   * predecible. Es una pérdida de completitud documentada: se puede perder
   * un label Pareto-óptimo marginal que no estaba entre los mejores de su
   * ronda — mismo tipo de trade-off que MAX_LABELS_PER_STOP.
   */
  MAX_FRONTIER_SIZE: 200,
  /**
   * Velocidad asumida para convertir "distancia restante en línea recta
   * hasta el destino" en una penalización de segundos, usada SOLO como
   * heurística de orientación (goalBiasFn en index.ts) para decidir qué
   * labels conservar al aplicar MAX_LABELS_PER_STOP/MAX_FRONTIER_SIZE — no
   * para calcular ningún tiempo que se le muestre al usuario. Sin esta
   * heurística, medido contra Postgres real: podar por costo escalarizado
   * puro (sin noción de hacia dónde queda el destino) puede descartar
   * sistemáticamente las ramas que sí avanzan hacia el destino en favor de
   * ramas "baratas" que no llevan a ningún lado — El Ángel -> Zócalo con
   * poda ciega agotó las 6 rondas sin alcanzar el destino ni una vez. 6
   * m/s (~22 km/h) es una velocidad promedio optimista de transporte
   * urbano (más rápido que caminar, más lento que Metro sin paradas) — no
   * pretende ser una cota admisible estricta de A*, es una heurística
   * práctica de orientación, documentada como tal.
   */
  HEURISTIC_SPEED_MPS: 6,
  /**
   * Presupuesto de tiempo de PARED (no CPU) para toda la búsqueda dentro de
   * una invocación de `planRoute`, incluyendo el reintento a 8km si hace
   * falta — ver index.ts. MAX_NODE_EXPANSIONS acota por CANTIDAD de
   * expansiones, que es un proxy imperfecto de tiempo real (la latencia de
   * cada query a Postgres varía). Este tope es la salvaguarda directa y
   * precisa del criterio de aceptación real, "p95 < 3s en frío": 2,200ms
   * deja ~800ms de margen dentro del presupuesto total de 3s para el resto
   * del trabajo de una invocación (resolver candidatos de acceso/universo
   * antes de entrar al algoritmo, construir itinerarios al final — medido
   * en decenas de ms, no segundos — más margen real para overhead de cold
   * start que este benchmark local no puede medir, ver
   * docs/handoff/03-algoritmo.md). Medido contra Postgres real: sin este
   * tope, una consulta genuinamente sin cobertura (que agota los dos
   * intentos de radio sin encontrar el destino, así que nunca dispara el
   * corte temprano por destino) llegó a tardar 3.5-3.7s solo con el tope de
   * MAX_NODE_EXPANSIONS — por eso hace falta un tope de tiempo real además
   * del tope de expansiones. Con este tope activo, medido: p95 = 2.20-2.28s
   * (18 corridas mixtas, motor dijkstra) — ver handoff para la metodología
   * completa.
   */
  SEARCH_TIME_BUDGET_MS: 2_200,
  /**
   * Agregado 2026-08-22 (entregable de tramos en Ecobici, ver
   * docs/handoff/03-algoritmo.md). Tope de aristas `bike` que se relajan
   * por expansión de una estación Ecobici (las más cercanas por
   * `distance_meters` — ver relax.ts#limitBikeFanout). Necesario por la
   * misma razón que MAX_WALK_EDGES_PER_EXPANSION pero más urgente todavía:
   * medido contra Postgres real (docs/handoff/02-grafo.md sección 9.6), el
   * fan-out promedio de `bike_edges` es 393.9 aristas salientes por
   * estación (máximo real: 545). Sin este tope, una sola expansión de nodo
   * en una estación Ecobici dispararía cientos de relajaciones Y, peor,
   * inflaría el batch de `getEcobiciAvailability` a cientos de station_ids
   * en una sola query. 8 es el mismo orden de magnitud que
   * MAX_WALK_EDGES_PER_EXPANSION (6) — pérdida de completitud aceptada y
   * documentada, igual que esa: podría existir una estación destino
   * ligeramente más lejana que fuera parte de la ruta óptima real.
   */
  MAX_BIKE_EDGES_PER_EXPANSION: 8,
  /**
   * Agregado 2026-08-22, hallazgo real DURANTE la medición de este
   * entregable (ver docs/handoff/03-algoritmo.md, sección nueva): antes de
   * este tope, cualquier arista `walk` hacia una estación Ecobici competía
   * en igualdad de condiciones por los `MAX_WALK_EDGES_PER_EXPANSION` (6)
   * cupos de caminata de cada expansión — pero admitir una estación
   * Ecobici es MÁS CARO que admitir otra parada GTFS (cada una que
   * realmente se expanda paga 1-2 queries adicionales — ver
   * graph-client.ts#makeNeighborFetcher). Medido contra Postgres real: sin
   * un tope propio y más chico para "cuántas estaciones Ecobici nuevas se
   * admiten por expansión", El Ángel -> Zócalo (zona céntrica, densa en
   * Ecobici) pasó de encontrar ruta de forma confiable a fallar
   * (`no_coverage`) en ~1 de cada 3 corridas limpias de
   * `bench/run-one.ts` — el presupuesto de tiempo se diluía en ramas de
   * estaciones Ecobici que, con la disponibilidad real de este entorno (ver
   * sección nueva del handoff), casi nunca producían una arista `bike`
   * utilizable de todos modos. 2 (en vez de compartir el cupo de 6 con
   * paradas GTFS) recorta esa dilución sin eliminar la cobertura real: un
   * gtfs_stop que de verdad tiene una estación Ecobici cerca casi siempre
   * la tiene entre sus 1-2 más cercanas, así que 2 sigue siendo suficiente
   * para descubrir la mayoría de accesos reales a Ecobici — pérdida de
   * completitud documentada, mismo tipo de trade-off que
   * MAX_WALK_EDGES_PER_EXPANSION.
   *
   * Nota de calibración real: se probó primero en 2, medido contra
   * Postgres real con `bench/run-one.ts` (proceso nuevo por corrida, igual
   * metodología que el resto de este archivo): con 2, El Ángel -> Zócalo
   * seguía fallando (`no_coverage`) en ~2 de cada 6 corridas limpias —
   * mejor que sin tope (fallaba con más frecuencia) pero seguía
   * incumpliendo el presupuesto de forma inaceptable. Con 1: 12/12
   * corridas limpias encontraron ruta, típicamente agotando
   * MAX_NODE_EXPANSIONS (1200) en vez del deadline de tiempo — la señal de
   * que el presupuesto de expansión vuelve a gastarse mayormente en
   * avanzar hacia el destino, no en ramas Ecobici que caso siempre se
   * descartan por disponibilidad real. Ver docs/handoff/03-algoritmo.md
   * para la evidencia completa de esta calibración.
   */
  MAX_WALK_TO_ECOBICI_EDGES_PER_EXPANSION: 1,
  /**
   * Agregado 2026-08-22. Umbral de "qué tan reciente" debe ser la fila más
   * reciente de `ecobici_snapshots` para una estación para que su
   * disponibilidad se considere válida — más vieja que esto (o inexistente)
   * se trata como NO disponible (fallar cerrado, nunca asumir que sí hay
   * bici/dock). El cron de captura corre cada 5 min (ver CLAUDE.md decisión
   * #8 y docs/handoff/02-grafo.md sección 2) — 15 min (3x el ciclo) tolera
   * hasta dos corridas de cron perdidas consecutivas sin tratar el dato
   * como caduco. Más laxo que esto arriesgaría mostrarle al usuario una
   * bici/dock que en la práctica ya no está; más estricto arriesgaría
   * fallar cerrado en el hueco normal entre corridas de cron sin que haya
   * pasado nada realmente malo. No es una medición (no hay datos de cuánto
   * cambia la disponibilidad real minuto a minuto en este proyecto), es una
   * decisión de ingeniería explícita, documentada como tal.
   */
  ECOBICI_AVAILABILITY_MAX_AGE_SECS: 15 * 60,
  /**
   * Agregado 2026-08-22. Mínimo de bicis disponibles en la estación de
   * ORIGEN para aceptar una arista `bike` como viable en esta consulta.
   * Se decidió el umbral más simple y literal posible (0 bicis = no
   * viable, sin margen de seguridad adicional): agregar un margen (ej.
   * exigir >=2) requeriría datos reales de qué tan seguido el conteo del
   * snapshot se desincroniza de la realidad física (alguien toma la última
   * bici entre el snapshot y el momento real del viaje) — no hay esa
   * medición en este proyecto, e inventar un margen sin evidencia violaría
   * el mismo principio que ya aplica el resto de este archivo (no
   * inventar números sin evidencia real que los respalde).
   */
  MIN_BIKES_AVAILABLE: 1,
  /** Mismo razonamiento que MIN_BIKES_AVAILABLE, para docks libres en la estación de DESTINO. */
  MIN_DOCKS_AVAILABLE: 1,
} as const;

/**
 * Perfil de salida: cuántas salidas discretas se evalúan dentro de la
 * ventana [depart, depart + profileWindowSecs]. Cada salida evaluada corre
 * una búsqueda RAPTOR completa — esto multiplica el costo de CPU por
 * invocación (advertencia explícita del brief), así que se limita a un
 * muestreo, no a cada minuto.
 */
export const DEPARTURE_PROFILE = {
  DEFAULT_WINDOW_SECS: 60 * 60,
  /** Separación entre salidas muestreadas, en segundos. */
  SAMPLE_STEP_SECS: 15 * 60,
  /** Tope duro de muestras por perfil, independiente de la ventana pedida. */
  MAX_SAMPLES: 6,
} as const;

/** Defaults de user_preferences cuando no hay fila para el usuario (tabla vacía hoy, ver docs/handoff/02-grafo.md sección 3.4). */
export const USER_PREFERENCES_DEFAULTS = {
  walkingSpeedMps: 1.4,
  cyclingSpeedMps: 4.2,
  maxTransfers: 3,
  crowdingTolerance: 3,
  weightTime: 0.7,
  weightCost: 0.3,
} as const;

/**
 * Constantes de costo que NO tienen columna en user_preferences (ver
 * migrations/0010_user_tables.sql — solo existen weight_time/weight_cost).
 * Se agrupan aquí para que sean un único punto de verdad, nunca
 * hardcodeadas dentro de dijkstra.ts/raptor.ts/cost.ts. Ver
 * docs/handoff/03-algoritmo.md sección "Función de costo" para la
 * justificación de cada valor.
 */
export const COST_DEFAULTS = {
  transferPenaltySecs: 5 * 60,
  walkPenaltyMultiplier: 1.15,
  /** Segundos de penalización por abordaje a tolerancia de saturación neutra (3/5). */
  crowdingPenaltySecsBase: 60,
  /** Factor de circuidad, mismo valor documentado y usado por walk_edges (ver 02-grafo.md 3.3). */
  walkCircuityFactor: 1.3,
  /** Tarifa plana heurística en pesos por abordaje — NO hay fare_attributes/fare_rules en este GTFS. */
  flatFarePesosPerBoarding: 6,
} as const;
