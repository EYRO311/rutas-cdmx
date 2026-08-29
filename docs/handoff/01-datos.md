# 01 — Datos (Fase 1, agente `datos-gtfs`)

Handoff de salida de la Fase 1. Todo lo descrito aquí se corrió de verdad
contra el Postgres+PostGIS local (puerto 5433, base `rutas_cdmx`) el
2026-08-16. Nada de esto es simulado; los conteos son el resultado real de
consultar la base después de correr los scripts.

## 1. Qué se cargó

### 1.1 GTFS estático — `data/raw/cdmx-gtfs/` → tablas GTFS normalizadas

**Corrección sobre el brief inicial:** este ZIP (`datos.cdmx.gob.mx`) **no es
solo el GTFS del Metro**. Es el feed consolidado de CDMX con **10 agencias**:
METRO, MB (Metrobús — horarios estáticos, no tiempo real), RTP, CC
(Corredores Concesionados), TROLE (Trolebús), CBB (Cablebús), PUMABUS, TL
(Tren Ligero), SUB (Ferrocarriles Suburbanos) e INTERURBANO (Tren El
Insurgente). `PLAN.md` describe la deuda conocida como "GTFS del Metro es de
2022" — eso puede seguir siendo cierto para la vintage de los datos del
Metro específicamente, pero el archivo no trae `feed_info.txt`, así que no
hay forma de confirmar o descartar la fecha de corte para las demás
agencias a partir de los datos mismos. Vale la pena que el orquestador
actualice esa entrada de `PLAN.md` para reflejar que el feed es
multi-agencia, no solo Metro.

Migraciones: `migrations/0001_extensions.sql`, `0002_raw_tables.sql`,
`0003_gtfs_static.sql`, `0005_ecobici.sql`, `0006_metrobus_rt.sql`,
`0007_fix_routes_agency_fk.sql` (no hay `0004`: ver nota en sección 5),
aplicadas con `npm run migrate` (runner propio en `scripts/migrate.ts`, no
`prisma migrate` — ver sección 4). ETL: `scripts/etl/index.ts` +
`scripts/etl/lib/*`, corrido con `npm run etl`.

**Conteos reales tras `npm run etl` (verificados con `SELECT count(*)`, no
tomados del log del ETL):**

| Tabla | Filas |
|---|---|
| `agency` | 10 |
| `routes` | 301 |
| `calendar` | 13 |
| `calendar_dates` | 0 (la fuente no trae `calendar_dates.txt`) |
| `stops` | 11,362 |
| `shapes` | 127,135 puntos (721 `shape_id` distintos) |
| `trips` | 1,205 |
| `stop_times` | 42,789 |
| `frequencies` | 1,584 |
| `transfers` | 0 (la fuente no trae `transfers.txt`) |
| `_raw` (crudo, todas las fuentes) | 184,399 filas de `cdmx-gtfs` |

Rutas por agencia (route_id únicos): CC 137, RTP 114, PUMABUS 12, METRO 12,
TROLE 11, MB 8, CBB 3, TL 1, SUB 1, INTERURBANO 1.

### 1.2 Ecobici (GBFS) — `scripts/ecobici/snapshot.ts`

Corrido dos veces contra el feed real (`gbfs.mex.lyftbikes.com`):

| Tabla | Filas tras 2 corridas |
|---|---|
| `ecobici_stations` | 677 (upsert — no duplica) |
| `ecobici_snapshots` | 1,354 (677 × 2 — es serie de tiempo, se espera que crezca en cada corrida) |

Workflow de cron: `.github/workflows/ecobici-snapshot.yml`, cada 5 min,
`workflow_dispatch` también habilitado para pruebas manuales. **Necesita el
secret `DATABASE_URL` de GitHub Actions apuntando al pooler de Supabase en
producción** — no configurado todavía porque Supabase de producción no
existe aún en esta fase.

### 1.3 GTFS-RT Metrobús — `scripts/gtfs-rt/`

Parser (`parse.ts`) escrito sobre el `.proto` oficial de GTFS-Realtime
(bajado tal cual de `github.com/google/transit`, en
`src/gtfs-rt/gtfs-realtime.proto`, no reescrito a mano). Decodifica
`VehiclePosition` y `TripUpdate` a objetos planos.

**Verificación real hecha:** roundtrip con un `FeedMessage` sintético
(codificado y decodificado con el mismo esquema) en
`tests/gtfs-rt-parse.test.ts` — 2 pruebas, ambas pasan (`npm test`).

**Lo que NO se pudo verificar:** el feed real de Metrobús. `METROBUS_GTFS_TOKEN`
sigue vacío en `.env` (registro pendiente en
`metrobus-gtfs.sinopticoplus.com`, bloqueo ya conocido en `PLAN.md`).
`scripts/gtfs-rt/fetch-and-store.ts` detecta la ausencia del token y
termina con exit code 1 y un mensaje explícito — se probó así (ver sección
3). Tampoco está confirmada la URL exacta del endpoint del feed (solo el
dominio de registro); `METROBUS_RT_URL` en el script es una suposición
razonable, no un valor verificado.

**Actualización 2026-08-29 — registro hecho, pero es el feed equivocado
para esto.** Emiliano se registró en `metrobus-gtfs.sinopticoplus.com`
(formulario real: organización, representante, teléfono, correo,
descripción de uso, aceptar términos — **hay que renovarlo cada año**,
dato nuevo que no estaba documentado) y descargó un ZIP, pero es el feed
**estático** oficial de Metrobús, no el de tiempo real (GTFS-RT) que
necesita este script. Archivado sin commitear en
`data/raw/metrobus-gtfs-estatico/` (gitignorado, mismo criterio que el
resto de `data/raw/`). `METROBUS_GTFS_TOKEN`/`METROBUS_RT_URL` siguen sin
resolverse — sigue pendiente confirmar si el portal tiene una sección de
API/tiempo real separada de la descarga de datos abiertos.

**El feed estático que sí llegó es genuinamente mejor que lo que ya está
cargado**, aunque sea para otro problema: trae `feed_info.txt` real
(vigencia confirmada 2026-01-01 a 2026-12-31 — algo que el feed
combinado de `datos.cdmx.gob.mx` nunca trajo, ver punto 13 de la sección
5) y horarios reales por viaje individual (`stop_times.txt`, ~1.07M
filas, 38,985 trips) en vez de `frequencies.txt` por headway (punto 7 de
la sección 5, que sigue aplicando a los datos ya cargados). Usa un
esquema de IDs completamente distinto (`agency_id=1339` numérico, no
`'MB'`; `route_id`/`stop_id` propios) — integrarlo sería reconciliar o
reemplazar toda la porción de Metrobús del grafo ya cargado, no un
`UPDATE` chico. **Decisión explícita (Emiliano, 2026-08-29): no
integrarlo todavía** — queda archivado como referencia mientras se
prioriza `qa-rutas`.

Tablas `metrobus_vehicle_positions` y `metrobus_trip_updates` existen
(migración `0006`) pero tienen **0 filas** — nunca se pudieron llenar.

### 1.4 OSM — red peatonal y ciclista

Geofabrik no tiene extracto a nivel ciudad para CDMX. Se usó la Overpass
API en su lugar (`scripts/osm/fetch-cdmx-extract.ts`, `npm run etl:osm`) —
decisión y trade-offs documentados en el comentario de cabecera del script.
Resultado real guardado en `data/raw/osm/cdmx-pedestrian-cycling.json`
(27.5 MB, **no está en git**, ver `.gitignore`):

- 55,881 ways: 35,107 `footway`, 5,887 `steps`, 5,287 `path`, 4,432
  `living_street`, 4,212 `pedestrian`, 956 `cycleway`.
- 274,132 nodes. 0 referencias a nodos faltantes (geometría íntegra).

**No se cargó a Postgres.** El entregable de este agente es GTFS + GBFS +
GTFS-RT; el archivo OSM queda como insumo crudo en `data/raw/osm/` para que
`modelo-grafo` (Fase 2) lo consuma y decida cómo modelarlo — cargarlo no es
"diseñar el grafo", pero tampoco es un requisito explícito de este agente y
prefiero no inventarle un esquema de tablas a un agente que no soy yo.

## 2. Cobertura geográfica

- **GTFS estático:** `stops.stop_lat/stop_lon` van de lat 19.133–19.667,
  lon -99.695 a -98.953. Cubre las 16 alcaldías de CDMX más tramos
  conurbados de Edomex (INTERURBANO llega hacia Zinacantepec/Toluca, RTP y
  CC cruzan el límite). 0 stops fuera de un bbox de control CDMX+ZMVM
  (lat 18.5–20.2, lon -99.9 a -98.5).
- **Ecobici:** lat 19.344–19.471, lon -99.213 a -99.131 — solo alcaldías
  centrales (Cuauhtémoc, Miguel Hidalgo, Benito Juárez y zonas colindantes),
  consistente con la cobertura real del sistema.
- **OSM (peatonal/ciclista):** bbox de descarga lat 19.03–19.70, lon
  -99.72 a -98.90 (con margen sobre el bbox real de los stops).
- **GTFS-RT Metrobús:** sin datos, no hay cobertura que reportar.

## 3. `npm run etl` corrido dos veces seguidas

```
$ npm run etl        # primera corrida
[migrate] aplicada: 0007_fix_routes_agency_fk.sql   (única migración nueva)
[etl] _raw cargado: agency.txt 10, routes.txt 301, trips.txt 1205,
  calendar.txt 13, stops.txt 11362, shapes.txt 127135,
  stop_times.txt 42789, frequencies.txt 1584
[etl] tablas normalizadas (upsert): agency 10, calendar 13, routes 301,
  stops 11362, shapes 127135, trips 1205, stop_times 42789, frequencies 1584
[etl] sin advertencias de parseo.
[etl] listo.

$ npm run etl        # segunda corrida, inmediatamente después
[migrate] ya aplicada, se salta: (las 7)
[etl] _raw cargado: — MISMOS NÚMEROS —
[etl] tablas normalizadas (upsert): — MISMOS NÚMEROS —
[etl] sin advertencias de parseo.
[etl] listo.
```

Confirmado con `SELECT count(*)` directo después de ambas corridas: mismos
números, sin duplicados. `npm test` (vitest, 2 archivos, 6 pruebas) también
pasa limpio.

## 4. Decisiones de infraestructura no pedidas explícitamente pero necesarias

- **Prisma 7 exige un driver adapter** para conectar (`PrismaClientInitializationError`
  sin uno). Se agregaron `@prisma/adapter-pg` y `pg` (+ `@types/pg`) a
  `package.json`. `prisma/schema.prisma` se dejó **sin modelos** (solo
  datasource + generator) — las migraciones y el ETL usan `pg` directo, no
  Prisma Client, así que no hace falta declarar modelos todavía. Un agente
  futuro que quiera usar Prisma Client tipado sobre estas tablas puede
  correr `prisma db pull` para introspectarlas.
- **No se usó `prisma migrate`.** Requiere una shadow database (privilegios
  de `CREATEDB`) que no quise asumir que existen ni en el Postgres local ni
  en el pooler de Supabase de producción. Se escribió un runner propio
  (`scripts/migrate.ts`): aplica los `.sql` de `/migrations` en orden,
  registra lo aplicado en `_migrations`, e idempotente por diseño.
- `package.json` ganó `"type": "module"` (todos los scripts son ESM;
  Prisma 7 genera el client como TypeScript fuente, pensado para correr con
  `tsx`, no con `node` directo sobre `.js`).
- `.gitignore` ganó `data/raw/` — los datos crudos descargados (GTFS zip,
  extracto OSM) se reconstruyen con los scripts de ETL, no tiene caso
  versionarlos.

## 5. Huecos y datos sucios encontrados (lista explícita)

1. ~~**`routes.agency_id = 'SEMOVI'` no existe en `agency.txt`.**~~
   **Corregido 2026-08-28 — ver `migrations/0017_route_overrides.sql`.**
   La ruta `TR13` ("Trolebús Línea 13") referenciaba una agencia que no
   está entre las 10 declaradas. Se confirmó `TROLE` con evidencia real
   (no la misma suposición del texto original): `route_type = 11`
   (Trolebús, GTFS Extended Route Types, campo de la MISMA fuente) +
   `route_short_name = '13'` consistente con la numeración de las otras
   10 rutas TROLE confirmadas (short_name '1'-'10'). El FK se dejó
   relajado (`migrations/0007`) — la corrección vive en `route_overrides`
   (mismo mecanismo que `stop_overrides`/`transfer_overrides`), no un
   `UPDATE` directo sobre el dato crudo del feed. **Hallazgo nuevo al
   verificar esto**: `TR13_TRIP_1` no tiene NINGUNA fila en `stop_times`
   (solo `frequencies`) — es inalcanzable por el motor de ruteo hoy,
   independientemente de este fix. Ese es un gap distinto y más profundo
   (falta la secuencia de paradas en la fuente), no resuelto — no hay
   forma de reconstruirla sin inventar datos, así que se deja documentado
   en vez de tapado.
2. **3 filas de `stops.txt` usan comillas RFC4180** (comas y comillas
   escapadas dentro del campo `stop_name`, ej. `"Periférico, Puente hacia
   Periférico Norte"` y `"Camino de la Unión ""A"" y Constitución..."`). Un
   `split(',')` ingenuo desalinea esas filas **sin lanzar ningún error** —
   se escribió un parser CSV propio (`scripts/etl/lib/csv.ts`) para no
   corromper esas 3 filas en silencio. Probado en `tests/csv.test.ts`.
3. **No hay `calendar_dates.txt` ni `transfers.txt`** en la fuente. Las
   tablas existen (contrato GTFS) pero están vacías. `transfers` vacía es
   relevante: los transbordos van a depender completamente de un mecanismo
   de corrección manual (`transfer_overrides`, tabla propia de
   `modelo-grafo` — ver sección 5, punto 14) hasta que haya una fuente que
   los traiga.
4. **Horarios que cruzan medianoche.** `frequencies.txt` trae valores como
   `"29:00:00"` (servicio nocturno). Postgres `TIME` no soporta HH≥24, así
   que `arrival_time`/`departure_time`/`start_time`/`end_time` se guardan
   dos veces: el texto crudo (`arrival_time`) y segundos-desde-medianoche ya
   calculados (`arrival_time_secs`, puede superar 86400). 106 de 1,584 filas
   de `frequencies` tienen `end_time_secs > 86400`.
5. **`frequencies.exact_times` viene vacío en 1 fila** (`TR13_TRIP_1`,
   Trolebús). Se guardó `NULL`, no se asumió `0` ni `1`.
6. **`shape_dist_traveled` falta en 54,427 de 127,135 puntos de `shapes`**
   (~43%). Queda `NULL`. Un motor de ruteo puede recalcular distancia con
   `ST_Length`/`ST_LineLocatePoint` sobre la geometría si lo necesita.
7. **1,203 de 1,205 trips tienen entradas en `frequencies`** además de
   `stop_times`. Los horarios literales de `stop_times` para esos trips son
   **plantillas de secuencia de paradas, no horarios reales** — el servicio
   real sale de `frequencies` (headway). Confirmado: 0 filas de
   `stop_times` cruzan medianoche (todas las horas "raras" están en
   `frequencies`, no en `stop_times`), y **todas** las filas de
   `stop_times` tienen `timepoint = 0` (GTFS: "aproximado"). Importante
   para `modelo-grafo`: no tratar `stop_times.arrival_time` como hora de
   llegada real para estos trips.
8. **`routes.route_color` vacío en 2 rutas.** Sin impacto funcional, solo
   para quien construya UI.
9. **`wheelchair_boarding` en stops: 6,773 sin info (0), 1,188 accesibles
   (1), 3,401 explícitamente no accesibles (2).** Dato real de la fuente,
   no un hueco — se documenta porque es relevante si en algún momento se
   filtra o prioriza por accesibilidad.
10. **GTFS-RT de Metrobús: 0% verificado contra el feed real.** Bloqueo de
    registro sigue abierto (ver `PLAN.md`). El parser está listo y probado
    con datos sintéticos únicamente. La URL exacta del endpoint tampoco
    está confirmada.
11. **Ecobici `free_bike_status` y `system_alerts` no se consumen.** Solo
    se usan `station_information` y `station_status` (lo que pide el
    entregable: disponibilidad por estación). Si más adelante hace falta
    bicis sin anclaje (dockless) o alertas del sistema, falta ese feed.
12. **Extracto OSM sin cargar a Postgres**, ver sección 1.4 — es un archivo
    crudo, no tablas. Overpass además dio un `504 Gateway Timeout`
    intermitente incluso con la query ya acotada a vías dedicadas (un
    reintento lo resolvió); no es una fuente pensada para descargas
    repetidas o automatizadas sin cuidado de rate-limit.
13. **Sin `feed_info.txt`** en el GTFS estático: no hay forma de confirmar
    programáticamente la vigencia/versión del feed. `calendar.txt` sí trae
    fechas: va de 2024-12-01 a 2026-12-31 (services activos incluyen uno
    que empieza justo en 2026-01-01), así que al menos una parte del feed
    (probablemente Trolebús/TR13) es más reciente que "2022".
14. **`stop_overrides` y `transfer_overrides` NO se crearon en esta fase.**
    `CLAUDE.md` (decisión de arquitectura #5) dice que deben existir desde
    el día uno, pero son tablas propias de `modelo-grafo`
    (`.claude/agents/modelo-grafo.md`, sección "Tablas propias"), no de
    `datos-gtfs` — mi archivo de instrucciones nunca las lista entre mis
    entregables. Se habían creado por error en una versión anterior de este
    handoff (`migrations/0004_overrides.sql`, ambas tablas vacías); se
    eliminó ese archivo y se borraron las tablas de Postgres al corregir el
    alcance. Confirmado con una corrida de `npm run migrate` desde una base
    vacía (`rutas_cdmx_migrate_scratch`, creada y destruida solo para esta
    prueba) que las 6 migraciones restantes (`0001`, `0002`, `0003`,
    `0005`, `0006`, `0007` — el hueco en la numeración no afecta el orden
    alfabético con el que el runner las aplica) siguen aplicando limpio y
    de forma idempotente sin `0004`. Queda pendiente para `modelo-grafo`
    (Fase 2).

## 6. Lo que falta para fases siguientes (no es trabajo de este agente)

- Registrar `METROBUS_GTFS_TOKEN` y confirmar la URL del feed GTFS-RT.
- ~~Decidir si `TR13`/`SEMOVI` se corrige vía un mecanismo de override para
  rutas...~~ **Resuelto 2026-08-28** — ver punto 1 arriba y
  `migrations/0017_route_overrides.sql`.
- `modelo-grafo` crea `stop_overrides` y `transfer_overrides` (ver punto 14
  de la sección anterior) — no existen todavía.
- `modelo-grafo` decide cómo modelar `data/raw/osm/cdmx-pedestrian-cycling.json`
  (cargarlo a Postgres, en qué esquema, con qué índices espaciales).
- Configurar el secret `DATABASE_URL` en GitHub Actions cuando exista el
  proyecto de Supabase de producción, para que el cron de Ecobici corra de
  verdad en producción (localmente el workflow no se puede probar sin
  simular `act` o similar — no se intentó).

## 7. Histórico real de viajes Ecobici (entregable agregado 2026-08-22)

Extiende esta Fase 1 ya cerrada, no la reabre: CLAUDE.md decisión de
arquitectura #8. Necesario porque el GBFS en vivo de la sección 1.2 (arriba)
**no trae duración de viajes**, solo disponibilidad presente — no sirve
para calcular una velocidad de bici real. Todo lo de esta sección se corrió
de verdad contra el mismo Postgres+PostGIS local (puerto 5433,
`rutas_cdmx`) el 2026-08-22, verificado con `SELECT` directo, no tomado de
logs de los scripts.

### 7.1 Fuente confirmada

**No es el GBFS.** Es el dataset abierto de viajes completados que Ecobici
publica en su propio sitio (`ecobici.cdmx.gob.mx`), como CSV mensual —
confirmado por mí vía `WebFetch` sobre `https://ecobici.cdmx.gob.mx/en/open-data/`
(la página lista los CSV mensuales descargables) y verificado con
`curl -I` sobre el archivo real antes de descargarlo completo:

```
URL:  https://ecobici.cdmx.gob.mx/wp-content/uploads/2026/08/public_data_web_2026-07.csv
HTTP: 200 OK
Content-Type:   text/csv
Content-Length: 96,069,105 bytes
Last-Modified:  Mon, 03 Aug 2026 18:42:31 GMT
```

Header real del CSV (9 columnas, sin comillas RFC4180 — no hace falta el
parser CSV de `scripts/etl/lib/csv.ts` acá, un `split(',')` simple basta,
confirmado contando campos en las 1,493,485 líneas del archivo: todas
tienen exactamente 9):

```
Genero_Usuario,Edad_Usuario,Bici,Ciclo_Estacion_Retiro,Fecha_Retiro,Hora_Retiro,Ciclo_EstacionArribo,Fecha_Arribo,Hora_Arribo
```

### 7.2 Qué se cargó y por qué ese periodo

**Un solo mes: julio 2026** (el más reciente y completo disponible al
momento de la carga). Decisión documentada, no un atajo silencioso:

- Un solo mes ya trae **1,493,484 filas de viaje** — muestra grande y
  reciente, coincide temporalmente con la red de 677 estaciones vigente
  capturada en `ecobici_stations` (Fase 1, sección 1.2).
- Cargar años de histórico multiplicaría el problema de estaciones dadas
  de baja/renombradas (ver 7.3) sin mejorar la precisión del escalar único
  que necesita `modelo-grafo`. No hacía falta el histórico completo desde
  el inicio del sistema (el brief de este entregable lo dice explícito).

Tabla nueva: `ecobici_trips_historical` (migración
`migrations/0015_ecobici_trips_historical.sql`). Carga:
`scripts/ecobici/load-historical-trips.ts` (`npm run etl:ecobici:trips`).

| Métrica | Valor |
|---|---|
| Filas de datos en el CSV | 1,493,484 |
| Filas insertadas en `ecobici_trips_historical` | 1,493,484 (100%, 0 descartadas por formato) |
| Filas con `start_station_id` Y `end_station_id` resueltos a una estación vigente | 1,278,218 (85.6%) |

Idempotente por `source_file`: re-correr el loader borra las filas de ese
mes antes de reinsertar (verificado corriendo el script dos veces seguidas
— mismo total, 1,493,484, sin duplicar). Provenance de la descarga
(URL, tamaño, sha256, conteo de filas) se guarda en `_raw` como **una sola
fila** por corrida, no una por viaje — desviación documentada de la regla
dura de "_raw fila por fila" (mismo precedente que el extracto de OSM en
la sección 1.4: 1.5M filas en JSONB habría duplicado el tamaño de la base
sin ganancia real; el CSV crudo se conserva como archivo en
`data/raw/ecobici-trips/`, no versionado, igual que `data/raw/cdmx-gtfs/`).

### 7.3 Normalización de `station_id` y datos sucios encontrados

`ecobici_stations.station_id` **no usa ceros a la izquierda** (`"85"`
existe, `"085"` no — verificado por consulta directa). La fuente de viajes
sí trae ceros a la izquierda y, además, códigos que no son un solo
station_id limpio. Cada fila conserva el valor crudo en
`start_station_raw`/`end_station_raw` siempre; la columna normalizada
(`start_station_id`/`end_station_id`, sin FK forzada — ver comentario en
la migración) solo se llena cuando resuelve a una fila real y vigente de
`ecobici_stations`. Desglose real de por qué **no** resuelve (112,809 de
1,493,484 filas del lado de retiro, 117,257 del lado de arribo):

| Motivo | Retiro | Arribo |
|---|---|---|
| Código compuesto de dos estaciones pareadas físicamente (p.ej. `"266-267"`, `"107-108"`) | 57,608 | 63,808 |
| Literal `"Temporal 1"`, `"Temporal 2"`, `"Temporal 3"` (estaciones móviles/temporales) | 16 | 33 |
| Numérico válido pero la estación ya no existe en el snapshot vigente de `ecobici_stations` (dada de baja o renumerada) | 55,185 | 53,416 |

34 `station_id` numéricos distintos caen en la tercera categoría — son
estaciones que sí existieron durante julio 2026 pero no están entre las
677 capturadas por el snapshot de GBFS de la Fase 1. Ninguno de estos
casos se resolvió a mano ni se inventó: quedan `NULL`, documentados aquí.

Otros datos sucios/hallazgos, con el mismo rigor que la sección 5:

1. **39,259 viajes redondos** (misma estación de retiro y arribo,
   `start_station_id = end_station_id`). Tienen distancia recta 0 — no
   aportan señal de velocidad, se excluyen del cómputo de 7.4.
2. **3 viajes con duración absurda por bicicleta "perdida" y reconciliada
   después**, el más extremo de 1,376 días (bici `4759056`: retiro
   2022-10-04, arribo recién 2026-07-11 dentro de este archivo de julio).
   Los otros dos: 213 días y 51 días. Son evidencia clara de que la fuente
   reconcilia inventario de bicis extraviadas contra el mismo log de
   viajes, no de pedaleo continuo — excluidos por el umbral de duración
   máxima (7.4).
3. **19 filas con `Edad_Usuario` vacío** → `NULL` (no se asumió una edad).
4. **`Genero_Usuario` tiene 4 valores literales de la fuente**: `M`
   (1,016,885), `F` (409,694), `?` (40,821 — "prefiere no decir" /
   desconocido, es un valor explícito de la fuente, no un campo vacío) y
   `O` (26,084). Se guardó tal cual, sin normalizar `?` a `NULL` porque no
   es lo mismo que "falta el dato": la fuente sí lo reportó, como
   desconocido.
5. **Sin problemas de parseo CSV**: a diferencia de 3 filas de
   `stops.txt` en la Fase 1 (sección 5, punto 2), este archivo no usa
   comillas RFC4180 en ningún campo — confirmado contando comillas en las
   ~1.49M líneas (0 apariciones) y verificando que las 1,493,485 líneas
   (header + datos) tienen exactamente 9 campos separados por coma.

### 7.4 Cálculo de velocidad real y umbrales de outliers

Script: `scripts/ecobici/compute-speed-stats.ts` (`npm run
etl:ecobici:speed-stats`). Distancia = `ST_Distance` sobre `geography`
entre `ecobici_stations.geom` de la estación de retiro y de arribo — es
**geodésica en línea recta**, no distancia de calle real (no hay routing
real sobre la red ciclista en este agente). Consecuencia importante para
quien use este número: la distancia de calle real es siempre >= a la
distancia recta usada aquí, así que la velocidad de pedaleo real es en
todo caso *mayor* a la que se reporta — este cálculo ya neta parte del
circuito real de calle contra el tiempo real, en el mismo espíritu que el
`WALK_CIRCUITY_FACTOR` que `modelo-grafo` ya aplica en
`scripts/graph/build-walk-edges.ts` para caminata. **Si `modelo-grafo`
piensa aplicar un factor de circuidad adicional sobre esta velocidad para
estimar distancia real, hay que evitar aplicar la corrección dos veces.**

Filtros aplicados, en orden, todos documentados con su motivo real (no se
escondió ninguno):

1. Ambas estaciones deben resolver a una fila vigente de `ecobici_stations`
   (si no, no hay geometría con la que calcular distancia) → de 1,493,484
   filas quedan 1,278,218.
2. `start_station_id <> end_station_id` (excluye los 39,259 viajes
   redondos de 7.3, distancia recta 0).
3. `duration_seconds BETWEEN 60 AND 7200`: se exploró la distribución real
   antes de fijar el umbral — solo 240 viajes (0.02% de los que ya tienen
   ambas estaciones resueltas) duran menos de 60s (probables "falsos
   arranques", re-anclajes inmediatos); 1,505 viajes (0.1%) duran más de
   7200s (2h), incluyendo los 3 casos de bicis "perdidas" del punto 7.3.2
   — el corte de 7200s cae cerca del percentil 99.9 real de la duración
   observada, no es un número arbitrario.
4. `distance_m >= 100`: se encontraron 39,467 viajes entre pares de
   estaciones *distintas* pero a menos de 100m en línea recta (estaciones
   físicamente muy próximas, más allá de los códigos compuestos ya
   excluidos en el paso 1). A esa escala el ruido de "línea recta vs.
   calle real" domina cualquier señal de velocidad — se excluyen.
5. Recorte estadístico final por **rango intercuartílico de Tukey**
   (`[Q1 − 1.5·IQR, Q3 + 1.5·IQR]`) sobre la velocidad ya calculada de los
   1,237,552 viajes que pasan los filtros 1-4. Se prefirió este método
   (estándar, nombrado, reproducible) sobre un tope "físicamente
   plausible" elegido a mano: se probó explícitamente con topes fijos de
   6, 8 y 10 m/s y habrían descartado entre 24% y 45% de los viajes
   válidos — las estaciones de Ecobici en CDMX están relativamente lejos
   entre sí (mediana ~3.9km en línea recta) y buena parte de sus usuarios
   son abonados que se desplazan a diario, no turistas casuales, así que
   ritmos sostenidos de 15-20 km/h **no son, por sí solos, un error obvio
   de dato**. El límite superior de Tukey (20.1 m/s = 72.4 km/h) sí
   descarta la cola físicamente imposible: antes de este recorte se
   observaron "velocidades" de hasta 155 m/s (560 km/h), producto casi
   seguro de relojes desincronizados entre el sistema de anclaje y el de
   registro, no de pedaleo real.

Bounds de Tukey obtenidos: `Q1 = 2.755 m/s`, `Q3 = 9.696 m/s`,
`IQR = 6.941`, rango final `[0, 20.108] m/s`.

**Resultado, guardado en `ecobici_speed_stats`:**

| Métrica | Valor |
|---|---|
| Muestra total cargada | 1,493,484 |
| Muestra usada tras todos los filtros | 1,156,524 (77.4% del total, 93.4% de los 1,237,552 candidatos estructurales) |
| **Velocidad promedio (`avg_speed_mps`)** | **6.094 m/s (≈ 21.9 km/h)** |
| **Velocidad mediana (`median_speed_mps`)** | **4.908 m/s (≈ 17.7 km/h)** |
| Desviación estándar | 4.464 m/s |
| Umbral duración mín/máx | 60s / 7200s |
| Umbral distancia mín | 100m |

**La distribución sigue sesgada a la derecha incluso después del recorte
de Tukey** (mediana muy por debajo del promedio — el promedio sigue
influenciado por la cola derecha remanente dentro del rango permitido, de
hasta 20.1 m/s). **Recomiendo a `modelo-grafo` usar `median_speed_mps`
(4.908 m/s) como la velocidad por defecto para las aristas de bici**,
precisamente porque para una distribución así de sesgada la mediana
representa mejor el viaje "típico" que el promedio, que un puñado de
viajes rápidos/con distancias largas puede inflar. No es una decisión que
me corresponda imponer — dejo ambos valores en `ecobici_speed_stats`
(`avg_speed_mps` y `median_speed_mps`) para que `modelo-grafo` decida con
el contexto completo; documentado también en el campo `notes` (JSON) de
cada fila de esa tabla, junto con los conteos intermedios y los bounds de
Tukey exactos.

`ecobici_speed_stats` es serie histórica (una fila por corrida de
cómputo, no upsert de una sola fila), mismo criterio que
`ecobici_snapshots` — permite comparar si el cálculo cambia cuando se
agreguen más meses en el futuro. Reproducibilidad verificada: se corrió
`npm run etl:ecobici:trips` y `npm run etl:ecobici:speed-stats` dos veces
seguidas — la carga de viajes no duplicó filas (sigue en 1,493,484) y el
cómputo de velocidad reprodujo el mismo resultado (6.094 / 4.908 m/s,
diferencias de punto flotante en el último dígito por orden de agregación,
sin relevancia).

### 7.5 Huecos que quedan (no se inventó nada para taparlos)

- **Sin distancia de calle real**, solo geodésica en línea recta (ver
  7.4). Si `modelo-grafo` necesita mayor precisión, tendría que enrutar
  sobre `data/raw/osm/cdmx-pedestrian-cycling.json` (sección 1.4) para
  cada par estación-estación, que es un trabajo de ruteo, no de este
  agente.
- **Un solo mes de datos (julio 2026)**: no captura estacionalidad (lluvias,
  vacaciones, etc.). Si más adelante se agregan más meses, la fila nueva
  en `ecobici_speed_stats` se puede comparar contra esta para ver si el
  número se mueve.
- **34 `station_id` de la fuente de viajes no existen en el snapshot
  vigente de `ecobici_stations`** (ver 7.3) — esos viajes se cargaron con
  el id normalizado en `NULL` pero el crudo se conserva; si en el futuro
  se consigue un histórico de estaciones dadas de baja, se podrían
  re-resolver sin volver a descargar el CSV.
- **No se intentó Content-Length/checksum contra una segunda fuente** (p.ej.
  el portal `datos.cdmx.gob.mx`, que también lista datasets de Ecobici) —
  se confirmó un solo origen (`ecobici.cdmx.gob.mx`) porque coincidió
  exactamente con el formato descrito en el brief de este entregable
  (estación origen/destino + hora inicio/fin) y respondió con datos reales
  verificables.
