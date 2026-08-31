# 03 — Algoritmo de ruteo (Fase 3, agente `algoritmo-ruteo`)

Todo lo descrito aquí se corrió de verdad contra el Postgres local (puerto
5433, base `rutas_cdmx`) poblado por `datos-gtfs` (Fase 1) y `modelo-grafo`
(Fase 2). Los números de esta sección son resultado real de correr el
motor completo (`src/routing/`) contra ese Postgres — con `vitest` para
los tests y un script de benchmark propio (`src/routing/bench/run-one.ts`)
para la latencia — no estimados ni inventados.

Entrada obligatoria leída: `docs/handoff/02-grafo.md` completo, más
`.claude/agents/algoritmo-ruteo.md` y `CLAUDE.md`. No se tocó nada fuera de
`src/routing/` y este documento.

## 1. Qué se construyó

Módulo `src/routing/` (14 archivos de código + `__tests__/` + `bench/`):

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | Tipos compartidos: `Label`, `StopNeighborRow`, `Itinerary`, `PlanRequest/Result`, `NeighborFetcher`. |
| `config.ts` | Único punto de verdad de TODOS los topes de ventana y constantes de costo — nunca hardcodeados en el algoritmo. |
| `labels.ts` | `dominates()` + `ParetoBag` (poda por dominancia de Pareto sobre las 4 dimensiones: tiempo, transbordos, caminata, costo). |
| `heap.ts` | Min-heap binario genérico (cola de prioridad de Dijkstra). |
| `relax.ts` | `relaxEdge()` — semántica de las 3 clases de arista (`ride`/`transfer`/`walk`) al pasar de un label a otro. `dedupeRideEdges()`/`limitWalkFanout()`/`pruneNeighbors()` — optimizaciones de fan-out (sección 4). |
| `cost.ts` | Función de costo configurable: `defaultCostWeights()`, `loadCostWeights(pool, userId)` (lee `user_preferences`), `scalarCost()`. |
| `graph-client.ts` | Único punto de contacto con Postgres: `getStopNeighbors` (llama `graph_stop_neighbors`), `getCandidateStops` (paradas cerca de un punto), `makeNeighborFetcher`. |
| `window.ts` | Resolución de ventana espacial (`resolveSearchUniverse`, `resolveAccessStops`), `buildOriginLabels`, `haversineMeters`. |
| `dijkstra.ts` | **Etapa 1 del brief**: Dijkstra multicriterio (Multi-Label Correcting). |
| `raptor.ts` | **Etapa 2 del brief**: RAPTOR por rondas, respetando horarios reales. |
| `itinerary.ts` | Reconstrucción de un `Label` final (cadena de `.parent`) a un `Itinerary` serializable, puerta a puerta. |
| `departure-profile.ts` | **Etapa 3 del brief**: perfil de salida, muestreo acotado de RAPTOR sobre una ventana de salidas. |
| `index.ts` | Entrada pública: `planRoute(pool, request, engine?)`. Orquesta resolución de ventana, motor de búsqueda, reconstrucción de itinerarios, degradación de `confidence`. |
| `bench/run-one.ts` | Script de medición de latencia (sección 6). |

`src/routing/__tests__/` — 13 archivos, 56 tests (sección 5).

## 2. Los dos motores

### 2.1 Dijkstra multicriterio (`dijkstra.ts`)

Multi-Label Correcting (MLC), literatura estándar de ruteo multicriterio:
cada parada mantiene una bolsa de labels Pareto-óptimos (`ParetoBag`) en
vez de una sola distancia mínima. La cola de prioridad global se ordena
por `arrivalSecs` (por eso sigue siendo "Dijkstra": nunca se reabre un
label ya extraído con mejor arribo). La poda real es dominancia de Pareto
sobre 4 criterios: tiempo de llegada, transbordos, caminata acumulada,
costo monetario.

**Complejidad**: con B = tamaño máximo de bolsa Pareto por parada (acotado
en la práctica por `WINDOW.MAX_LABELS_PER_STOP = 4`), es equivalente a
Dijkstra con hasta B labels por nodo: `O(B · E · log(B · V))` sobre el
subgrafo efectivamente explorado, donde V/E están acotados por la ventana
espacial y temporal — **nunca por el grafo completo** (no hay grafo
completo en memoria en ningún momento, CLAUDE.md decisión #7).

**Corte temprano por destino**: si se le pasa `targetStopIds` (que
`index.ts` siempre pasa), la búsqueda se detiene en cuanto la cola ha
agotado todos los labels con `arrivalSecs <= primer arribo a un destino +
WINDOW.EARLY_STOP_SLACK_SECS` (15 min). Como la cola procesa en orden
ascendente **estricto** de `arrivalSecs`, este corte es **exacto**: ningún
label mejor para ningún destino puede aparecer después de ese punto. Esta
es la propiedad que hace que Dijkstra termine notablemente más rápido y de
forma más predecible que RAPTOR en este proyecto (medido, sección 4).

### 2.2 RAPTOR por rondas (`raptor.ts`)

Adaptación de RAPTOR (Delling, Pajor, Werneck — *Round-Based Public
Transit Routing*) a multicriterio (variante conocida como McRAPTOR: bolsa
Pareto por parada en vez de un único mejor arribo) y al contrato de datos
real disponible: `graph_stop_neighbors` no expone una tabla de
rutas/patrones (el route-scanning clásico de RAPTOR necesita "para cada
ruta, para cada parada en orden, encontrar el trip más próximo
abordable"), expone aristas ya resueltas por salida concreta dentro de la
ventana pedida.

Cada ronda:
1. **Escaneo de viaje**: relaja aristas `ride`. Una ronda = un
   transbordo más — el criterio del brief. Como `graph_stop_neighbors` da
   un salto por fila (parada → siguiente parada del mismo trip), seguir
   sentado en el mismo vehículo varias paradas seguidas se **encadena**
   dentro del mismo escaneo (`scanTripsChained`, sin gastar ronda extra):
   se sigue relajando mientras el `trip_id` no cambie. Abordar un trip
   distinto sí espera a la ronda siguiente. **Esto fue un hallazgo real
   durante el desarrollo, no un diseño de primera pasada** — ver sección 4.
2. **Relajación de footpaths**: desde todas las paradas alcanzadas por el
   escaneo de viaje (intermedias y finales), relaja aristas
   `walk`/`transfer`. No consume ronda.

El tope de rondas (`weights.maxTransfers`, acotado siempre por el límite
duro `WINDOW.MAX_ROUNDS = 6`) bota el bucle externo. El límite **exacto**
de transbordos se sigue enforzando en cada arista individual dentro de
`relaxEdge` — el tope de rondas es una cota adicional de trabajo, no la
única salvaguarda de correctud.

**Complejidad por ronda**: `O(tamaño de frontera · costo de
graph_stop_neighbors)`, acotada por `WINDOW.MAX_FRONTIER_SIZE` (sección 4).

### 2.3 Por qué existen dos motores con resultados no siempre idénticos

Ambos leen el mismo `graph_stop_neighbors` y ambos respetan horarios
reales — la diferencia es la **estrategia de exploración**, no la fuente
de datos. Medido explícitamente (test `dijkstra y raptor coinciden en si
existe cobertura para el mismo caso`): para El Ángel → Zócalo, Dijkstra
encontró un itinerario de 1,238s (1 transbordo) y RAPTOR uno de 1,789s (1
transbordo) — **ambos válidos y Pareto-razonables**, pero no el mismo,
porque RAPTOR necesita las salvaguardas de fan-out (`MAX_FRONTIER_SIZE`,
sección 4) que pueden descartar una rama ligeramente mejor a cambio de
terminar dentro del presupuesto de latencia. Se documenta como limitación
conocida, no se oculta.

**`planRoute()` usa `dijkstra` como motor por defecto** (parámetro
`engine` opcional, `raptor` sigue disponible) — decisión de rendimiento
tomada con datos reales (sección 4), no de corrección: los dos están
completos, probados y disponibles como los dos entregables que pide el
brief.

## 3. Función de costo (`cost.ts`)

Los pesos **nunca están hardcodeados dentro del algoritmo** — siempre
llegan como parámetro `CostWeights`, cargado desde `user_preferences` vía
`loadCostWeights(pool, userId)` con fallback a defaults documentados si no
hay fila (la tabla está vacía hoy — 0 usuarios reales, ver
`docs/handoff/02-grafo.md` sección 3.4).

**Lo que sí tiene columna real en `user_preferences`** (migrations/0010):
`weight_time` (0.7), `weight_cost` (0.3), `walking_speed_mps` (1.4),
`max_transfers` (3, acotado siempre a `WINDOW.MAX_ROUNDS = 6`),
`crowding_tolerance` (3).

**Lo que NO tiene columna** (gap real de esquema, documentado explícito,
no un descuido): penalización de transbordo, multiplicador de caminata,
penalización de saturación, tarifa por abordaje. `user_preferences` la
diseñó `modelo-grafo` (Fase 2) antes de que existiera este agente.
Extenderla con esas columnas es trabajo legítimo de Fase 5
(`aprendizaje-beta`, que es quien ajusta estos pesos según CLAUDE.md), no
algo que le correspondiera decidir a esta fase. Mientras tanto viven como
constantes en `config.ts` (`COST_DEFAULTS`), pasadas explícitamente como
parte de `CostWeights` — nunca escritas dentro de `dijkstra.ts`/`raptor.ts`:

- `transferPenaltySecs = 300` (5 min equivalentes por transbordo).
- `walkPenaltyMultiplier = 1.15` (caminar pondera 15% más que ir sentado).
- `crowdingPenaltySecsBase = 60`, escalado por `crowding_tolerance` (a
  menor tolerancia, mayor penalización). **Proxy estático**: no hay fuente
  de datos de saturación para un viaje futuro planeado (GTFS-RT trae
  `occupancy_status`, pero es tiempo real de vehículos circulando *ahora*,
  no aplicable a planear un viaje a una hora futura arbitraria) —
  limitación conocida, no resuelta en esta fase.
- `flatFarePesosPerBoarding = 6`: **no hay `fare_attributes`/`fare_rules`
  en este GTFS** (verificado: 0 archivos con la palabra "fare" en
  `migrations/`). Es una tarifa heurística por abordaje, no una tarifa
  real medida — limitación explícita.

`scalarCost(label, weights, originDepartSecs)` combina las 4 dimensiones
en un escalar usado SOLO para ordenar/rankear (nunca para podar
Pareto-corrección) — ver sección 4 para cómo también se usa como
heurística de poda de rendimiento.

## 4. Topes de ventana implementados — y por qué cambiaron de los defaults

Todos viven en `src/routing/config.ts`, documentados ahí mismo con la
misma justificación que aquí (single source of truth).

| Tope | Valor final | Default del brief | Cambió por |
|---|---|---|---|
| Radio de búsqueda | 5 km, reintento a 8 km | 5/8 km | Sin cambio — tal cual el brief. |
| Horizonte temporal | 90 min (120 con perfil) | 90/120 min | Sin cambio. |
| Rondas RAPTOR / transbordos | 6 máx | 6 máx | Sin cambio. |
| Radio de acceso a pie | **800 m** | (no especificado) | Nuevo, ver abajo. |
| Paradas de acceso máx | **12** | (no especificado) | Nuevo, ver abajo. |
| Ventana de expansión SQL | **45 min** | (no especificado) | Nuevo, ver abajo. |
| Tope de nodos expandidos | **1,200** | (no especificado) | Nuevo, ver abajo. |
| Tope de labels por parada | **4** | (no especificado) | Nuevo, ver abajo. |
| Tope de aristas walk por expansión | **6** | (no especificado) | Nuevo, ver abajo. |
| Franja de gracia post-destino | **15 min** | (no especificado) | Nuevo, ver abajo. |
| Tope de frontera RAPTOR | **200** | (no especificado) | Nuevo, ver abajo. |
| Presupuesto de tiempo de pared | **2,200 ms** | (no especificado) | Nuevo, ver abajo. |

Los 4 primeros son los que pide el brief textualmente — se implementaron
sin cambios. **Los siguientes 7 no están en el brief ni en CLAUDE.md**:
aparecieron porque, al medir contra Postgres real, el brief no anticipaba
cuán denso es el grafo real de CDMX. Se documentan aquí con la evidencia
que los produjo, no como ajustes arbitrarios:

1. **Radio de acceso a pie (800 m) y tope de paradas de acceso (12)**:
   medido, un radio de 1,200 m alrededor de El Ángel (zona céntrica)
   devuelve **170 paradas candidatas** de acceso — cada una se vuelve un
   label semilla independiente. Sin acotar esto, solo sembrar los orígenes
   consumía ~40% del presupuesto de expansión antes de abordar un solo
   viaje. Se bajó el radio a 800 m (caminata de acceso realista, 5-10 min)
   y además se topa a las 12 más cercanas (ya vienen ordenadas por
   distancia desde SQL) — motivo real: en corredores densos hay paradas de
   agencias distintas en la misma esquina física (ver
   `docs/handoff/02-grafo.md` sección 3.3, el hallazgo de IDs GTFS
   duplicados en la misma coordenada), tratarlas todas como semillas
   separadas es trabajo redundante.

2. **Ventana de expansión SQL (45 min)**: cada llamada a
   `graph_stop_neighbors` pide una ventana `p_window_secs`. Un valor chico
   arriesga no ver la siguiente salida de los 2/1,205 trips sin
   `frequencies` (horario fijo); un valor grande genera más filas de
   `generate_series` por llamada. Con headways típicos de CDMX
   (Metro/Metrobús 3-10 min) 45 min es holgado sin ser costoso — medido:
   la misma parada concurrida (`B_05034A0-VASCQUIROG`) con ventana de 45
   min responde en 2ms, igual de rápido que con 20 min.

3. **`dedupeRideEdges` / `limitWalkFanout` (`relax.ts`)**: dos
   optimizaciones de fan-out sin pérdida de correctud, no toques de
   configuración sino de código.
   - Trips `frequencies`-based devuelven una fila por cada salida `k`
     dentro de la ventana, todas con el mismo `trip_id`. Medido: una
     ventana de 45 min sobre una parada concurrida devolvió **32 filas
     `ride` para solo 4 combinaciones `(to_node_id, trip_id)`
     distintas** — 8x de trabajo evitable, porque `relaxEdge` calcula
     transbordos/costo solo a partir de `trip_id`, así que solo la salida
     más temprana de cada combinación puede ser útil (domina
     estrictamente a las posteriores).
   - `walk_edges` es denso: 178,054 filas / 11,362 paradas. Sin acotar
     cuántas aristas `walk` se relajan por expansión, la relajación de
     footpaths de RAPTOR explota. `MAX_WALK_EDGES_PER_EXPANSION = 6`
     (las más cercanas) — pérdida de completitud documentada: podría
     existir una alternativa caminable ligeramente más lejana que fuera
     parte de la ruta óptima real.

4. **Encadenamiento de trips en RAPTOR (`scanTripsChained`)**: hallazgo
   real durante el desarrollo — con el escaneo de viaje "un salto por
   ronda" (primera versión), un camión de 10 paradas agotaba las 6 rondas
   completas **sin haber hecho ningún transbordo real**, porque cada hop
   consecutivo del MISMO trip contaba como una ronda. Corregido
   encadenando continuaciones del mismo `trip_id` dentro del mismo
   escaneo (sección 2.2) — cambió el resultado de "nunca llega al
   destino en 6 rondas" a "llega en 3 rondas" para El Ángel → Zócalo.

5. **Tope de nodos expandidos (1,200), tope de labels por parada (4),
   franja de gracia (15 min), tope de frontera RAPTOR (200), heurística de
   orientación (`goalBiasFn`, 6 m/s)**: medido, el universo de paradas
   candidatas dentro de 5 km de origen Y destino en zona céntrica de CDMX
   puede superar las **3,000 paradas** (medido: 2,991 para El Ángel →
   Zócalo). Sin topes, la frontera de RAPTOR crece de forma genuinamente
   exponencial (medido: 123 → 285 → 707 → 1,680 → 2,817 labels en 5
   rondas). `MAX_FRONTIER_SIZE` acota el trabajo por ronda a un tamaño
   fijo; como podar por costo puro (sin noción de hacia dónde queda el
   destino) puede descartar sistemáticamente las ramas que sí avanzan
   hacia el destino (medido: con poda ciega, El Ángel → Zócalo agotaba las
   6 rondas sin alcanzar el destino ni una vez), se agregó `goalBiasFn`
   — heurística de orientación tipo A* (distancia en línea recta al
   destino, convertida a segundos con una velocidad asumida de 6 m/s) que
   SOLO afecta qué labels se conservan al podar, nunca la corrección del
   resultado final.

6. **Presupuesto de tiempo de pared (2,200 ms) (`SEARCH_TIME_BUDGET_MS`)**:
   el tope de nodos es un proxy imperfecto de tiempo real (la latencia de
   cada query varía). Medido: una consulta genuinamente sin cobertura
   (agota los dos intentos de radio, 5 km y 8 km, sin encontrar el
   destino — así que nunca dispara el corte temprano por destino) llegó a
   tardar **3.5-3.7s** solo con el tope de nodos activo, por encima del
   presupuesto. Se agregó un deadline de tiempo de pared real,
   compartido entre el intento a 5 km y el reintento a 8 km (si el primer
   intento agota el presupuesto, el reintento corta casi inmediatamente en
   vez de gastar el doble de tiempo) — con esto, el peor caso medido bajó
   a ~2.2-2.3s (sección 6).

**Todas estas son pérdidas de completitud documentadas, no bugs
escondidos**: el motor puede, en redes muy densas, no encontrar la ruta
Pareto-óptima estricta y quedarse con una "suficientemente buena" dentro
del presupuesto — exactamente la filosofía de CLAUDE.md decisión #7 ("la
respuesta se degrada, nunca se amplía sin límite para forzar una
respuesta"), aplicada con más granularidad de la que el brief anticipaba
porque la evidencia real la pidió.

## 5. Tests — números reales

> Números de esta sección son del cierre original de esta fase
> (2026-08-17), antes de "Modo bici" (sección 11): **56** tests. Con bici
> integrado son **72** (sección 11.1) — mismos 11 archivos, sin archivos
> nuevos. Se deja la tabla original sin reescribir por valor histórico.

```
$ npx vitest run src/routing
 Test Files  11 passed (11)
      Tests  56 passed (56)
   Duration  ~22-23s
```

11 archivos en `src/routing/__tests__/`, 56 tests, **0 fallando**. Desglose:

| Archivo | Tests | Tipo |
|---|---|---|
| `labels.test.ts` | 7 | Puro (dominancia, ParetoBag) |
| `heap.test.ts` | 4 | Puro (MinHeap) |
| `relax.test.ts` | 10 | Puro (semántica de las 3 clases de arista, incluyendo el caso no obvio de `transfer.arrive_secs` como duración) |
| `cost.test.ts` | 7 | 5 puros + 2 contra Postgres real (`loadCostWeights`) |
| `itinerary.test.ts` | 5 | Puro (reconstrucción de cadena de labels) |
| `graph-client.test.ts` | 6 | Contra Postgres real (`graph_stop_neighbors`, `getCandidateStops`, `makeNeighborFetcher`) |
| `window.test.ts` | 4 | 2 puros + 2 contra Postgres real |
| `dijkstra.test.ts` | 4 | 3 sintéticos (grafo en memoria, deterministas) + 1 contra Postgres real |
| `raptor.test.ts` | 4 | 3 sintéticos + 1 contra Postgres real |
| `index.test.ts` | 4 | Contra Postgres real (`planRoute` end-to-end, casos con coordenadas reales de CDMX) |
| `departure-profile.test.ts` | 2 | Contra Postgres real (`planRouteProfile`) |

**Cada función pública tiene test unitario** (regla dura del brief):
`dominates`, `ParetoBag.tryInsert/trimToSize`, `MinHeap`, `relaxEdge`,
`dedupeRideEdges` (indirectamente vía comportamiento del motor),
`defaultCostWeights`, `loadCostWeights`, `scalarCost`,
`walkSecondsFromMeters`, `getStopNeighbors`, `getCandidateStops`,
`makeNeighborFetcher`, `resolveSearchUniverse`, `resolveAccessStops`,
`estimateWalkSecs`, `buildOriginLabels`, `haversineMeters`,
`dijkstraMultiCriteria`, `raptor`, `reconstructLegs`, `findRootLabel`,
`buildItinerary`, `planRoute`, `planRouteProfile`.

**Fecha de prueba real** (mismo criterio que `docs/handoff/02-grafo.md`
sección 5): `2025-06-16` (lunes), no la fecha de hoy — `calendar` cubre
mayormente 2024-12-01 a 2025-12-31, la fecha real de hoy (ver CLAUDE.md,
entorno de ejecución) queda fuera de ese rango para casi todos los
servicios y daría grafos vacíos por falta de servicio activo, no por un
bug del motor. Documentado en `src/routing/__tests__/db-pool.ts` para
quien retome esto.

**Casos de ejemplo con coordenadas reales de CDMX** (sustituto explícito
del banco de `qa-rutas`, ver sección 8): El Ángel (19.4270, -99.1677) →
Zócalo (19.4326, -99.1332), ~3.6km en línea recta, corredor Reforma/Centro
con Metrobús y Metro reales.

## 6. Latencia — mediciones reales, no estimadas

### Metodología

`src/routing/bench/run-one.ts` corre **un solo** `planRoute()` de punta a
punta y sale, diseñado para invocarse como **proceso nuevo por corrida**
(`npx tsx src/routing/bench/run-one.ts <lon1> <lat1> <lon2> <lat2>
<serviceDate> <departSecs> [engine]`) — así cada corrida paga abrir un
Pool de Postgres nuevo (sin conexión reutilizada de una corrida anterior),
igual que pagaría una invocación serverless real en frío (Vercel no
garantiza reusar el proceso ni el pool de conexiones entre invocaciones,
CLAUDE.md decisión #7).

**Qué SÍ mide**: el tiempo de pared completo de `planRoute()` — resolver
candidatos de acceso/universo, correr el motor de búsqueda, reconstruir
itinerarios — con una conexión a Postgres nueva por corrida.

**Qué NO mide, honestamente** (no se puede simular localmente sin
infraestructura de despliegue, que no es responsabilidad de esta fase):
el tiempo de arranque de un runtime serverless de Vercel (init de Lambda),
la latencia de red hacia el pooler de Supabase en producción (aquí es
Postgres local en el mismo equipo), ni el overhead de transpilación de
`tsx` en modo desarrollo (medido aparte: lanzar el proceso completo con
`tsx` añade ~3s de transpilación/carga de módulos ADICIONALES al número
reportado — un artefacto de la herramienta de desarrollo, no algo que
pague una función serverless compilada; se excluye del número reportado
midiendo desde la primera línea del script, después de que los imports ya
se resolvieron).

### Resultados

**18 corridas, motor `dijkstra` (el default de `planRoute`)**, mezclando 3
pares origen/destino reales (6 corridas cada uno): El Ángel↔Zócalo
(~3.6km, encuentra ruta), Centro Comercial Santa Fe↔Luis Murillo (~14.6km,
sin cobertura dentro de los topes — degradación esperada, no fallo),
Chapultepec↔Merced (~5.3km, encuentra ruta):

| Percentil | Latencia |
|---|---|
| min | 1,818.8 ms |
| p50 | 1,918.2 ms |
| p90 | 2,201.6 ms |
| **p95** | **2,201.8 ms** |
| p99 | 2,201.8 ms |
| max | 2,201.8 ms |

**Criterio de aceptación: p95 < 3s en frío → cumple, con margen real de
~800ms** (2,201.8ms medido vs 3,000ms del criterio).

**9 corridas adicionales, motor `raptor`** (mismos 3 pares, 3 corridas
cada uno): min 1,871.7ms, p50 2,200.7ms, p95/max 2,284.0ms — también
dentro del presupuesto, con más variabilidad (motivo: sección 2.3).

**Nota honesta sobre el patrón observado**: en los casos donde SÍ se
encuentra ruta, el motor generalmente termina tocando el tope de
`MAX_NODE_EXPANSIONS` (1,200) o el deadline de tiempo (2,200ms) antes de
agotar naturalmente la cola/rondas — es decir, **las salvaguardas de la
sección 4 están haciendo trabajo real, no son un techo teórico que nunca
se toca**. Esto es consistente con lo que se documenta ahí: sin ellas, la
misma consulta tardaba 8-28s (medido durante el desarrollo, antes de
aplicar las optimizaciones de fan-out y los topes).

## 7. Supuestos

- **Velocidad de caminata**: `user_preferences.walking_speed_mps` (default
  1.4 m/s ≈ 5 km/h) si hay fila de usuario, si no el mismo default —
  documentado en `docs/handoff/02-grafo.md` como pendiente de esta fase.
- **Factor de circuidad de caminata**: 1.3, el mismo que usó
  `modelo-grafo` para precalcular `walk_edges` — aplicado también a la
  caminata de acceso inicial/final (que no viene de `walk_edges`, viene de
  `ST_Distance` directo sobre `stops.geom`) para mantener consistencia
  metodológica.
- **Tarifa, penalización de transbordo, de caminata y de saturación**:
  constantes heurísticas documentadas (sección 3), no medidas.
- **Fecha de servicio**: el llamador de `planRoute` decide `serviceDate` —
  el motor no asume "hoy", que además está fuera de la vigencia real del
  feed (sección 5).
- **Un solo usuario real hoy** (CLAUDE.md decisión #4): `loadCostWeights`
  funciona correctamente con 0 filas en `user_preferences` (cae a
  defaults), probado explícitamente.

## 8. Limitaciones conocidas

1. ~~**Bicicletas (Ecobici) fuera de esta fase.**~~ **Superado 2026-08-22/23
   — ver sección 11.** `graph_bike_station_neighbors` (agregada por
   `modelo-grafo`, `docs/handoff/02-grafo.md` sección 9.5) sí resuelve el
   gap que describía este punto; `relaxEdge`/`pruneNeighbors` ya no ignoran
   `to_node_type = 'ecobici_station'`. Se deja el texto original tachado en
   vez de borrarlo para que quede el rastro de qué cambió y cuándo.
2. **AUTO no está intercalado** (CLAUDE.md decisión #3, regla dura del
   brief): el motor no resuelve tramos en auto. `modo-auto` (Fase 3, en
   paralelo) es responsable de eso.
3. **RAPTOR no es route-scanning clásico.** Ver sección 2.2 — es una
   adaptación honesta al contrato de datos disponible (aristas por salto,
   no por ruta/patrón), no la implementación de libro de texto de
   Delling/Werneck. Documentado explícitamente, no presentado como algo
   que no es.
4. **Pérdida de completitud Pareto bajo carga.** Sección 4: varios topes
   nuevos (labels por parada, frontera RAPTOR, fan-out de caminata) pueden
   descartar una alternativa técnicamente Pareto-óptima a cambio de
   cumplir el presupuesto de latencia. Es un trade-off deliberado y
   medido, no accidental.
5. **RAPTOR y Dijkstra pueden dar resultados distintos** para la misma
   consulta (sección 2.3) — ambos válidos, ninguno "más correcto", pero no
   intercambiables bit a bit.
6. **Heurística de orientación no admisible.** `goalBiasFn` (6 m/s
   asumidos) no es una cota admisible estricta de A* — es una heurística
   práctica que ayuda a la poda a no alejarse del destino, documentada
   como tal, no como garantía formal de optimalidad.
7. **Ecobici, tarifas reales, penalización de saturación real**: como
   constantes/gaps documentados en la sección 3, no resueltos aquí.
8. **No se corrió contra Supabase de producción** — todo esto se corrió
   contra Postgres local (puerto 5433), igual que las fases anteriores.
9. **`prisma migrate` sigue sin ser el mecanismo operativo** — no aplica a
   esta fase (no se creó ninguna tabla nueva; el trabajo de esta fase es
   cómputo puro sobre las tablas que ya dejó `modelo-grafo`).

## 9. Contrato esperado para `api-http` (Fase 3, en paralelo)

No implementé la API HTTP (fuera de mi alcance). Lo que expone
`src/routing/index.ts` para que `api-http` lo envuelva:

```ts
import { planRoute, type PlanRequest, type PlanResult } from "../routing/index.ts";
// o el path relativo que corresponda desde src/api/

const result: PlanResult = await planRoute(pool, {
  origin: { lon, lat },
  destination: { lon, lat },
  serviceDate: "YYYY-MM-DD",   // fecha de SERVICIO, no incluye hora
  departSecs: 28800,            // segundos desde medianoche
  userId: "opcional",           // si no hay fila en user_preferences, cae a defaults documentados
  horizonSecs: 5400,            // opcional, default 90 min (5400s)
}, "dijkstra");                 // opcional, default "dijkstra"; "raptor" también disponible

// result.confidence: "full" | "degraded_radius_8km" | "no_coverage"
// result.itineraries: Itinerary[] (0+ , ordenados por costo escalarizado ascendente, Pareto-podados)
// result.meta: { searchRadiusMeters, candidateOriginStops, candidateDestinationStops,
//                expandedNodeCount, dbQueryCount, elapsedMs, truncatedByExpansionCap }
```

- `pool` es un `Pool` de `pg` ya abierto — `api-http` decide cómo
  administrarlo por invocación (una conexión por request, no un pool
  persistente entre invocaciones serverless, mismo principio que
  `scripts/db.ts`).
- `PlanRequest.serviceDate` debe ser una fecha dentro de la vigencia real
  de `calendar` (sección 5) para obtener resultados útiles — si
  `api-http` recibe una fecha de "hoy" sin validar, el motor no falla,
  pero puede devolver `no_coverage` correctamente por falta de servicio
  activo (no es un bug que deba investigarse ahí).
  `PlanResult.confidence === "no_coverage"` es una respuesta válida y
  esperada, `api-http` debería mapearla a algo explícito para el cliente,
  no a un error 500.
- `result.meta.truncatedByExpansionCap` indica si el motor se topó con las
  salvaguardas de rendimiento (sección 4) — útil para observabilidad, no
  forma parte del contrato semántico de una ruta.
- `planRouteProfile(pool, request, windowSecs?, engine?)` en
  `src/routing/departure-profile.ts` expone el perfil de salida (etapa 3
  del brief) con la misma forma de request; devuelve `{ samples,
  bestItineraries, totalElapsedMs }`.

## 10. Criterio de terminado — estado real

**"Resuelve las rutas del banco de casos de `qa-rutas` con desviación
menor a 15%"**: el banco de casos (`tests/fixtures/rutas-reales.json`) no
existe todavía — `qa-rutas` es Fase 4, corre después de esta fase por
diseño (dependencia circular real del orden de fases, no un error de esta
fase; ver orden en `CLAUDE.md`). **Queda pendiente de validación cruzada
en Fase 4**, no incumplido por descuido. Lo que sí se hizo en su lugar,
como pide explícitamente el brief de esta tarea: tests unitarios reales
por cada función pública (sección 5), y casos de ejemplo razonables
construidos por este agente con origen/destino reales de CDMX contra datos
reales del grafo (sección 5 y 6).

**"Cumple p95 < 3s con arranque en frío medido (no estimado)"**: **cumple**
— p95 = 2,201.8ms sobre 18 corridas reales (motor `dijkstra`, default),
metodología documentada en sección 6, con la limitación honesta de que no
se pudo medir un cold start de Vercel real (infraestructura de despliegue
no existe todavía en este proyecto).

## 11. Modo bici (Parte 3/3) — agregado 2026-08-22/23, handoff cerrado 2026-08-28

Extiende esta fase ya cerrada (`CLAUDE.md` decisión #8, `PLAN.md` "Modo
bici"). Partes 1/3 (`datos-gtfs`, histórico real de viajes) y 2/3
(`modelo-grafo`, `bike_edges` + `graph_bike_station_neighbors`) ya estaban
aprobadas — ver `docs/handoff/01-datos.md` sección 7 y `02-grafo.md`
sección 9. Esto documenta la 3/3: usar esas aristas en el motor de
`src/routing/`.

El código de esta parte ya estaba escrito (Aug 22-23) cuando se retomó esta
sesión el 2026-08-28, pero **nunca se cerró el protocolo de handoff**: este
documento seguía sin mencionarlo (sección 8 punto 1 lo daba por fuera de
alcance) y `PLAN.md` seguía marcando la parte 3/3 como pendiente. Lo que
sigue es ese cierre, más tres problemas reales que aparecieron al
verificarlo de forma independiente y que no estaban documentados en
ningún lado.

### 11.1 Qué cambió en el motor

- **`types.ts`**: `EdgeType` gana `'bike'`; `NodeType` (`'gtfs_stop' |
  'ecobici_station'`) nuevo; `ItineraryLeg` gana `fromNodeType`/
  `toNodeType` — necesarios para que quien consuma un itinerario sepa si
  un `stopId` es una parada GTFS o una estación Ecobici (ver 11.3).
- **`graph-client.ts`**: `getBikeStationNeighbors` (envuelve
  `graph_bike_station_neighbors`), `getEcobiciAvailability` (lee
  `ecobici_snapshots` en tiempo de consulta, nunca precalculada — mismo
  principio que ya regía para GBFS), `getEcobiciStationCoords`,
  `getNearbyEcobiciStationIds`. `makeNeighborFetcher` despacha por
  `nodeType` del label: `gtfs_stop` → `graph_stop_neighbors` (como antes),
  `ecobici_station` → el flujo nuevo (vecinos → tope de fan-out →
  disponibilidad real → filtro).
- **`relax.ts`**: `relaxEdge` ya no descarta `to_node_type =
  'ecobici_station'`; caso nuevo para `edge_type === 'bike'` (duración YA
  calculada en `bike_edges`, no se deriva de velocidad de caminata).
  `limitBikeFanout`/`filterBikeAvailability` nuevas; `limitWalkFanout`
  gana un tope separado y más chico para caminata específicamente HACIA
  una estación Ecobici (`maxWalkToEcobiciEdges`).
- **`config.ts`**: `MAX_BIKE_EDGES_PER_EXPANSION` (8),
  `MAX_WALK_TO_ECOBICI_EDGES_PER_EXPANSION` (1, calibrado — ver 11.2),
  `ECOBICI_AVAILABILITY_MAX_AGE_SECS` (15 min), `MIN_BIKES_AVAILABLE`/
  `MIN_DOCKS_AVAILABLE` (1). Cada constante documentada in situ con la
  medición real que la justifica, mismo estilo que el resto del archivo.
- **`window.ts`**: `resolveSearchUniverse` agrega estaciones Ecobici
  cercanas a `allowedStopIds`; `dijkstra.ts`/`raptor.ts` aplican ese
  universo a AMBOS tipos de nodo (antes solo a `gtfs_stop`) — sin esto,
  una estación Ecobici alcanzada por `walk` desde cualquier parada
  explorada quedaba admitida sin restricción espacial, diluyendo
  presupuesto de búsqueda en ramas lejanas del corredor.
- **`index.ts`**: `goalBiasFn` (heurística de poda) ya no devuelve `0` para
  un `stopId` sin coordenadas conocidas (toda estación Ecobici, para no
  pagar una query extra por su ubicación) — devuelve un piso pesimista
  (`radiusMeters / HEURISTIC_SPEED_MPS`). Con `0`, una estación Ecobici
  parecía artificialmente mejor que una parada GTFS real en la poda de
  RAPTOR, y El Ángel→Zócalo pasó de encontrar ruta con RAPTOR de forma
  confiable a nunca encontrarla (6/6 corridas en `no_coverage`) — corregido
  con esto. `raptor` explícito recibe `maxWalkToEcobiciEdges: 0` (no
  tolera el fan-out real de Ecobici dentro del presupuesto medido);
  `dijkstra` (default de `planRoute`) sí lo tolera con el valor de
  `config.ts`.
- **56 → 72 tests** en `src/routing/__tests__/` (mismos 11 archivos de la
  sección 5, sin archivos nuevos — los casos de bici se agregaron dentro de
  los existentes). 0 fallando tras las correcciones de 11.2.

### 11.2 Flakiness real encontrada al verificar (2026-08-28) — causa y arreglo

Al correr `npx vitest run src/routing` para cerrar este handoff, la suite
falló — pero un test **distinto** en cada corrida (`no_coverage` en un
caso, 0 itinerarios en RAPTOR/Dijkstra desacordando en otro). Aislado, el
mismo test pasó 7/7 veces seguidas. Eso descarta un bug de lógica y apunta
a una condición de carrera real:

- `dijkstra.ts` corta la búsqueda con un deadline de **reloj de pared
  real** (`performance.now() + SEARCH_TIME_BUDGET_MS`, 2,200ms), no un
  contador de pasos — cuántos nodos alcanza a expandir antes de esa marca
  depende de la latencia real de cada query a Postgres.
- La integración de bici sube el costo por expansión (hasta 3 queries por
  nodo cerca de una estación Ecobici, contra 1 antes) — comiéndose un
  margen que ya era angosto (p95 medido = 2,201.8ms contra un presupuesto
  de 2,200ms, sección 6, **sin holgura**).
- **18 de los 21 archivos de test del repo** abren conexión real a
  Postgres contra el ÚNICO contenedor local (`rutas-db`, puerto 5433).
  Vitest corre archivos en paralelo por default — con contención real de
  conexiones/CPU entre archivos, la latencia de cada query varía lo
  suficiente para que la MISMA consulta a veces encuentre ruta dentro del
  presupuesto y a veces no.

**Arreglo**: `vitest.config.ts` nuevo en la raíz, `fileParallelism: false`
(serializa los archivos de test). Se prefirió sobre separar por
`projects` (unitarios en paralelo, contra-Postgres en serie) porque no hay
ninguna convención de nombre que distinga ambos tipos de test hoy —
separar habría significado mantener una lista de archivos a mano, con
riesgo real de que un test nuevo quede fuera y reintroduzca la flakiness
en silencio. Costo: la suite completa pasa de ~20s a ~32s (`src/routing`
solo). Verificado: 3 corridas limpias seguidas de `src/routing` (72/72) y
de la suite completa del repo (150/150) tras este cambio.

### 11.3 Gap real en `api-http` expuesto por esto (503, ya corregido)

Cerrar este handoff expuso que `real-router-engine.ts` (Fase 3, `api-http`,
aprobado ANTES de que existiera Ecobici) nunca se actualizó para el nuevo
`fromNodeType`/`toNodeType` de 11.1: `resolveStopRef` asumía que todo
`stopId` de un tramo era una parada GTFS y solo buscaba en `stops` —
cualquier itinerario con un tramo `walk`/`bike` que tocara una estación
Ecobici (nodo válido del grafo desde esta parte 3/3) tronaba con `Error:
parada 'X' referenciada... no encontrada en 'stops'`, que la capa HTTP
convertía en `503 ENGINE_UNAVAILABLE`. Se corrigió en `real-router-engine.ts`
resolviendo por `nodeType` contra `stops` o `ecobici_stations` según
corresponda (detalle completo en `docs/handoff/05-api.md` sección
agregada el mismo día). No es un bug de esta fase — es la consecuencia
esperable de extender el contrato de `ItineraryLeg` sin que el consumidor
de otra fase se enterara; se documenta aquí porque el síntoma solo aparece
al usar el motor con bici a través de la capa HTTP.

### 11.4 Ruta 100% a pie es un resultado real, no un caso degradado

Verificado al investigar el punto anterior: El Ángel→Zócalo en una fecha
sin NINGÚN servicio GTFS activo (`active_service_ids` devuelve 0-1
filas irrelevantes para el corredor) ya no da `no_coverage` — el motor
encuentra un itinerario real de 18 tramos, todos `walk`, ~61 min,
`plan_confidence: "full"`. Tres de esos tramos caminan a través de
estaciones Ecobici (295, 122, 115) como simples puntos de paso peatonales,
sin usar nunca un tramo `bike` — posible porque `graph_bike_station_neighbors`
expone caminata "hacia paradas GTFS u otras estaciones Ecobici cercanas"
(`02-grafo.md` sección 9.5, pensado para elegir una estación de respaldo
si la más cercana no tiene bicis), y eso densifica la red peatonal general
lo suficiente para cerrar un corredor que antes de esta parte no cerraba
dentro del presupuesto de saltos/tiempo.

**No se trató como bug.** La distancia/duración es físicamente plausible
(circuidad 1.3× aplicada por tramo, consistente con el resto del proyecto)
y el itinerario es honesto sobre sus modos (`transfers: 0`, ningún tramo
dice `ride`). La aserción vieja de `tests/api/routes.test.ts` ("fecha
fuera de vigencia → `no_coverage`") dependía de una propiedad accidental
del grafo peatonal más disperso de antes de esta parte, nunca fue una
garantía de diseño — se corrigió la aserción para reflejar el
comportamiento real (200, ruta real, `plan_confidence: "full"`, ningún
tramo `ride`) en vez de cambiar el motor.

**Idea evaluada y explícitamente diferida** (no implementada): exponer una
señal separada de "¿esta ruta usó algún tramo de transporte real
programado?" para que un cliente no confunda `plan_confidence: "full"` con
"hay transporte público corriendo" cuando en realidad el usuario tendría
que caminar la hora completa. Es una decisión de contrato de API, no un
bug del motor — se deja anotada para quien retome `api-http` o abra Fase 4
(`qa-rutas`, que sí necesita distinguir estos casos para medir desviación
contra viajes reales del usuario).

## 12. Commutes largos — tier de distancia larga (agregado 2026-08-30)

Seguimiento del **hallazgo crítico de `qa-rutas`** (`docs/handoff/08-qa.md`
sección 1.1/1.2): el commute real del usuario `casa_escom_pico`
(Río Becerra 129 → ESCOM/Zacatenco, ~12.8 km en línea recta) daba
`no_coverage` con el tier normal. `qa-rutas` ya había descartado con
mediciones el candidato (a) "subir presupuesto a secas" — 45.6 s / 33,602
expansiones a 50k nodos, inaceptable. Esta sección es la respuesta de
`algoritmo-ruteo`. **Todo lo de abajo se corrió de verdad contra el
Postgres local (5433), fecha de servicio `2025-06-16`, salida 15:00
(54000 s), método `bench/run-one.ts` (proceso nuevo por corrida) — no
estimado.**

> Nota de procedencia: hubo un intento previo de esta tarea (detenido por
> el usuario, sin handoff). Dejó código en `src/routing/` sin commitear y
> comentarios de `config.ts` con números que **no se reprodujeron** en la
> re-medición limpia de esta pasada. Este agente verificó el código de
> forma independiente, **corrigió los números que no reproducían** (ver
> 12.5) y midió todo de nuevo. Los números de abajo son los medidos por
> este agente el 2026-08-30, no los heredados.

### 12.1 Decisión y por qué

Se implementó una **combinación de (b) + (c) con enrutamiento por tiers de
distancia**, no una sola de las opciones sueltas de `08-qa.md` 1.2:

- **(b) Heurística admisible de A*** — ordena la *expansión* (la cola de
  prioridad de `dijkstra.ts`) por `f = g + h`, con `h(stop) = distancia
  recta al destino / ASTAR_ADMISSIBLE_SPEED_MPS`. Distinta de la heurística
  de poda `goalBiasFn` (6 m/s, no admisible, solo ordena qué labels tirar).
  La admisibilidad se garantiza dividiendo entre una **cota superior** de la
  velocidad efectiva en línea recta de cualquier modo de CDMX (15 m/s =
  54 km/h; ningún tramo real cierra distancia recta más rápido, ni el Metro
  door-to-door). Al ser `h` admisible, A* explora **exactamente el mismo
  conjunto Pareto** que el Dijkstra puro anterior — cero pérdida de
  correctitud, solo poda direccional (regla dura "primero correcto"). Para
  nodos sin coordenadas baratas (estaciones Ecobici) `h = 0`, cota inferior
  trivialmente válida.
- **(c) Filtro de corredor elíptico** — descarta toda parada cuyo desvío
  (dist. recta a origen + a destino) supere `CORRIDOR_ELLIPSE_FACTOR × d_OD`
  (elipse con O/D como focos). Reduce el universo candidato sin tocar la
  ruta óptima. Medido (re-medido 2026-08-30): universo a 8 km = **7,002
  paradas**; con factor 1.3 → **3,820** (~45% menos). Se eligió 1.3, no el
  mínimo empírico (~1.2 → 3,054), por margen de seguridad ante geometrías no
  probadas.
- **Enrutamiento por tier de distancia** (`index.ts#planRoute`): si
  `d_OD > LONG_DISTANCE_THRESHOLD_METERS` (6 km) se usa
  `attemptLongDistancePlan` (va directo a 8 km, aplica corredor, presupuesto
  extendido, confidence `degraded_long_distance`); si no, el tier normal
  queda **byte a byte igual** que antes (mismo presupuesto 1,200/2,200 ms,
  mismos casos, cero regresión — verificado, 12.4).

**Por qué NO (a) solo:** ya descartado por `qa-rutas` con medición. Este
tier extendido NO es (a): con (b)+(c) activos, casa→ESCOM converge de forma
natural (agota la cola, no el tope) en **15,727 expansiones** — 2.1× menos
que las 33,602 de (a) puro — aunque sigue muy por encima del tope normal de
1,200.

**Por qué NO (d) (transfer patterns / hub labeling):** es la técnica de
producción correcta para ciudades grandes, pero exige **precómputo
persistente** (etiquetas/patrones por par de paradas) que choca de frente
con la arquitectura del proyecto (CLAUDE.md #7: sin grafo residente, se
consulta un subgrafo acotado por invocación). Montar ese precómputo es un
proyecto en sí (una tabla nueva y su ETL, del tamaño de una fase completa),
no un cambio de `src/routing/`. Se documenta como el camino real para bajar
la latencia del tier largo por debajo de 3 s en el futuro — ver 12.6.

### 12.2 Cambios en `src/routing/`

- **`config.ts`**: `ASTAR_ADMISSIBLE_SPEED_MPS` (15), `LONG_DISTANCE_THRESHOLD_METERS`
  (6,000), `CORRIDOR_ELLIPSE_FACTOR` (1.3), `MAX_NODE_EXPANSIONS_LONG_DISTANCE`
  (**22,000**, ver 12.5), `SEARCH_TIME_BUDGET_MS_LONG_DISTANCE` (60,000).
  Cada uno documentado in situ con su medición real.
- **`dijkstra.ts`**: acepta `heuristicFn` (cota inferior de tiempo) y ordena
  la cola por `f = arrivalSecs + h`. El corte por destino ahora usa `f` en
  vez de `arrivalSecs` puro (sigue exacto: con `h` admisible, `f` es cota
  inferior del arribo al destino). Acepta `maxNodeExpansions` para
  sobreescribir el tope solo en el tier largo. Con `h = 0` (default) es
  idéntico al Dijkstra anterior.
- **`raptor.ts`**: acepta `heuristicFn` (lo ignora a propósito — es
  round-based, no tiene cola global) y `maxNodeExpansions`. Sin cambio de
  comportamiento en el default.
- **`window.ts`**: `applyCorridorFilter(universe, origin, destination,
  factor)` — puro, reutiliza coordenadas ya traídas; nunca excluye estaciones
  Ecobici (sin coords conocidas).
- **`index.ts`**: `planRoute` bifurca por `d_OD`; `attemptLongDistancePlan`
  nuevo; `heuristicFn` construido junto a `goalBiasFn`.
- **`types.ts`**: `PlanConfidence` gana `"degraded_long_distance"`.
- **Tests (`__tests__/`)**: `72 → 79`. Nuevos: `applyCorridorFilter` (4
  puros), `maxNodeExpansions` en dijkstra y raptor (2), `planRoute`
  end-to-end del commute largo real (1, contra Postgres).

### 12.3 Evidencia — el caso real ahora SÍ resuelve

`casa_escom_pico`, medido (6 corridas limpias, proceso nuevo por corrida):

| Métrica | Antes (tier normal) | Ahora (tier largo) |
|---|---|---|
| `confidence` | `no_coverage` | `degraded_long_distance` |
| Itinerarios | 0 | **1** |
| Expansiones | 1,200 (tope, truncado) | **15,727** (convergió natural, `truncatedByExpansionCap=false`) |
| Wall time | ~2.2 s (agotado sin ruta) | 21.8 / 21.9 / 22.1 / 24.5 / 24.7 / 24.9 s |

**Itinerario devuelto** (verificado tramo a tramo): 66.2 min door-to-door
(depart 54000 → arrive 57974), 2 transbordos, caminata 4.4 min, $18. Cadena
real: caminata → **camión local** (ruta `B_051013A000_1`, ~18 paradas
encadenadas sin gastar transbordo) → caminata 39 m → **circuito RTP**
(`B_010020A000_0`) → caminata 37 m → **Metro L5** (Misterios → La Raza →
Autobuses Nte → Inst. del Petróleo → Politécnico) → caminata al destino.
Es una combinación **distinta** de la que reportó Emiliano (Metro
L7→L6→L5) pero Pareto-válida y con los mismos 2 transbordos. 66 min vs
80 min reales = ~17% más rápido (lado optimista, fuera del ±15%) — esperable:
combinación de modos distinta y el motor subestima esperas. La comparación
tipo-2 tramo a tramo queda para `qa-rutas`.

Segundo caso largo real (`ecobici_primer_tramo_personal`, ~13.5 km):
`degraded_long_distance`, **6 itinerarios**, converge natural en **16,914
expansiones**, ~23.6 s.

### 12.4 Latencia re-medida — ambos tiers, mismo método

**Tier normal (viajes ≤ 6 km) — criterio p95 < 3 s: SÍ CUMPLE.**
18 corridas, proceso nuevo por corrida, mezclando El Ángel↔Zócalo (~3.6 km)
y Chapultepec↔Merced (~5.3 km), todas `full`, todas con itinerario:

| Percentil | Latencia |
|---|---|
| min | 2,188.4 ms |
| p50 | 2,201.8 ms |
| p95 | **2,202.7 ms** |
| max | 2,202.7 ms |

Idéntico (dentro del ruido) al p95 aprobado antes de este cambio
(2,201.8 ms, sección 6). El tier normal no cambió; el enrutamiento por
distancia solo desvía viajes > 6 km. **Cero regresión.**

**Tier largo (viajes > 6 km) — criterio p95 < 3 s: NO CUMPLE, a propósito.**
casa→ESCOM: 21.8–24.9 s (6 corridas); segundo caso: ~23.6 s. Es **~10×**
por encima del presupuesto. Es una **degradación deliberada y explícita**
(`confidence = "degraded_long_distance"`, nunca `full`), no un descuido: el
proyecto prioriza devolver una ruta real correcta sobre cumplir el
presupuesto cuando ambos son honestamente incompatibles con la arquitectura
actual (A* por-nodo contra Postgres, sin precómputo). **No se ocultó ni se
forzó a pasar.**

### 12.5 Topes de configuración cambiados en esta pasada (con justificación)

- **`MAX_NODE_EXPANSIONS_LONG_DISTANCE`: el intento previo lo dejó en 16,000
  citando convergencia en "13,028 expansiones" (~23% margen). Ese número NO
  se reprodujo.** Re-medición limpia: casa→ESCOM converge en 15,727 y el
  segundo caso en **16,914** — con el tope en 16,000, el segundo caso
  **truncaba** (perdía completitud Pareto, `truncatedByExpansionCap=true`).
  Subido a **22,000** (~30% margen sobre 16,914) para que **ambos** casos
  reales converjan de forma natural. No empeora la latencia de un caso que
  converge (para en la cola antes del tope); un caso genuinamente sin
  cobertura queda gobernado por el tope de tiempo (60 s).
- **`CORRIDOR_ELLIPSE_FACTOR` = 1.3 (sin cambio de valor, número corregido):**
  el comentario previo decía "7,002 → 3,143 (55% menos)"; a factor 1.3 la
  re-medición da **3,820 (~45% menos)** (3,143 corresponde a ~1.2 → 3,054).
  Valor de envío 1.3; comentario de `config.ts` corregido.
- **`SEARCH_TIME_BUDGET_MS_LONG_DISTANCE` = 60,000 (sin cambio):** el
  comentario previo citaba variancia 25.4–42.6 s; la re-medición limpia dio
  21.8–27.2 s, más baja y estable. 60 s conserva margen amplio; comentario
  corregido.
- Tier normal (`MAX_NODE_EXPANSIONS` 1,200, `SEARCH_TIME_BUDGET_MS` 2,200):
  **sin tocar.**

### 12.6 Limitaciones nuevas (no ocultas)

1. **El tier largo incumple p95 < 3 s (~22–25 s medido).** Es el límite real
   de A*-por-nodo contra Postgres sin precómputo. Bajarlo de verdad exige
   arquitectura (d) (transfer patterns / hub labeling con una tabla
   precalculada) — trabajo de otra fase, no de `src/routing/`.
2. **`SEARCH_TIME_BUDGET_MS_LONG_DISTANCE` = 60 s puede exceder el límite de
   duración de función serverless de Vercel** (10 s en plan gratuito). Este
   agente **no toca configuración de despliegue** — se reporta para
   `api-http`/despliegue: un viaje > 6 km puede necesitar cola asíncrona,
   plan de Vercel con timeout mayor, o el precómputo de (d). **Sin resolver
   aquí.**
3. **La comparación tipo-2 (desviación < 15% vs tiempo real)** de los 2
   commutes reales sigue sin poder automatizarse: el motor devuelve una
   combinación de modos distinta a la reportada por el usuario. Queda para
   `qa-rutas`.
4. **Umbral de 6 km y factor 1.3 calibrados sobre 2 geometrías reales**
   (ambas del mismo corredor SO→N de la ciudad). Otras geometrías largas
   (E↔O, radiales distintas) no se probaron — el margen de 1.3 y del tope de
   22,000 existe justamente para absorber esa variación, pero no está medido
   fuera de este corredor.
5. **Contención de un solo Postgres local:** cada caso largo son
   ~15,000–17,000 round-trips reales; correr varios seguidos contra
   `rutas-db` deja contención residual que puede tumbar pruebas cortas
   sensibles a latencia inmediatamente después. Mitigado moviendo los casos
   largos al final de `tests/qa/rutas-reales.test.ts`; persiste como límite
   conocido de compartir un Postgres local (misma clase que sección 11.2).
   La suite completa pasa estable: **172 passed | 4 skipped** (2 corridas
   limpias consecutivas; antes de esta pasada: 165 | 4).

## 13. Viajes CORTOS en corredor denso — fallback adaptativo (agregado 2026-08-30)

Seguimiento de un hallazgo **NUEVO y distinto** del de la sección 12 (no es
el commute largo). El orquestador, probando la API en campo, encontró un
viaje **corto (~4.3 km en línea recta)**, bien dentro del "tier normal"
(≤6 km) que la sección 12.4 declaró "cero regresión", que da `no_coverage`
por agotar el presupuesto. **Todo lo de abajo se corrió contra el Postgres
local (5433), método `bench/run-one.ts` (proceso nuevo por corrida), no
estimado.**

### 13.1 El caso reproducido (evidencia independiente)

```
origen:  lat 19.3965429, lon -99.1796546  (Nápoles/Del Valle, Benito Juárez)
destino: lat 19.3606341, lon -99.1648403  (Xoco — Cineteca Nacional)
salida:  2025-06-16T08:00 (28800 s), fecha dentro de la vigencia real del calendar
```

Reproducido 3/3 **antes** de tocar código (`d_OD` medido = **4,285 m**, tier
normal): `no_coverage`, `searchRadiusMeters:8000` (ya reintentó a 8 km),
`expandedNodeCount` 1014–1280, `elapsed_ms` ~2,200–2,260,
`truncatedByExpansionCap:true`. Confirmado el reporte del orquestador.

Densidad del corredor (medida): **2,431 paradas** dentro de 5 km,
**5,132** dentro de 8 km.

### 13.2 La hipótesis del brief (heurística A* en el tier normal) — probada y REFUTADA

El brief pedía probar aplicar `heuristicFn` (la heurística A* admisible de la
sección 12) también al tier normal. **Hallazgo #1: ya estaba aplicada al tier
normal** — `attemptPlan` (index.ts) construye y pasa `heuristicFn` en
`searchParams` de forma incondicional, para ambos tiers, desde la sección 12.
La premisa del brief ("el tier normal sigue llamando a Dijkstra con h = 0")
no corresponde al código actual. Verificado además midiendo con la heurística
forzada a `h=0` vs activa.

**Hallazgo #2 (medido, con presupuesto generoso 60 s / 60 k nodos para forzar
convergencia): la heurística casi no ayuda en este corredor.**

| Config (radio 5 km, presupuesto generoso) | Expansiones para converger | Itinerarios |
|---|---|---|
| Heurística A* **OFF** (h=0) | 10,437 | 4 |
| Heurística A* **ON** | 9,718 | 4 |
| Heurística A* ON **+ filtro de corredor 1.3** | **1,440** | 2 |

La heurística sola reduce ~7 % las expansiones — **no** basta (9,718 sigue
siendo ~8× el tope normal de 1,200). El **filtro de corredor** es la palanca
real: 9,718 → **1,440** (–85 %). Nota: el corredor pasa de 4 a 2 itinerarios
(descarta 2 rutas Pareto fuera de la elipse) — pérdida de completitud
documentada, aceptable en una respuesta ya degradada.

### 13.3 Por qué la distancia (y la densidad) son la métrica EQUIVOCADA

El brief pregunta si hace falta un criterio por densidad de paradas en vez de
por distancia. **La respuesta medida es: ni distancia ni densidad predicen la
dificultad.** Comparación directa:

| Par | d_OD | Paradas @5 km | Tier normal converge? |
|---|---|---|---|
| El Ángel↔Zócalo | 3.6 km | **2,991** (más denso) | **Sí** (~850 exp, `full`) |
| Nápoles→Xoco | 4.3 km | 2,431 (menos denso) | **No** (agota presupuesto) |

El Ángel↔Zócalo tiene un universo **más denso** y **converge**; Nápoles→Xoco
es menos denso y **falla**. La diferencia real es topológica (El Ángel↔Zócalo
va casi recto sobre un corredor Metrobús; Nápoles→Xoco exige combinar rutas),
y **no hay ninguna señal barata pre-búsqueda que lo prediga**. El único
indicador confiable es *a posteriori*: el tier normal gastó su presupuesto sin
alcanzar el destino.

### 13.4 Qué se implementó — fallback adaptativo por dificultad

En vez de un umbral de distancia o densidad, `planRoute` (index.ts) hace un
**reintento adaptativo**: si el tier normal (5 km + reintento 8 km) devuelve
`no_coverage` **por agotar su presupuesto** (`truncatedByExpansionCap`),
reintenta con la maquinaria de corredor de la sección 12 pero con un
**presupuesto acotado propio** (no los 60 s del tier largo):

- `MAX_NODE_EXPANSIONS_DENSE_FALLBACK = 4,000` (los casos densos reales
  convergen en 538–1,999 exp; 4,000 da ~2× de margen).
- `SEARCH_TIME_BUDGET_MS_DENSE_FALLBACK = 12,000` ms **totales** (incluye los
  ~2.2 s ya gastados por el tier normal).
- Confianza propia **`degraded_dense`** (nueva en `types.ts`), no
  `degraded_long_distance` — sería engañoso llamar "larga distancia" a 4.3 km.
  Pasa transparente por `api-http`/`mcp` (solo tratan especial `no_coverage`).

**El disparo NO usa un umbral de distancia** — se aplica a cualquier viaje
≤6 km que el tier normal no resolvió. Un `no_coverage` por FALTA de paradas de
acceso (`candidate*Stops = 0`, retorno temprano con `truncated=false`) o por
agotar el universo alcanzable sin truncar **no** gasta el reintento.

Resultado del caso reportado (4/4 corridas, con la máquina cargada):
`degraded_dense`, **2 itinerarios**, converge natural en **1,440 exp**
(`truncatedByExpansionCap=false`), wall **~5–8 s**. Itinerario verificado:
~49.8 min puerta a puerta, 1 transbordo, $12, cadena caminata → camión
`B_CMX05013A` (encadenado ~10 paradas) → caminata → circuito `B_CMX01022A` →
caminata al destino. Ruta válida y sensata (Del Valle → Xoco/Coyoacán).

### 13.5 `hitNodeCap`: un disparador que se PROBÓ y se DESCARTÓ (honestidad)

Primero se implementó un disparador más "quirúrgico": reintentar solo cuando
el tier normal alcanzó el tope de **NODOS** (`hitNodeCap`, campo nuevo en
`DijkstraResult`/`RaptorResult`), no cuando cortó por el **deadline de
TIEMPO** — con la idea de no reintentar cuando la lentitud es contención
pasajera. **Medido, no funciona como disparador confiable:** qué límite se
alcanza primero (1,200 nodos vs 2,200 ms) depende de la latencia por-query.
Con la máquina cargada, el mismo caso denso corta por TIEMPO a ~700 exp
(`hitNodeCap=false`) → no reintenta → `no_coverage`. Peor aún: en **producción
(Supabase sobre red, más lenta por-query que Postgres local)** el deadline de
tiempo se alcanzaría antes que el tope de nodos incluso en un caso denso
legítimo, así que `hitNodeCap` **casi nunca dispararía donde se necesita**. Se
cambió al disparador por `truncatedByExpansionCap` (tiempo O nodos), que sí es
confiable en ambos entornos. `hitNodeCap` se conserva **solo como
observabilidad** (con test unitario que verifica que distingue corte-por-nodos
de corte-por-tiempo).

### 13.6 ¿Es un patrón estructural? Otras zonas de la ciudad (task item 4)

Se probaron pares en zonas nunca antes probadas (1 corrida cada uno, misma
fecha/hora):

| Zona | Par | d_OD | Resultado |
|---|---|---|---|
| **SUR** | Nápoles/Del Valle→Xoco | 4.3 km | **degraded_dense** (falla tier normal) |
| **SUR** | Coyoacán centro→Ciudad Universitaria | 4.0 km | **degraded_dense** (5 itin, 3.6 s) |
| **SUR** | Nápoles→Coyoacán/Viveros | 5.0 km | **degraded_dense** (4 itin, 7.9 s) |
| ORIENTE | Constitución 1917→Escuadrón 201 | 4.3 km | `full` (1 itin) — **truncado en el límite** |
| ORIENTE | Constitución 1917→Santa Marta | 4.2 km | `full` (1 itin) — **truncado en el límite** |
| PONIENTE | Tacubaya→Barranca del Muerto | 4.6 km | `full` (2 itin) — **truncado en el límite** |
| PONIENTE | Observatorio→Mixcoac | 2.9 km | `full` (1 itin) — **truncado en el límite** |
| NORTE | Indios Verdes→La Raza | 3.5 km | `full` (1 itin) — **truncado en el límite** |

**Conclusión honesta para el orquestador:** esto NO es un corredor marginal
aislado. La **zona SUR (Benito Juárez/Coyoacán) falla de forma consistente**
(3/3 pares probados), y sumado a `smoke_camarones_anzures` (norte, ver
`08-qa.md` 3.4) confirma que el patrón aparece en **múltiples zonas densas**.
Igual de importante: **los 5 pares que devolvieron `full` lo hicieron
`truncatedByExpansionCap=true`** (~730–1,160 exp, justo contra el deadline de
2,200 ms) — encontraron ruta pero **sin converger**, operando al límite del
presupuesto en toda la ciudad. Es un problema **estructural** (el tier normal
está calibrado al borde citywide), no dos puntos débiles. El fallback los
cubre a todos, a costa de latencia; la solución real de fondo sigue siendo la
arquitectura (d) (transfer-patterns/hub-labeling) de la sección 12.6.

### 13.7 Latencia — re-medida, mismo método

**Tier normal (2 casos aprobados) — p95 < 3 s: SIGUE CUMPLIENDO, cero
regresión.** 18 corridas aisladas (proceso nuevo por corrida), El Ángel↔Zócalo
+ Chapultepec↔Merced, **18/18 `full`** con itinerario:

| Percentil | Latencia |
|---|---|
| min | 2,201.1 ms |
| p50 | 2,201.7 ms |
| p95 | **2,203.2 ms** |
| max | 2,203.2 ms |

Idéntico (dentro del ruido) al p95 aprobado (2,202.7 ms, sección 12.4). El
fallback nuevo solo corre **después** de que el tier normal devuelve
`no_coverage` truncado — un caso que ya resuelve nunca lo dispara.
Verificado aparte: El Ángel↔Zócalo **10/10 `full` @ ~2,202 ms** aislado.

**Fallback denso (`degraded_dense`) — p95 < 3 s: NO CUMPLE, a propósito.**
El caso reportado converge en **~5 s** (aislado) y hasta ~8 s bajo carga; el
tope duro es ~12 s. Es una **degradación deliberada y explícita** (mismo
principio que el tier largo de la sección 12), no un descuido — se prefiere
devolver una ruta real a devolver `no_coverage`. El costo de un `no_coverage`
genuino (con paradas de acceso pero sin ruta) queda acotado a ~12 s, **no** a
los 60 s del tier largo.

### 13.8 Interacción con la contención de la suite de tests (documentada)

Hallazgo real durante esta pasada: bajo **contención de Postgres** (la suite
completa comparte un solo contenedor local, `vitest.config.ts` ya serializa
archivos pero la máquina queda al borde), el tier normal de un caso que
normalmente es `full` (El Ángel↔Zócalo) puede cortar por tiempo con **0
itinerarios** y disparar el fallback → `degraded_dense` en ~5–8 s en vez de
`full` en 2.2 s. Esto es el fallback **haciendo su trabajo** (ruta real en vez
de `no_coverage`), pero significa que **la latencia de cola bajo contención
empeora**. Con el presupuesto del fallback en 60 s (primer intento de esta
pasada) esto tumbaba tests de `tests/api/routes.test.ts` por timeout de 5 s;
**acotarlo a 12 s lo resolvió** — la suite completa pasa **174 passed | 4
skipped** (3 corridas limpias consecutivas; antes de esta pasada 172 | 4).
`src/api/`, `src/mcp/`, `src/modes/` **no se tocaron**.

### 13.9 Cambios en `src/routing/` (esta pasada)

- **`types.ts`**: `PlanConfidence` gana `"degraded_dense"`.
- **`dijkstra.ts` / `raptor.ts`**: `DijkstraResult`/`RaptorResult` ganan
  `hitNodeCap` (observabilidad; distingue corte por nodos vs por tiempo).
- **`config.ts`**: `MAX_NODE_EXPANSIONS_DENSE_FALLBACK` (4,000),
  `SEARCH_TIME_BUDGET_MS_DENSE_FALLBACK` (12,000).
- **`index.ts`**: fallback adaptativo por `truncatedByExpansionCap` sin
  cobertura; `attemptLongDistancePlan` ahora recibe
  `{successConfidence, maxNodeExpansions, timeBudgetMs}` (reusada por el tier
  largo Y el fallback denso, con presupuestos distintos). `AttemptOutcome`
  propaga `hitNodeCap`.
- **Tests**: `index.test.ts` (nuevo caso Nápoles→Xoco end-to-end contra
  Postgres; `userId sin fila` ahora acepta `degraded_dense`),
  `dijkstra.test.ts` (2 asserts nuevos + 1 test de `hitNodeCap`
  tiempo-vs-nodos). Suite: **174 | 4**.

### 13.10 Limitaciones/gaps que siguen abiertos

1. **El fallback denso incumple p95 < 3 s (~5–12 s).** Misma raíz que la
   sección 12.6: A*-por-nodo contra Postgres sin precómputo. La solución real
   es arquitectura (d) (transfer-patterns/hub-labeling) — otra fase.
2. **El problema es citywide, no dos corredores.** Los casos que hoy dan
   `full` lo hacen al borde del presupuesto (`truncated=true`). Un cambio de
   datos (más rutas) o de hardware podría empujar más pares al fallback. El
   tier normal está calibrado al límite; subir su presupuesto rompería p95.
3. **El corredor pierde completitud Pareto** en el fallback (4→2 itinerarios
   en el caso medido). Aceptable en una respuesta degradada, pero el "mejor"
   itinerario podría quedar fuera de la elipse en alguna geometría no probada.
4. **Bajo contención local extrema**, un caso denso puede seguir dando
   `no_coverage` si el tier normal corta tan temprano que ni siquiera intenta
   lo suficiente antes del deadline — inherente a compartir un Postgres local;
   en producción (Supabase dedicado) no aplica. El disparo por
   `truncatedByExpansionCap` (no `hitNodeCap`) minimiza esto.
5. **`SEARCH_TIME_BUDGET_MS_DENSE_FALLBACK` = 12 s** puede exceder el límite de
   duración de función serverless de Vercel (10 s en plan gratuito) — misma
   nota que 12.6.2, **sin resolver aquí** (no se toca despliegue). Es menos
   grave que los 60 s del tier largo.
