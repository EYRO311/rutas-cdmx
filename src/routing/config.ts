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
   * Agregado 2026-08-30 (ver docs/handoff/03-algoritmo.md, sección 12 —
   * hallazgo crítico de `qa-rutas`, commute largo real que daba `no_coverage`).
   * Velocidad usada por la heurística ADMISIBLE de A* que ahora ordena la
   * cola de prioridad de dijkstra.ts (`heuristicFn` en index.ts), a
   * diferencia de HEURISTIC_SPEED_MPS que solo ordena la PODA (qué labels
   * conservar), no la EXPANSIÓN. Son dos usos distintos con requisitos
   * distintos:
   *
   * - Poda (HEURISTIC_SPEED_MPS = 6 m/s): puede ser agresiva/no admisible —
   *   solo decide qué labels tirar cuando una bolsa/frontera se desborda, no
   *   afecta la optimalidad del resultado que sí se explora.
   * - Ordenamiento A* (esta constante): para que A* preserve EXACTAMENTE el
   *   mismo conjunto de rutas que el Dijkstra puro anterior (regla dura del
   *   proyecto: "primero correcto"), la heurística h(stop) = distancia en
   *   línea recta al destino / velocidad DEBE ser admisible = nunca
   *   sobreestimar el tiempo restante real. Como h estima TIEMPO (el criterio
   *   primario de la cola es arrivalSecs), subestimar tiempo = SOBREestimar
   *   velocidad: hay que dividir entre una COTA SUPERIOR de la velocidad
   *   efectiva en línea recta de CUALQUIER modo. El Metro de CDMX promedia
   *   ~36 km/h comercial (con paradas); en tramos rectos entre estaciones
   *   distantes su velocidad efectiva en línea recta puede acercarse a
   *   ~40-45 km/h, pero door-to-door (con esperas, transbordos y caminata de
   *   acceso, que solo SUMAN tiempo y por tanto solo ayudan a la
   *   admisibilidad) nunca la supera. 15 m/s (54 km/h) es una cota superior
   *   segura con margen: ningún tramo real de transporte de CDMX cierra
   *   distancia en línea recta más rápido que eso. Medido (ver handoff):
   *   con esta cota, el commute largo real (casa -> ESCOM, ~12.8km) pasa de
   *   `no_coverage` a encontrar ruta dentro del presupuesto, y El Ángel ->
   *   Zócalo sigue devolviendo la misma ruta. Bajar la velocidad daría una
   *   heurística más fuerte (más poda direccional) pero arriesgaría perder
   *   la ruta óptima (inadmisible) — no se hizo, por la regla dura de
   *   correctitud. Para nodos sin coordenadas conocidas baratas (estaciones
   *   Ecobici, ver index.ts) la heurística cae a 0, que siempre es una cota
   *   inferior válida (admisible) del tiempo restante.
   */
  ASTAR_ADMISSIBLE_SPEED_MPS: 15,
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
  /**
   * Agregado 2026-08-30 (ver docs/handoff/03-algoritmo.md sección 12 —
   * seguimiento del hallazgo crítico de `qa-rutas`, commute largo real que
   * daba `no_coverage`). Distancia recta origen-destino, en metros, a
   * partir de la cual `planRoute` cambia a un TIER de búsqueda distinto
   * (corredor + presupuesto extendido, ver `CORRIDOR_ELLIPSE_FACTOR`,
   * `MAX_NODE_EXPANSIONS_LONG_DISTANCE`, `SEARCH_TIME_BUDGET_MS_LONG_DISTANCE`
   * abajo) en vez del tier normal (dos burbujas de 5/8km, presupuesto de
   * 1200 nodos/2200ms).
   *
   * 6,000m se eligió con evidencia real, no a ojo: el caso más largo
   * probado ANTES de este hallazgo (Chapultepec↔Merced, sección 6 del
   * handoff) mide ~5.3km y sí converge dentro del tier normal — 6km deja
   * margen sobre ese caso para no desviar nada que ya funciona bien hacia
   * el tier extendido (más lento) sin necesidad. El caso que sí necesita el
   * tier extendido (casa→ESCOM) mide ~12.8km, muy por encima de este corte.
   */
  LONG_DISTANCE_THRESHOLD_METERS: 6_000,
  /**
   * Agregado 2026-08-30. Filtro de corredor (candidato (c) de
   * docs/handoff/08-qa.md sección 1.2): en vez de aceptar TODA parada
   * dentro de las dos burbujas de radio fijo (origen y destino
   * independientes), se descarta cualquier parada cuyo "desvío" real
   * (distancia recta a origen + distancia recta a destino) supere
   * `CORRIDOR_ELLIPSE_FACTOR` veces la distancia recta origen-destino — una
   * elipse con los dos puntos como focos. Sin este filtro, medido contra
   * Postgres real (docs/handoff/03-algoritmo.md sección 12): el universo de
   * paradas candidatas para casa→ESCOM (radio 8km) es de **7,002 paradas**
   * (re-medido 2026-08-30, coincide con la medición previa); aplicar este
   * filtro a factor 1.3 lo reduce a **3,820 paradas** (~45% menos)
   * manteniendo alcanzable un itinerario Pareto-óptimo real de 2 transbordos
   * (el motor devuelve camión local + circuito RTP + Metro L5, no la
   * combinación L7→L6→L5 que reportó el usuario, pero igual de válida — ver
   * handoff sección 12). NOTA de honestidad: una medición previa (intento
   * detenido, sin handoff) anotó "3,143 (55% menos)" para este mismo filtro;
   * ese número NO se reprodujo a factor 1.3 en la re-medición limpia de
   * 2026-08-30 (3,143 corresponde más bien a factor ~1.2: medido, 1.2 →
   * 3,054 paradas). Se conserva 1.3 como valor de envío (ver calibración
   * abajo), con el número real re-medido.
   *
   * Calibración real del factor (ver handoff sección 12): se eligió **1.3**,
   * no el mínimo empírico (~1.2), a propósito: 1.2 está cerca del punto de
   * ruptura para ESTE caso concreto — usarlo como default general
   * arriesgaría romper la optimalidad en otra geometría de ciudad no probada
   * aquí (ej. un commute con un desvío real ligeramente mayor). 1.3 da
   * margen de seguridad real (mismo principio de "cota con margen" que ya usa
   * `ASTAR_ADMISSIBLE_SPEED_MPS`), a cambio de más paradas candidatas —
   * aceptable porque el tier extendido ya no compite por el presupuesto de
   * 2,200ms del tier normal (ver `SEARCH_TIME_BUDGET_MS_LONG_DISTANCE`). Con
   * factor 1.3, casa→ESCOM converge de forma natural en 15,727 expansiones
   * (re-medido, ver MAX_NODE_EXPANSIONS_LONG_DISTANCE).
   *
   * Aplicado SOLO cuando la distancia recta origen-destino supera
   * `LONG_DISTANCE_THRESHOLD_METERS` — en viajes cortos las dos burbujas de
   * radio fijo casi se solapan por completo (el "desvío" de cualquier
   * parada candidata ya es cercano a 1x la distancia OD), así que el
   * filtro no aportaría nada y solo agregaría trabajo de cómputo puro sin
   * beneficio medible.
   */
  CORRIDOR_ELLIPSE_FACTOR: 1.3,
  /**
   * Agregado 2026-08-30. Tope de nodos expandidos para el TIER de distancia
   * larga (ver `LONG_DISTANCE_THRESHOLD_METERS`) — reemplaza a
   * `MAX_NODE_EXPANSIONS` (1,200) SOLO para esas consultas, nunca para el
   * tier normal (que sigue exactamente igual que antes de este cambio, sin
   * ninguna regresión de latencia para El Ángel↔Zócalo ni el resto de
   * casos ya medidos).
   *
   * IMPORTANTE — esto NO es el candidato (a) de docs/handoff/08-qa.md
   * sección 1.2 ("presupuesto escalado por distancia") que esa
   * investigación descartó: aquella medición fue SIN heurística admisible
   * de A* ni filtro de corredor, y encontró que hacían falta 33,602
   * expansiones/45.6s — inaceptable incluso como tier separado. Con AMBAS
   * optimizaciones activas (heurística A* + corredor 1.3, ver arriba), los
   * dos casos reales largos convergen de forma natural (corte por
   * agotamiento de cola, NO por este tope). Re-medido 2026-08-30 con proceso
   * nuevo por corrida (bench/run-one.ts): casa→ESCOM converge en **15,727
   * expansiones** (5/5 corridas, estable) y el segundo caso largo real
   * (casa→ESCOM entrada trasera, ecobici_primer_tramo_personal) en **16,914
   * expansiones** — ambos muy por encima del tope normal de 1,200 pero por
   * debajo de este tope. NOTA de honestidad: una medición previa (intento
   * detenido, sin handoff) había anotado 13,028 expansiones y fijado este
   * tope en 16,000; ese número NO se reprodujo en la re-medición limpia de
   * 2026-08-30 (el segundo caso truncaba en 16,000 exacto, perdiendo
   * completitud Pareto). Subido a **22,000** para dar ~30% de margen real
   * sobre la convergencia natural más alta observada (16,914), de modo que
   * AMBOS casos reales converjan de forma natural (truncatedByExpansionCap
   * = false) en vez de cortarse — "primero correcto, luego rápido". No
   * empeora la latencia de un caso que sí converge (para en la cola antes de
   * tocar este tope); solo acota un caso genuinamente sin cobertura, que de
   * todos modos queda gobernado por SEARCH_TIME_BUDGET_MS_LONG_DISTANCE. Ver
   * sección 12 del handoff para la medición completa y la conclusión
   * honesta: ni con esta combinación se cumple el presupuesto de p95 < 3s
   * para esta clase de consulta — se documenta como limitación conocida, no
   * se oculta ni se fuerza a pasar.
   */
  MAX_NODE_EXPANSIONS_LONG_DISTANCE: 22_000,
  /**
   * Agregado 2026-08-30. Equivalente de `SEARCH_TIME_BUDGET_MS` para el
   * tier de distancia larga. Medido contra Postgres real, proceso nuevo por
   * corrida (mismo método que bench/run-one.ts, handoff sección 12): con
   * heurística A* + corredor 1.3, casa→ESCOM converge de forma natural (no
   * truncado) en 15,727 expansiones y el segundo caso largo real en 16,914.
   * Re-medido limpio 2026-08-30: el tiempo de PARED de casa→ESCOM fue
   * **21.8s, 21.9s, 22.1s, 24.5s, 24.7s, 24.9s** (6 corridas), y el segundo
   * caso ~27.2s al converger natural. NOTA: un intento previo (detenido, sin
   * handoff) había anotado un rango mayor (25.4-42.6s) para el mismo caso;
   * esa variancia es jitter real de sistema/contención de E/S corriendo
   * corridas consecutivas contra el mismo Postgres local — no un artefacto
   * del algoritmo (igual que la sección 6 del handoff ya documentó para el
   * tier normal, amplificado aquí por ~13x más round-trips). La re-medición
   * limpia de 2026-08-30 quedó consistentemente en 21.8-27.2s, más baja y
   * estable que ese rango previo. Se conserva 60,000ms (60s) para dar margen
   * amplio sobre el peor caso observado incluso bajo alta contención, en vez
   * de dejar un tope que a veces corta la búsqueda justo antes de converger
   * — cortarla sería estrictamente peor que no tener tope (tiempo gastado
   * sin encontrar nada). Esto **incumple explícitamente el
   * criterio de aceptación p95 < 3s** para esta clase de consulta (viajes
   * >6km) — es una degradación deliberada y documentada (`PlanConfidence`
   * gana `"degraded_long_distance"`), no un descuido: el proyecto prioriza
   * encontrar una ruta real sobre cumplir el presupuesto cuando ambos son
   * honestamente incompatibles con la arquitectura actual (Dijkstra/A*
   * por-nodo contra Postgres, sin precómputo de tipo transfer-patterns/hub-
   * labeling — ver limitación nueva en el handoff). **Nota para
   * `api-http`/despliegue, no resuelta aquí**: 60s puede exceder el límite
   * de duración de una función serverless de Vercel según el plan
   * contratado (10s en el plan gratuito) — este agente no toca
   * configuración de despliegue, se deja anotado como limitación nueva.
   */
  SEARCH_TIME_BUDGET_MS_LONG_DISTANCE: 60_000,
  /**
   * Agregado 2026-08-30 (ver docs/handoff/03-algoritmo.md sección 13 —
   * hallazgo del orquestador: un viaje CORTO ~4.3km en corredor denso, bien
   * dentro del tier normal, daba `no_coverage` por agotar el tope de nodos).
   * Tope de nodos del FALLBACK DENSO: el reintento (mismo filtro de corredor
   * que el tier largo, pero para viajes cortos/medianos que el tier normal no
   * pudo resolver dentro de su presupuesto). Deliberadamente MUCHO más chico
   * que `MAX_NODE_EXPANSIONS_LONG_DISTANCE` (22,000): medido contra Postgres
   * real (sección 13), con el corredor aplicado los casos densos reales
   * convergen de forma natural en muy pocos nodos — Nápoles/Del Valle→Xoco en
   * ~1,440, Coyoacán centro→CU en ~538, Nápoles→Viveros en ~1,999. 4,000 da
   * ~2x de margen sobre el peor observado (1,999) para que converjan natural,
   * y acota el costo de un no_coverage genuino (que agota este tope sin
   * encontrar nada) a una fracción del tier largo. Ver también
   * `SEARCH_TIME_BUDGET_MS_DENSE_FALLBACK`.
   */
  MAX_NODE_EXPANSIONS_DENSE_FALLBACK: 4_000,
  /**
   * Agregado 2026-08-30. Presupuesto de tiempo de PARED TOTAL (desde el
   * inicio de la invocación, incluye los ~2.2s que ya gastó el tier normal
   * antes de caer al fallback) para el fallback denso. Medido (sección 13):
   * los casos densos reales convergen en ~4-8s de reloj de pared una vez
   * aplicado el corredor; 12s da margen para converger incluso con jitter de
   * E/S local, y acota el peor caso (no_coverage genuino) a ~12s en vez de
   * los 60s del tier largo. **Incumple igual el criterio p95 < 3s** para esta
   * clase de consulta (viaje corto en corredor denso) — degradación
   * deliberada y documentada (`plan_confidence: "degraded_dense"`), mismo
   * principio que el tier largo (sección 12): se prefiere devolver una ruta
   * real correcta a devolver `no_coverage` dentro del presupuesto. La causa
   * raíz (A*-por-nodo contra Postgres sin precómputo) y su solución real
   * (arquitectura tipo transfer-patterns/hub-labeling) es la misma que ya
   * documentó la sección 12.6 — no se resuelve en esta pasada.
   */
  SEARCH_TIME_BUDGET_MS_DENSE_FALLBACK: 12_000,
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
