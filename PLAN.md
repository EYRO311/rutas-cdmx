# Estado del proyecto

Actualiza este archivo después de cada handoff aprobado.

| Fase | Agente | Handoff | Estado | Fecha |
|---|---|---|---|---|
| 1 | datos-gtfs | 01-datos.md | ✅ aprobado | 2026-08-16 |
| 2 | modelo-grafo | 02-grafo.md | ✅ aprobado | 2026-08-16 |
| 3 | algoritmo-ruteo | 03-algoritmo.md | ✅ aprobado (ver nota) — secciones 12 (tier de distancia larga) y 13 (fallback denso) agregadas | 2026-08-16 / 2026-08-30 / 2026-08-31 |
| 3 | modo-auto | 04-auto.md | ✅ aprobado | 2026-08-16 |
| 3 | api-http | 05-api.md | ✅ aprobado | 2026-08-16 |
| 4 | qa-rutas | 08-qa.md | 🔴 parcial — 2/6 casos calibrados llegaron y expusieron un hallazgo crítico (ver abajo), 4 siguen bloqueados | 2026-08-28 |
| 4 | mcp-asistente | 06-mcp.md | ✅ aprobado | 2026-08-17 |
| 5 | aprendizaje-beta | 07-aprendizaje.md | ⬜ pendiente | — |

## 🟡 Hallazgo crítico — mitigado, no resuelto del todo (actualizado 2026-08-30)

**Resolución de `algoritmo-ruteo` (`docs/handoff/03-algoritmo.md` sección
12), verificada de forma independiente por el orquestador** (suite
completa corrida en local: 172 passed | 4 skipped, coincide exacto con lo
reportado; constantes de `config.ts` confirmadas contra el handoff): se
agregó un **tier de distancia larga** (heurística A* admisible + filtro de
corredor elíptico, activado cuando origen-destino supera 6km en línea
recta). `casa_escom_pico` ya **encuentra 1 itinerario real** (antes:
`no_coverage`) — 66.2 min, 2 transbordos, $18, camión local + RTP + Metro
L5 (combinación de modos distinta a la que reportó Emiliano, pero
Pareto-válida). El tier normal (≤6km) queda exactamente igual, p95 =
2,202.7ms, **cero regresión**.

**Lo que sigue sin resolver, a propósito y documentado, no oculto:** el
tier largo tarda **~22-25 segundos** por consulta — **10× por encima del
presupuesto p95<3s del proyecto**. Es degradación deliberada
(`confidence: "degraded_long_distance"`, nunca `full`), no un descuido:
el proyecto prefirió devolver una ruta real correcta a forzar un
presupuesto incompatible con la arquitectura actual (A* nodo-por-nodo
contra Postgres, sin precómputo). El camino para bajar esto de verdad es
la opción (d) descartada en `08-qa.md` (transfer patterns/hub labeling
con tabla precalculada) — es un proyecto del tamaño de una fase completa,
no un ajuste de `src/routing/`.

**Nuevo bloqueo real para producción, sin resolver:** `SEARCH_TIME_BUDGET_MS_LONG_DISTANCE`
(60s) puede exceder el timeout de función serverless de Vercel (10s en
plan gratuito) — reportado por `algoritmo-ruteo` para que `api-http`/
despliegue decida (cola asíncrona, plan con timeout mayor, o esperar a
(d)). No se ha decidido nada todavía.

**Pendiente para `qa-rutas`:** validar tipo-2 (desviación <15%) contra
este itinerario — el motor da 66 min vs 80 min reales medidos (~17% más
rápido, fuera del ±15%, pero por una combinación de modos distinta, no
necesariamente un error del motor).

<details>
<summary>Hallazgo original (2026-08-28), para contexto histórico</summary>

## 🔴 Hallazgo crítico abierto (2026-08-28) — el commute real del usuario no se puede rutear

Emiliano dio 2 de los 6 `casos_calibrados` de `qa-rutas` (casa en Río
Becerra 129, Col. 8 de Agosto → ESCOM/Zacatenco, dos rutas reales de
1h20 y 1h40 medidas por él). **Las dos dan `no_coverage` (0 itinerarios)
contra el motor real.** Investigado a fondo: NO es falta de cobertura
geográfica (las 3 paradas reales de transbordo del viaje en Metro caen
dentro del radio de búsqueda, verificado con `ST_Distance` real) — es que
el motor agota su presupuesto de búsqueda completo (`MAX_NODE_EXPANSIONS`
1200, `SEARCH_TIME_BUDGET_MS` 2200) en un commute real de ~12.8km en
línea recta, y **ningún caso probado hasta ahora en este proyecto supera
4.5km**. Un viaje real, común, que el usuario hace seguido, no funciona.

**Investigado a fondo 2026-08-28 (`docs/handoff/08-qa.md` sección 1.2):**
se subió el presupuesto temporalmente (experimento, revertido, nunca
commiteado) para medir cuánto hace falta de verdad. Resultado: **10,000
nodos/15s TODAVÍA falla; hacen falta 33,602 expansiones y 45.6 segundos**
para encontrar la ruta (que sí coincide razonablemente con la real). Es
un salto de ~28× en nodos y ~20× en tiempo, no un ajuste fino — **subir
el presupuesto queda descartado como solución** (45s por consulta es
inaceptable para una API con p95 < 3s). El camino ganador (27 tramos) es
corto comparado con las 33,602 expansiones que costó encontrarlo, lo que
apunta a poda/heurística insuficiente en un universo de búsqueda denso
(radio 8km en CDMX candidatea miles de paradas reales), no falta de
presupuesto en sí. Quedan 3 rutas de arreglo real sin decidir (heurística
admisible más fuerte, restringir a un corredor en vez de dos burbujas, o
una arquitectura de ruteo distinta para trayectos largos) — todas son
cambios de diseño del motor, ninguna se implementó.
`tests/qa/rutas-reales.test.ts` ya documenta este comportamiento como
test que pasa (afirma el `no_coverage` real, no lo oculta) — si algún día
el motor encuentra ruta para este caso, hay que actualizar esa aserción
como una mejora, no arreglar un test roto.

</details>

## Bloqueos abiertos
- **`qa-rutas` (Fase 4) parcialmente bloqueado esperando datos reales de viajes del usuario** — su propia regla es "el usuario provee los datos; si faltan, pídelos, no inventes". Ya llegaron 2 (ver hallazgo crítico arriba). Pendiente: mismo viaje casa→ESCOM fuera de hora pico (para contrastar con el de hora pico que ya llegó), un viaje donde AUTO gana claramente, un viaje en día de Hoy No Circula, un destino sin cobertura de transporte público. Pedidos el 2026-08-17 y de nuevo el 2026-08-28. Mientras tanto se construyeron 5 casos "smoke" adicionales con pares reales de `bike_edges` (Ecobici) en zonas diversas de la ciudad, que sí corren hoy (correctitud/latencia, nunca calidad/regresión sin tiempo real medido) — detalle completo y 3 hallazgos reales encontrados al construirlos en `docs/handoff/08-qa.md`.
- ~~Registro en `metrobus-gtfs.sinopticoplus.com` hecho (2026-08-29), pero resultó ser el feed estático, no el de tiempo real (GTFS-RT)~~ **Resuelto 2026-08-31**: llegó un correo nuevo con credenciales reales de la API (proveedor Sonda S.A.) — `datos-gtfs` las integró (`scripts/gtfs-rt/auth.ts`) y verificó el feed GTFS-RT real por primera vez: 845 posiciones de vehículo, 0 trip updates, parser (`protobufjs`) decodificando datos reales sin errores. **Hallazgo nuevo que sí queda abierto**: el `route_id` del feed en tiempo real es numérico (esquema Sonda, ej. `"19429"`) y NO coincide con el `route_id` ya cargado (`B_CMX0300L1`...) — sin una tabla de reconciliación (no existe todavía) no se puede unir una posición de vehículo real a una ruta del grafo. `trip_id` y `current_stop_sequence` vienen `NULL` en el 100% de las filas del feed (limitación real de la fuente, no del parser). Detalle completo, con las 7 hallazgos de datos sucios y la evidencia de expiración de las URLs firmadas, en `docs/handoff/01-datos.md` sección 8. El feed estático archivado en `data/raw/metrobus-gtfs-estatico/` (mismo proveedor, mismo prefijo `1339`) sigue sin integrar — decisión pendiente de si conviene reconciliar ambas fuentes (RT + estático) de una vez.
- Cap de facturación en Google Cloud **sin configurar**. Bloquea el lanzamiento de `modo-auto` en Fase 3 — no se hace ningún request real a Google Routes API hasta confirmar esto.
- Banco de casos de `qa-rutas` necesita tiempos reales medidos por el usuario.
- Proyecto de Supabase de producción **no existe todavía** — bloquea configurar el secret `DATABASE_URL` en GitHub Actions para que el cron de Ecobici (`ecobici-snapshot.yml`, cada 5 min) corra en producción. Localmente el ETL y el snapshot ya corren contra Postgres 5433.
- ~~`routes.agency_id = 'SEMOVI'` (ruta `TR13`, Trolebús) no existe en `agency.txt`~~ **Resuelto 2026-08-28**: `route_overrides` (migración 0017, mismo patrón que `stop_overrides`/`transfer_overrides`) corrige `TR13` a `TROLE`, con evidencia real (`route_type=11` + numeración consistente con las otras 10 rutas TROLE), no una suposición. `real-router-engine.ts#lookupRouteModes` ya lo consume. **Hallazgo nuevo al verificar esto**: `TR13_TRIP_1` no tiene ninguna fila en `stop_times` (solo `frequencies`) — inalcanzable por el motor hoy, sin importar el agency_id. Gap distinto y más profundo, sin resolver (ver `docs/handoff/01-datos.md` sección 5.1).

## Deuda conocida
- **Ruteo "en vivo" (fecha/hora real) bloqueado por vigencia del GTFS — decisión tomada 2026-08-31: Opción B, no tocar código todavía.** Confirmado que el feed público de `datos.cdmx.gob.mx` sigue siendo el mismo ZIP del 2026-08-16 (SHA-256 idéntico, verificado de nuevo el 2026-08-31 — el portal solo tocó metadata, no contenido). Las 12 filas reales de `calendar` (10 agencias) vencen 2025-12-31; la única vigente en 2026 (`TR13_SERVICE`) no tiene `stop_times`, inalcanzable. `datos-gtfs` dejó 3 alternativas documentadas con evidencia en `docs/handoff/01-datos.md` sección 9 (A: extender vigencia asumida vía override — desbloquea "en vivo" hoy pero no está confirmada por la fuente; B: seguir con fecha fija dentro de 2024-12-01/2025-12-31; C: monitoreo pasivo de hash del feed). **Emiliano eligió B mientras se sigue buscando una fuente de datos mejor** — no se implementa la Opción A (override de vigencia) hasta nueva instrucción. `scripts/field-test/email-worker.ts` ya soporta un campo `fecha:` opcional para esto.
- **Corrección sobre la deuda original:** el feed de `datos.cdmx.gob.mx` no es solo el GTFS del Metro — es un feed consolidado de **10 agencias** (METRO, MB, RTP, CC, TROLE, CBB, PUMABUS, TL, SUB, INTERURBANO). No trae `feed_info.txt`, así que no se puede confirmar programáticamente la vigencia por agencia. `calendar.txt` sí trae fechas de servicio hasta 2026-12-31, así que "GTFS de 2022" ya no describe bien el feed completo — sigue siendo el hueco más grande del proyecto, pero su alcance real es mayor al que se pensaba (ver `docs/handoff/01-datos.md` §1.1 y §5.13).
- La fuente no trae `calendar_dates.txt` ni `transfers.txt` — ambas tablas existen vacías. Los transbordos van a depender por completo de `transfer_overrides` (tabla que crea `modelo-grafo` en Fase 2, todavía no existe).
- `shape_dist_traveled` falta en ~43% de los puntos de `shapes` (54,427 de 127,135). Recalculable con PostGIS si hace falta.
- El extracto OSM de red peatonal/ciclista (`data/raw/osm/cdmx-pedestrian-cycling.json`, vía Overpass API, Geofabrik no tiene extracto a nivel ciudad) está descargado pero **no cargado a Postgres** — es insumo crudo para que `modelo-grafo` decida el esquema.

Detalle completo, con los 14 hallazgos específicos y sus conteos, en `docs/handoff/01-datos.md`.

- **`prisma migrate` no funciona como mecanismo operativo** (probado en serio en Fase 2, ver nota en `CLAUDE.md` y `docs/handoff/02-grafo.md` sección 1): amenaza con resetear datos reales o genera SQL de baseline roto por un bug de Prisma con columnas `BIGSERIAL` heredadas. Se usa un runner propio en su lugar; Prisma queda solo para cliente tipado (`db pull`/`generate`). Cualquier fase futura que necesite crear tablas debe usar `scripts/migrate.ts`, no `prisma migrate`.
- **`walk_edges` usa distancia en línea recta × factor de circuidad (1.3), no routing real sobre la red OSM** — no hay `pgRouting` en la imagen local de Postgres. La red OSM sí está cargada (`osm_nodes`/`osm_ways`) por si en el futuro se justifica construir routing peatonal real.
- **La vigencia del `calendar` GTFS termina en su mayoría el 2025-12-31** — hoy (2026-08-16) queda fuera de rango para casi todos los servicios. No es un bug de Fase 2, es la vigencia real del feed heredado de Fase 1. Relevante para pruebas de `algoritmo-ruteo`/`qa-rutas`: hay que usar una fecha dentro del rango de vigencia real, no "hoy", o el grafo devolverá resultados vacíos por falta de servicio activo, no por un bug del motor.
- **`stop_overrides`/`transfer_overrides` ya existen pero están vacías** — el mecanismo lo creó `modelo-grafo`; poblarlas es trabajo de Fase 3/4 cuando se detecten transbordos rotos con el motor de ruteo real corriendo.

## Deuda conocida (Fase 2)
- Punto de entrada del grafo para `algoritmo-ruteo`: `SELECT * FROM graph_stop_neighbors(stop_id, fecha, segundos_desde_medianoche, ventana_segundos)` — devuelve aristas `ride`/`transfer`/`walk` ya filtradas por servicio activo. Medido independientemente en ~1.7ms (criterio: <50ms).

## Fase 3 — hallazgos y pendientes
- **`algoritmo-ruteo` y `api-http` ya están conectados** (verificado 2026-08-17): `POST /v1/routes` usa `RealRouterEngine` de verdad, no el stub. Probado por el orquestador de forma independiente contra el servidor real: El Ángel→Zócalo (2025-06-16 08:00 CDMX) responde `duration_s:1238, transfers:1, cost_mxn:12, is_stub:false` — coincide con el resultado que documentó `algoritmo-ruteo` por su cuenta, confirmando que el adapter no distorsiona el motor. El caso `no_coverage` (fecha fuera de vigencia del `calendar`) responde `HTTP 200, routes: []`, nunca 500. Limitaciones conocidas del adapter: filtrado de `allowed_modes` es post-hoc (puede descartar itinerarios mixtos válidos en vez de rebuscar), `arrival_at` sigue sin soportarse (ahora con warning explícito en la respuesta), `confidence`/`cost_mxn` por tramo son derivados/heurísticos (detalle en `docs/handoff/05-api.md` sección 9).
- **Criterio de terminado de `algoritmo-ruteo` parcialmente pendiente por diseño**: "resuelve las rutas del banco de casos de `qa-rutas` con desviación <15%" no se pudo validar porque ese banco (Fase 4) no existía todavía cuando corrió esta fase — es una dependencia circular real del orden de fases (`CLAUDE.md` no se cambia). Sí se cumplió el resto: 56 tests unitarios reales, p95 = 2,201.8ms medido (criterio: <3s), verificado independientemente por el orquestador (2,035-2,204ms en 3 corridas propias). La validación contra el banco real queda pendiente para cuando `qa-rutas` corra.
- **Motor por defecto: `dijkstra`, no `raptor`** — ambos están completos y probados (56 tests cubren los dos), pero `planRoute()` usa Dijkstra como default por rendimiento medido (corte temprano exacto por destino; RAPTOR necesita más margen de presupuesto para converger). Ambos disponibles vía parámetro `engine`.
- Ambos handoffs completos con topes de ventana, mediciones y limitaciones detalladas en `docs/handoff/03-algoritmo.md` y `docs/handoff/04-auto.md`.

## Modo bici — agregado 2026-08-22 (extiende Fases 1-3 ya cerradas, CLAUDE.md decisión #8)
Trabajo en 3 partes secuenciales (misma cadena de dependencias que las fases originales), para que `calcular_ruta` pueda ofrecer de verdad un tramo en Ecobici.

| Parte | Agente | Estado |
|---|---|---|
| 1/3 | `datos-gtfs` (histórico real de viajes) | ✅ aprobado — 2026-08-22 |
| 2/3 | `modelo-grafo` (aristas de bici + función de expansión) | ✅ aprobado — 2026-08-22 |
| 3/3 | `algoritmo-ruteo` (usar las aristas en el motor) | ✅ aprobado — 2026-08-28 (código escrito desde 22-23 de agosto; el handoff se quedó sin cerrar hasta retomar esta sesión) |

**1/3 — verificado de forma independiente por el orquestador**: fuente real confirmada (`curl -I` contra `ecobici.cdmx.gob.mx`, mismo tamaño/fecha que reportó el agente), `ecobici_trips_historical` con 1,493,484 viajes reales de julio 2026, `ecobici_speed_stats` con velocidad promedio 6.094 m/s (~21.9 km/h) y mediana 4.908 m/s (~17.7 km/h) — **recomendación del agente: `modelo-grafo` debería usar la mediana**, porque la distribución queda sesgada a la derecha incluso después del recorte de outliers (IQR de Tukey). Detalle completo en `docs/handoff/01-datos.md` sección 7 (fuente, normalización de `station_id` sucios, umbrales de outliers con su justificación).

Nota técnica para `modelo-grafo`: la velocidad se calculó con distancia geodésica en línea recta (no hay routing real sobre la red ciclista) — **ya neta parte de la circuidad real contra el tiempo real** (mismo espíritu que `WALK_CIRCUITY_FACTOR`). Si `modelo-grafo` aplica un factor de circuidad adicional sobre esta velocidad, lo estaría aplicando dos veces — evitarlo.

**2/3 — verificado de forma independiente por el orquestador**: tabla `bike_edges` con 266,666 filas reales (radio 5,000m, elegido con evidencia cruzando percentiles reales de distancia de viaje — cubre 64% de los viajes reales como tramo directo), usando `median_speed_mps` (siguió la recomendación de `datos-gtfs`) sin duplicar el ajuste de circuidad. Función nueva `graph_bike_station_neighbors(station_id)` — medida por el orquestador en 0.287ms (criterio: <50ms). No tocó `src/routing/`, `src/api/`, `src/modes/`, `src/mcp/`. Limitación documentada: 36% de los viajes reales de Ecobici cruzan más de 5km en línea recta y no tienen arista directa — quedan pendientes de encadenamiento o de que `algoritmo-ruteo` decida subir el radio. Detalle completo con la tabla de evidencia por radio en `docs/handoff/02-grafo.md` sección 9.

**3/3 — cerrado 2026-08-28, detalle completo en `docs/handoff/03-algoritmo.md` sección 11**: `src/routing/` ya usaba `bike_edges`/`graph_bike_station_neighbors` de verdad (dijkstra, raptor, graph-client, relax, config, types, window, index — 56→72 tests, 0 fallando). Verificar esto de forma independiente encontró y corrigió tres problemas reales que el handoff nunca había registrado:
- **Flakiness real en la suite de tests** (no un bug de la integración): el motor corta la búsqueda con un deadline de reloj de pared (2,200ms) que ya corría sin holgura antes de bici (p95 medido = 2,201.8ms); con bici, más queries por expansión + 18/21 archivos de test pegándole al mismo Postgres local en paralelo = contención real que hacía que la MISMA consulta a veces encontrara ruta y a veces no. Arreglado con `vitest.config.ts` (`fileParallelism: false`) — 3 corridas limpias seguidas tras el cambio.
- **503 real en `POST /v1/routes`** (`docs/handoff/05-api.md` sección 10): `real-router-engine.ts` (aprobado antes de que existiera Ecobici) no sabía resolver un `stopId` que fuera una estación Ecobici en vez de una parada GTFS — cualquier itinerario que caminara a través de una (sin necesariamente usar bici) tronaba. Corregido resolviendo por `nodeType`. De paso se encontró y corrigió que los tramos `bike` se reportaban como `"walk"` (nunca se agregó el caso en `resolveLegMode`).
- **Hallazgo, no bug**: sin ningún servicio GTFS activo un día dado, el motor ahora sí encuentra una ruta real 100% a pie (antes no, por un grafo peatonal menos denso) — las estaciones Ecobici sirven de punto de paso peatonal aunque no se use bici. Es un resultado físicamente plausible; se corrigió la aserción del test viejo (`tests/api/routes.test.ts`) que asumía `no_coverage` en ese caso, no el motor. Queda anotada una idea diferida: exponer si una ruta usó algún tramo de transporte real programado, para que un cliente no confunda "full confidence" con "hay transporte corriendo" — decisión de contrato de API, útil para cuando `qa-rutas` (Fase 4) mida desviación contra viajes reales.

Suite completa del repo tras estas correcciones: **150/150**.
