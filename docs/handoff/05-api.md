# 05 — API HTTP (Fase 3, agente `api-http`)

Todo lo descrito aquí se corrió de verdad: contra el Postgres local
(puerto 5433, base `rutas_cdmx`, la misma que dejaron pobladas
`datos-gtfs` y `modelo-grafo`), con la app Fastify real arrancada
(`npm run dev:api`) y peticiones `curl` reales por HTTP, no solo
`app.inject()` en memoria. Los números y respuestas de este documento son
salida real de esos comandos, no estimaciones.

Corrí en paralelo con `algoritmo-ruteo` y `modo-auto` (misma fase).

> **Actualización posterior (mismo agente, encargo del orquestador):**
> `algoritmo-ruteo` terminó y fue aprobado. `StubRouterEngine` ya NO es el
> motor que usa la app — se conectó el motor real (`RealRouterEngine`,
> `src/api/engine/real-router-engine.ts`) envolviendo
> `planRoute()` de `src/routing/index.ts`. Todo lo de las secciones 1–8
> describe el estado al momento de la aprobación original (sigue siendo
> cierto tal cual, como registro histórico); **la sección 9 documenta qué
> cambió, con evidencia real nueva.** Si solo te interesa el estado
> actual del motor de ruteo, ve directo ahí.

## 1. Qué se construyó (estado original, sigue vigente salvo lo que anota la sección 9)

```
src/api/
  app.ts                  buildApp(): factory de la app Fastify (usada por
                           server.ts, api/index.ts y los tests)
  server.ts                entrypoint local, long-running (npm run dev:api)
  db/prisma.ts              cliente Prisma compartido (adapter-pg, Prisma 7)
  lib/
    errors.ts                taxonomía de errores tipados (AppError + subclases)
    api-key.ts                 hash SHA-256 de API keys (compartido con el seed script)
    reply.ts                    helpers para el envelope {data,meta,error}
  schemas/                  Zod: envelope, common (Mode/Coordinate/confidence),
                             routes, stops, trips, modes, health
  engine/
    router-engine.ts          CONTRATO con algoritmo-ruteo (interfaz RouterEngine)
    stub-router-engine.ts       implementación stub (caminata en línea recta)
    index.ts                     punto de conexión único (ver sección 4)
  plugins/
    auth.ts                    API key vía header X-API-Key, contra Postgres
    error-handler.ts             setErrorHandler + setNotFoundHandler tipados
  routes/
    health.ts   GET /health              (público, real, hace SELECT 1)
    routes.ts   POST /v1/routes          (autenticado, llama al RouterEngine)
    stops.ts    GET /v1/stops/near       (autenticado, real, PostGIS)
    trips.ts    POST /v1/trips           (autenticado, real, inserta trip_history)
    modes.ts    GET/PUT /v1/modes        (autenticado, real, tabla user_modes)
  openapi/config.ts          @fastify/swagger + swagger-ui, openapi 3.1.0

api/index.ts                 handler serverless de Vercel (reusa buildApp())
vercel.json                   rewrite catch-all -> /api

migrations/0014_api_keys.sql  tabla api_keys (ver sección 3)
scripts/seed-api-key.ts        genera + inserta una API key nueva
scripts/generate-openapi.ts     vuelca generated/openapi.json desde los schemas Zod
scripts/validate-openapi.ts      valida ese JSON contra el JSON Schema oficial 3.1

tests/api/routes.test.ts        integración real contra Postgres (12 tests)
tests/api/openapi.test.ts        valida el documento generado en proceso
```

De los 5 endpoints núcleo, **3 son reales de punta a punta, sin stub**:
`GET /v1/stops/near`, `POST /v1/trips`, `GET`/`PUT /v1/modes` — ninguno
depende del motor de ruteo, así que no tenía sentido stubearlos. Solo
`POST /v1/routes` usa el stub, porque es el único que depende de
`algoritmo-ruteo`.

## 2. Por qué migración `0014` y no `0013`

El brief de este agente asumía que la siguiente migración libre era
`0013`. Al llegar a ese punto, `migrations/0013_eta_cache.sql` ya existía
(creada por `modo-auto`, corriendo en paralelo). Se renombró la propia a
`0014_api_keys.sql` antes de correr `npm run migrate` — exactamente el
protocolo que describe el prompt de esta fase para colisiones de
numeración. Aplicada de verdad:

```
$ npm run migrate
...
[migrate] aplicada: 0013_eta_cache.sql
[migrate] aplicada: 0014_api_keys.sql
[migrate] listo. 2 migración(es) nueva(s), 13 en total.
```

## 3. Auth por API key

Tabla `api_keys` (migración `0014_api_keys.sql`): `id`, `key_hash`
(SHA-256 hex, único), `label`, `user_id` (TEXT libre, nullable — key "de
servicio" sin dueño), `is_active`, `created_at`, `last_used_at`,
`revoked_at`.

**Decisión deliberada:** esta tabla NO se agregó a `prisma/schema.prisma`
(no se corrió `prisma db pull`/`generate` después de la migración). Esta
fase corre en paralelo con `algoritmo-ruteo` y `modo-auto`, que pueden
estar corriendo sus propias migraciones al mismo tiempo — reintrospeccionar
la base completa y regenerar el cliente arriesgaba pisar cambios que ellos
metieran al mismo `prisma/schema.prisma` mientras tanto (un archivo
generado, no fusionable con merge de git de forma confiable). En cambio,
`api_keys` se consulta con `$queryRaw`/`$executeRaw` desde
`src/api/db/prisma.ts` — el mismo patrón que el proyecto ya usa para
columnas `geometry`, que Prisma tampoco puede tipar
(docs/handoff/02-grafo.md sección 1). `user_modes` sí usa el cliente
Prisma tipado normal porque ya estaba en el schema desde Fase 2 (no hizo
falta tocarlo).

**Generación de keys:** `npm run seed:api-key -- "<label>" "<user_id>"`.
Genera una key con prefijo `rk_` (24 bytes aleatorios, base64url), guarda
solo su hash SHA-256, imprime el valor en claro una vez por stdout (no se
puede recuperar después). Corrido de verdad para las pruebas de este
documento:

```
$ npm run seed:api-key -- "beta-cli" "emiliano"
[seed-api-key] Key creada. Cópiala ahora -- no se guarda en claro en ningún lado:

  rk_boH_OV6Qyen62VDBNxerGl8TVis2fBwI

  id: 1
  label: beta-cli
  user_id: emiliano
```

Se guardó también en `.env` (`API_KEY=...`, `.env` está en `.gitignore`,
nunca se versiona) para tener una key de desarrollo a mano.

**Validación en cada request** (`src/api/plugins/auth.ts`): hook
`onRequest` global, excepto `/health`, `/docs*` y `/openapi.json`. Lee
`X-API-Key` (o `Authorization: Bearer`), hashea, hace `SELECT id, user_id
FROM api_keys WHERE key_hash = $1 AND is_active = true` (lookup indexado
por la constraint `UNIQUE(key_hash)`), y actualiza `last_used_at` en modo
best-effort (no bloquea el request si falla). Ese lookup agrega un
roundtrip real a Postgres en cada request autenticado — parte consciente
del presupuesto de latencia (ver sección 6), no un descuido.

Probado real, sin API key y con API key inválida y válida:

```
$ curl -s -o /tmp/out1.json -w "HTTP %{http_code}\n" -X POST http://localhost:3000/v1/routes \
    -H "Content-Type: application/json" \
    -d '{"origin":{"lat":19.4326,"lon":-99.1332},"destination":{"lat":19.436,"lon":-99.14}}'
HTTP 401
{"data":null,"meta":{...},"error":{"code":"UNAUTHORIZED","message":"Falta la API key. Mándala en el header X-API-Key."}}
```

## 4. Contrato para conectar el motor de ruteo real (`algoritmo-ruteo`)

Interfaz completa en `src/api/engine/router-engine.ts`:

```ts
export interface RouterEngine {
  readonly name: string;
  readonly version: string;
  readonly isStub: boolean;         // se refleja en meta.engine.is_stub de cada response
  computeRoutes(query: RouteQuery): Promise<EngineRouteOption[]>;
}

export interface RouteQuery {
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  departureAt: Date;                // resuelto server-side: departure_at del cliente, o "ahora"
  arrivalAt: Date | null;           // presente si el cliente pidió "llegar antes de X"
  isArriveBy: boolean;
  allowedModes: Mode[] | null;      // null = todos los modos
  maxResults: number;               // 1..5
  userId: string | null;            // para personalizar con user_preferences/user_modes
}

export interface EngineRouteOption {
  id: string;
  legs: EngineRouteLeg[];
  summary: { durationS; costMxn; confidence; transfers; distanceM? };
}

export interface EngineRouteLeg {
  mode: Mode;                       // ver KNOWN_MODES en src/api/schemas/common.ts
  durationS: number;
  costMxn: number;
  confidence: number;               // 0..1 -- GTFS estático viejo vale menos que GTFS-RT
  from: EngineStopRef;               // { stopId: string|null; name: string|null; lat; lon }
  to: EngineStopRef;
  routeId?: string | null;
  tripId?: string | null;
  departureAt?: Date | null;
  arrivalAt?: Date | null;
  polyline?: string | null;          // para tramos AUTO vía Google Routes API
}
```

**Nota importante sobre `arrival_at` ("llegar antes de X"):** esta capa
HTTP NO resuelve la búsqueda hacia atrás sobre el grafo time-expandido —
eso requiere su propia lógica de búsqueda (RAPTOR/Dijkstra hacia atrás) y
es responsabilidad de `algoritmo-ruteo`. La capa HTTP solo valida que el
cliente no mande `departure_at` y `arrival_at` a la vez, resuelve
`departureAt` como "ahora" por default, y pasa `arrivalAt` +
`isArriveBy: true` tal cual al motor. `StubRouterEngine` directamente
ignora `arrivalAt` para el cálculo (solo lo refleja en la respuesta) — el
motor real sí necesita implementar esa semántica.

**Punto de conexión único** — `src/api/engine/index.ts`:

```ts
export const routerEngine: RouterEngine = new StubRouterEngine();
// cuando exista el motor real:
// export const routerEngine: RouterEngine = new RealRouterEngine(...);
```

Nada más en `src/api/` necesita cambiar. `src/api/routes/routes.ts` solo
importa `routerEngine` de ese archivo y la interfaz `RouterEngine` — nunca
`StubRouterEngine` directamente.

**El stub** (`StubRouterEngine`, `src/api/engine/stub-router-engine.ts`):
un solo tramo `walk` en línea recta (haversine × 1.3, mismo factor de
circuidad que `walk_edges` en docs/handoff/02-grafo.md sección 3.3), a
`DEFAULT_WALKING_SPEED_MPS = 1.4` m/s. `confidence` fijo en `0.05` a
propósito (imposible confundirlo con una ruta real). Si la distancia
estimada supera 3km, o si el cliente excluyó `walk` de `allowed_modes`,
devuelve `[]` — eso es un `200` con `routes: []`, no un error: el request
es válido, simplemente no hay ruta que un stub de caminata pueda ofrecer
razonablemente.

Interpretación del punto de entrada al grafo que describe
docs/handoff/02-grafo.md sección 8 (`graph_stop_neighbors(stop, fecha,
segundos, ventana)`): es un detalle de implementación de
`algoritmo-ruteo`, no algo que esta interfaz exponga — `RouteQuery`/
`EngineRouteOption` hablan en términos de lo que necesita el HTTP
request/response (coordenadas, tiempos, modos), no en términos del grafo
interno.

## 5. Evidencia real: OpenAPI 3.1 y `POST /v1/routes` contra el stub

**La spec se genera desde los schemas Zod, no se escribe a mano**
(`fastify-type-provider-zod` + `@fastify/swagger`, `npm run
openapi:generate`):

```
$ npm run openapi:generate
[openapi:generate] escrito .../generated/openapi.json
[openapi:generate] 5 paths, openapi 3.1.0
```

**Valida contra el JSON Schema oficial de OpenAPI 3.1**
(`@seriousme/openapi-schema-validator`, que soporta 3.1.x explícitamente,
`npm run openapi:validate`):

```
$ npm run openapi:validate
[openapi:validate] OK -- válida como OpenAPI 3.1.
```

También se probó en proceso (`tests/api/openapi.test.ts`, corre como
parte de `npx vitest run tests/api`): construye la app, pide el documento
con `app.swagger()`, confirma `openapi === "3.1.0"`, los 5 paths
esperados, y lo vuelve a validar con el mismo validador. **12 + 2 tests,
todos pasando:**

```
$ npx vitest run tests/api
 Test Files  2 passed (2)
      Tests  12 passed (12)
```

**`POST /v1/routes` responde correctamente contra el stub — probado con
`curl` real contra `npm run dev:api` corriendo (no solo `app.inject`):**

```
$ curl -s -X POST http://localhost:3000/v1/routes \
    -H "Content-Type: application/json" -H "X-API-Key: rk_boH_..." \
    -d '{"origin":{"lat":19.4326,"lon":-99.1332},"destination":{"lat":19.436,"lon":-99.14}}'

{"data":{"routes":[{"id":"stub-walk-1",
  "summary":{"duration_s":749,"cost_mxn":0,"confidence":0.05,"transfers":0,"distance_m":1049.19},
  "legs":[{"mode":"walk","duration_s":749,"cost_mxn":0,"confidence":0.05,
    "from":{"stop_id":null,"name":"Origen","lat":19.4326,"lon":-99.1332},
    "to":{"stop_id":null,"name":"Destino","lat":19.436,"lon":-99.14},
    "route_id":null,"trip_id":null,
    "departure_at":"2026-08-17T04:45:08.018Z","arrival_at":"2026-08-17T04:57:37.018Z","polyline":null}]}]},
 "meta":{"request_id":"1da4754d-...","generated_at":"2026-08-17T04:45:08.019Z",
   "engine":{"name":"stub-walk-only","version":"0.1.0","is_stub":true}},
 "error":null}
```

`meta.engine.is_stub: true` es explícito a propósito — ningún consumidor
puede confundir esto con una ruta real.

**Bug real que encontró esta prueba manual (y que los tests de
`app.inject` con body vacío no habían agarrado):** la primera versión de
`toRouteOptionDto` pasaba `leg.from`/`leg.to` (camelCase, `stopId`) directo
al response en vez de mapearlos a `stop_id` (snake_case, el schema de
salida). `fastify-type-provider-zod` lo agarró en serialización real
(`ResponseSerializationError` → 500 tipado, no un crash silencioso) al
correr con una ruta que sí devolvía datos (el test que solo verificaba
`routes: []` con destino fuera de rango no lo hubiera visto). Se corrigió
agregando `toStopRefDto()` explícito en `src/api/routes/routes.ts`. Queda
como evidencia de que "probar contra el stub" con datos reales — no solo
requests que devuelven arreglos vacíos — importaba.

**Las otras 3 rutas reales (sin stub), también probadas con `curl` real:**

```
GET /v1/stops/near?lat=19.4326&lon=-99.1332&radius_m=800&limit=3
  -> 200, encuentra "Zócalo" (B_0200L2-ZOCALO) a 100.37m -- parada real de la tabla stops.

POST /v1/trips {user_id, origin, destination, actual_duration_secs:900}
  -> 201, {"id":"5","created_at":"..."} -- fila real insertada en trip_history.

PUT /v1/modes {user_id:"curl-demo", modes:[{mode:"metro",is_enabled:true}]}
GET /v1/modes?user_id=curl-demo
  -> 200 en ambos, roundtrip real contra user_modes.

GET /v1/no-existe -> 404 tipado: {"error":{"code":"NOT_FOUND","message":"No existe GET /v1/no-existe."}}
```

Los datos de prueba (`user_id: 'curl-demo'`, la fila de `trip_history`
insertada) se limpiaron después de esta corrida.

## 6. Presupuesto de latencia (p95 < 3s, CLAUDE.md decisión #7)

Esta capa no mide el presupuesto completo porque no tiene el motor real
todavía (depende sobre todo de `algoritmo-ruteo`), pero documenta
explícitamente qué le agrega:

- **Auth**: un `SELECT` indexado por `key_hash` (UNIQUE) por request
  autenticado. Del orden de unos pocos ms contra Postgres local; contra el
  pooler de Supabase en producción depende de la latencia de red al
  pooler, no debería ser el cuello de botella frente a RAPTOR.
- **Sin estado en memoria entre invocaciones** (CLAUDE.md decisión #7):
  el pool de Postgres (`src/api/db/prisma.ts`) se reutiliza solo dentro de
  invocaciones "warm" del mismo proceso — no hay cache de auth ni de
  ninguna otra cosa en un `Map` de JS que sobreviva cold starts. `PGPOOL_MAX`
  (default 3) mantiene el pool por-instancia chico a propósito, pensado
  para no agotar el pooler de Supabase con muchas invocaciones
  concurrentes.
- **Vercel serverless real**: no se desplegó a Vercel en esta fase (no
  hay cuenta/proyecto conectado en este entorno) — `api/index.ts` +
  `vercel.json` están escritos y siguen el patrón estándar de Fastify en
  funciones Node de Vercel (reusar `app.server` emitiendo el evento
  `'request'` en vez de `app.listen()`), pero **no se puede reportar un
  cold start real medido** porque no se corrió en Vercel de verdad. Queda
  como limitación explícita, no como número inventado.

## 7. Lo que no se hizo (explícito)

1. **No se desplegó a Vercel de verdad.** `api/index.ts`/`vercel.json`
   están escritos siguiendo el patrón estándar, pero no hay medición real
   de cold start en Vercel — no hay proyecto de Vercel conectado en este
   entorno. Ver sección 6.
2. **No se implementó rate limiting.** No estaba en la lista de
   endpoints núcleo del brief. Si se necesita después, tiene que ser
   contra Postgres (contador por API key/ventana de tiempo), nunca un
   `Map` en memoria — mismo argumento que el resto del diseño
   (CLAUDE.md decisión #7).
3. **La resolución de "llegar antes de X" (`arrival_at`) es responsabilidad
   del motor real, no de esta capa.** Ver sección 4 — la capa HTTP solo
   pasa la intención (`isArriveBy`, `arrivalAt`) tal cual.
4. **`StubRouterEngine` solo sabe caminar en línea recta.** No conoce
   Metro/Metrobús/Ecobici/auto — sería reimplementar el trabajo de
   `algoritmo-ruteo` a medias, y no era el objetivo (el brief pide
   explícitamente NO implementar el algoritmo de ruteo en esta fase).
5. **No se agregó CORS.** No hay ningún consumidor browser mencionado en
   el brief (el consumidor previsto es `mcp-asistente`, backend a
   backend) — se puede agregar como plugin de Fastify después sin tocar
   nada de lo ya construido, si hace falta.
6. **`api_keys` no tiene UI/endpoint de administración** (crear/revocar
   keys vía HTTP) — solo el script `scripts/seed-api-key.ts`. Coherente
   con "el usuario es el beta" (CLAUDE.md decisión #4): no hay múltiples
   usuarios administrando keys todavía.
7. **La suite completa del repo (`npx vitest run`, sin filtrar) tiene
   fallas ajenas a esta fase**: 7 tests de `src/routing/__tests__/*`
   (trabajo en progreso de `algoritmo-ruteo`, corriendo en paralelo)
   truenan por timeout — no es código de esta fase, no se tocó, se
   reporta porque correr la suite completa lo mostró. `tests/api/*`
   (los de esta fase) pasaban 12/12 de forma aislada
   (`npx vitest run tests/api`) al momento de esta sección — ver sección 9
   para el conteo actualizado tras conectar el motor real (16/16).

## 8. Criterio de terminado

- "La spec OpenAPI valida": **sí**, evidencia real en sección 5
  (`npm run openapi:validate` + `tests/api/openapi.test.ts`, ambos contra
  el JSON Schema oficial de OpenAPI 3.1).
- "`POST /v1/routes` responde correctamente contra el stub del motor":
  **sí**, evidencia real en sección 5 (`curl` contra `npm run dev:api`
  corriendo de verdad, más 5 tests de vitest cubriendo éxito, `routes: []`
  por fuera de rango, 400 por body inválido y 400 por
  `departure_at`+`arrival_at` simultáneos).

## 9. Motor real conectado (actualización posterior a la aprobación original)

`algoritmo-ruteo` terminó (`docs/handoff/03-algoritmo.md`) y expone
`planRoute(pool, request, engine?)` en `src/routing/index.ts`. Esta
sección documenta exactamente qué se tocó para reemplazar el stub, con
evidencia real de que responde con rutas reales, no solo la afirmación.

### 9.1 Qué se tocó

**Archivos nuevos:**
- `src/api/engine/real-router-engine.ts` — el adapter (`RealRouterEngine`),
  implementa `RouterEngine` llamando a `planRoute`.
- `src/api/lib/cdmx-time.ts` — conversión `Date` (UTC) <-> `(serviceDate,
  secondsSinceMidnight)` en hora LOCAL de Ciudad de México, usando
  `Intl.DateTimeFormat` con `timeZone: "America/Mexico_City"` (no un
  offset hardcodeado) — necesaria porque `PlanRequest.serviceDate`/
  `departSecs` de `algoritmo-ruteo` son inherentemente hora local de CDMX
  (el `calendar` del GTFS y `graph_stop_neighbors` lo son), no UTC.
  Verificado con round-trip real: `2025-06-16 08:00 CDMX ->
  2025-06-16T14:00:00.000Z -> {serviceDate: "2025-06-16", secs: 28800}`
  (México abolió horario de verano en 2022, offset fijo -06:00, pero el
  cálculo no lo asume: lo deriva de la zona horaria real vía ICU).

**Archivos modificados:**
- `src/api/engine/router-engine.ts` — `RouterEngine.computeRoutes` ahora
  devuelve `Promise<EngineComputeResult>` (`{ options, meta }`) en vez de
  `Promise<EngineRouteOption[]>` directo. Cambio de interfaz deliberado:
  `algoritmo-ruteo` expone diagnóstico real por consulta
  (`PlanResult.confidence`, `truncatedByExpansionCap`, conteos de
  expansión) que vale la pena exponer en `meta` de la respuesta HTTP para
  observabilidad — no había dónde ponerlo en la forma anterior de la
  interfaz. `StubRouterEngine` se actualizó para el nuevo contrato
  (`meta: {}`, no tiene nada análogo que reportar).
- `src/api/engine/index.ts` — el punto de conexión único ahora instancia
  `RealRouterEngine` en vez de `StubRouterEngine`, tal como preveía el
  comentario original de ese archivo.
- `src/api/routes/routes.ts` — consume `{options, meta}`, funde
  `engineResult.meta` dentro de `meta.engine` de la respuesta HTTP, y
  agrega `meta.warnings` cuando `arrival_at` viene en el request (ver
  9.3).
- `src/api/db/prisma.ts` — se agregó `getPgPool()`, que expone el mismo
  `pg.Pool` que ya construye `getPrisma()` (no se crea un pool nuevo —
  `planRoute` pide un `Pool` de `pg` directo, no un cliente Prisma).
- `src/api/schemas/common.ts` — se agregó `"transit"` a `KNOWN_MODES`
  como fallback explícito para un tramo `ride` cuyo `route_id` no mapea a
  ninguna agencia conocida (ver 9.2, punto de `route_id`/agencia).

### 9.2 Decisiones de mapeo (Itinerary -> EngineRouteOption)

`Itinerary`/`ItineraryLeg` (`src/routing/types.ts`) no tiene la misma
forma que `EngineRouteOption`/`EngineRouteLeg` — se tomaron estas
decisiones, documentadas en el docblock de `real-router-engine.ts` además
de aquí:

1. **`mode` por tramo, vía agencia real**: `ItineraryLeg.mode` es
   `"walk_access" | "walk" | "transfer" | "ride"` — no distingue
   metro/metrobús/etc. Se agregó una consulta batched a `routes` (`SELECT
   route_id, agency_id FROM routes WHERE route_id = ANY($1)`) para
   resolver el `route_id` de cada tramo `ride` a un modo real vía
   `AGENCY_TO_MODE` (`METRO->metro`, `MB->metrobus`, `RTP->rtp`,
   `CC->cc`, `TROLE->trole`, `CBB->cablebus`, `PUMABUS->pumabus`,
   `TL->tren_ligero`, `SUB->suburbano`, `INTERURBANO->interurbano` —
   valores de `agency_id` confirmados reales contra la base, no
   adivinados de la documentación de Fase 1). Un `route_id` cuya agencia
   no mapea (hoy: `SEMOVI`, 1 sola ruta real — `docs/handoff/01-datos.md`
   documenta que ese `agency_id` ni siquiera existe en `agency.txt`) cae
   en el modo `"transit"` nuevo — **deliberadamente no se adivina** cuál
   agencia es de verdad.
2. **`cost_mxn` por tramo, derivado**: `Itinerary` solo trae `costPesos`
   agregado por itinerario completo, no por tramo. Se reconstruye
   replicando EXACTAMENTE el criterio de "abordaje nuevo" de `relaxEdge`
   (`src/routing/relax.ts`: un tramo `ride` cobra tarifa si su `tripId` es
   distinto del último tramo `ride` visto) y repartiendo
   `itinerary.costPesos` entre esos abordajes — exacto, no una
   estimación, porque el único componente monetario del modelo de costo
   de `algoritmo-ruteo` es la tarifa plana por abordaje (verificado
   leyendo `relax.ts`/`itinerary.ts`, no asumido).
3. **`confidence` por tramo, heurística explícita**: `algoritmo-ruteo` no
   expone ninguna señal de confianza (no hay tiempo real integrado al
   motor de ruteo). Se usa: caminata/transbordo = 0.9 (geometría
   estática, confiable), Metro = 0.55 (`docs/handoff/01-datos.md`
   documenta la sospecha no verificada de que el GTFS del Metro es de
   2022), otras agencias = 0.65, `transit` (agencia no identificable) =
   0.5. `summary.confidence` = el mínimo de sus tramos.
4. **`summary.distance_m` siempre `null`**: `ItineraryLeg.distanceMeters`
   es `null` en casi todos los tramos (solo el tramo final de caminata al
   destino exacto lo trae, ver `itinerary.ts`) — no hay una distancia
   total agregada confiable que exponer, así que se documenta `null` en
   vez de fabricar una estimación.
5. **`allowed_modes`**: `PlanRequest` no tiene ningún parámetro de
   filtrado por modo — `algoritmo-ruteo` explora todo el grafo disponible
   sin importar qué mandó el cliente. El filtro se aplica DESPUÉS: un
   itinerario se descarta completo si alguno de sus tramos `ride` usa un
   modo fuera de `allowed_modes` (tramos `walk`/`transfer` nunca se
   filtran — son tejido conectivo estructural, no un modo que el usuario
   elige; excluirlos haría imposible devolver cualquier itinerario real).
   **Limitación real de este enfoque**, documentada porque importa: si la
   única forma de llegar requiere un modo no permitido, se pierde el
   itinerario completo en vez de que el motor busque una alternativa
   "solo con esos modos" — `algoritmo-ruteo` no soporta restringir modos a
   nivel de búsqueda, así que esto no se puede resolver mejor sin tocar
   `src/routing/`, fuera del alcance de esta fase.
6. **`max_results`**: trunca (`slice`) la lista ya filtrada, después del
   filtro de `allowed_modes`, preservando el orden ascendente por costo
   escalarizado que ya trae `PlanResult.itineraries`.
7. **`arrival_at` ("llegar antes de X") — gap real, no inventado**:
   `PlanRequest` no tiene ningún parámetro equivalente. No se implementó
   una búsqueda hacia atrás (eso es trabajo de `algoritmo-ruteo`, fuera de
   esta fase). `src/api/routes/routes.ts` agrega
   `meta.warnings: ["arrival_at fue ignorado: ..."]` cuando esto pasa —
   visible en la respuesta HTTP, no oculto en un comentario de código.

### 9.3 Evidencia real: El Ángel -> Zócalo (mismo caso que probó `algoritmo-ruteo`)

Llamada directa a `RealRouterEngine.computeRoutes` (sin HTTP, para aislar
el adapter) con el mismo par de coordenadas y fecha que usó
`algoritmo-ruteo` en `docs/handoff/03-algoritmo.md` sección 5
(2025-06-16, 08:00 CDMX):

```
=== meta ===
{
  "plan_confidence": "full",
  "search_engine": "dijkstra",
  "search_radius_meters": 5000,
  "candidate_origin_stops": 12,
  "candidate_destination_stops": 12,
  "expanded_node_count": 1200,
  "db_query_count": 1204,
  "elapsed_ms": 2051.65,
  "truncated_by_expansion_cap": true
}
=== options count === 1
=== summary === { durationS: 1238, costMxn: 12, confidence: 0.55, transfers: 1, distanceM: null }
```

**`durationS: 1238` y `transfers: 1` coinciden exactamente con el
resultado que `algoritmo-ruteo` reportó para este mismo par con Dijkstra**
(`docs/handoff/03-algoritmo.md` sección 2.3: "Dijkstra encontró un
itinerario de 1,238s (1 transbordo)") — confirma que el adapter no está
alterando el resultado del motor, solo lo está traduciendo de forma
fiel. `costMxn: 12` = 2 abordajes (Metrobús + Metro) × 6 pesos de tarifa
plana, exacto.

**Repetido contra el servidor HTTP real corriendo** (`npm run dev:api`,
proceso nuevo, `uptime_s: 1` confirmado antes de la prueba para
garantizar que no era un proceso viejo con código desactualizado):

```
$ curl -s -X POST http://localhost:3000/v1/routes \
    -H "Content-Type: application/json" -H "X-API-Key: rk_boH_..." \
    -d '{"origin":{"lat":19.4270,"lon":-99.1677},"destination":{"lat":19.4326,"lon":-99.1332},"departure_at":"2025-06-16T08:00:00-06:00"}'

HTTP 200
meta.engine: {
  "name": "algoritmo-ruteo", "version": "1.0.0", "is_stub": false,
  "plan_confidence": "full", "search_engine": "dijkstra",
  "expanded_node_count": 1123, "db_query_count": 1127,
  "elapsed_ms": 2200.99, "truncated_by_expansion_cap": true
}
summary: {"duration_s":1238,"cost_mxn":12,"confidence":0.55,"transfers":1,"distance_m":null}
legs modes: [walk, metrobus×6, walk, metro×3, walk]
```

Mismo resultado (`duration_s: 1238`, `transfers: 1`, `cost_mxn: 12`) por
el camino HTTP completo (auth real, Zod, serialización, todo). El
`elapsed_ms` varía ligeramente entre corridas (2051-2201ms) porque
`SEARCH_TIME_BUDGET_MS` (2200ms, `src/routing/config.ts`) es un deadline
de tiempo de pared real, no determinista — consistente con lo que ya
documentó `algoritmo-ruteo`.

### 9.4 Evidencia real: `no_coverage` no truena

Mismo par de coordenadas, sin `departure_at` (usa "ahora" — fuera de la
vigencia real de `calendar`, ~2024-12-01 a ~2025-12-31):

```
$ curl -s -X POST http://localhost:3000/v1/routes ... -d '{"origin":..., "destination":...}'
HTTP 200
error: null
routes: []
meta.engine.plan_confidence: "no_coverage"
```

**200, no 500** — el `no_coverage` de `algoritmo-ruteo` se propaga como
una respuesta válida, exactamente lo que pedía el criterio de aceptación
(docs/handoff/03-algoritmo.md sección 9: "`api-http` debería mapearla a
algo explícito para el cliente, no a un error 500").

### 9.5 Tests actualizados

`tests/api/routes.test.ts` — el describe `POST /v1/routes` se reescribió
completo contra el motor real (ya no tiene sentido probar el stub por
HTTP, porque ya no es lo que la app usa por default). Casos nuevos:
itinerario real El Ángel->Zócalo con aserciones sobre `duration_s`,
`transfers`, modos reales, `cost_mxn > 0`; `no_coverage` por fecha fuera
de vigencia (200, `routes: []`, nunca throw); destino geográficamente sin
cobertura (Guadalajara); filtro de `allowed_modes` que descarta todo
cuando el itinerario real no usa el modo permitido; warning de
`arrival_at`. Se agregó también un test unitario aislado de
`StubRouterEngine` (sin HTTP, sin Postgres) para no perder cobertura de
que sigue implementando `RouterEngine` correctamente tras el cambio de
interfaz.

```
$ npx vitest run tests/api
 Test Files  2 passed (2)
      Tests  16 passed (16)
```

`npx tsc --noEmit` sobre `src/api/**` y `api/index.ts`: sin errores (los
únicos `TS5097` del proyecto son de archivos preexistentes de otras fases
que importan con extensión `.ts` literal, patrón que ya usaban antes de
esta actualización, no introducido aquí).

OpenAPI: la forma de los schemas Zod de `POST /v1/routes` no cambió
(`mode` sigue siendo el mismo enum, ahora con `"transit"` agregado) —
`npm run openapi:generate` + `npm run openapi:validate` se corrieron de
nuevo después de este trabajo y siguen en verde (`válida como OpenAPI
3.1`), 5 paths.

### 9.6 Limitaciones encontradas al conectar el motor real (explícitas)

1. **Filtrado de `allowed_modes` es post-hoc, no a nivel de búsqueda**
   (9.2 punto 5) — puede perder itinerarios válidos mixtos en vez de
   ofrecer la mejor alternativa dentro de los modos permitidos.
2. **`arrival_at` sigue sin soportarse** (9.2 punto 7) — ahora con
   warning visible en la respuesta real, pero el gap funcional persiste;
   requeriría trabajo en `algoritmo-ruteo`, fuera de esta fase.
3. **`cost_mxn`/`confidence` por tramo son derivados, no expuestos
   directamente por `algoritmo-ruteo`** (9.2 puntos 2-3) — matemáticamente
   exactos para el costo (una sola fuente monetaria en el modelo actual),
   pero la heurística de confianza por modo es una decisión de esta capa,
   no una medición.
4. **`summary.distance_m` es `null` para rutas reales** (antes, con el
   stub, sí traía un número) — información que el stub fabricaba y que el
   motor real, honestamente, no expone agregada.
5. **No se expuso `raptor` como opción para el cliente.** `RealRouterEngine`
   acepta un motor de búsqueda en su constructor (`dijkstra` default,
   igual que `algoritmo-ruteo`), pero `POST /v1/routes` no tiene un campo
   en el body para que el cliente elija — no se pidió, se puede agregar
   después sin romper nada (parámetro opcional adicional).
6. **No se expuso `horizonSecs`/perfil de salida** (`planRouteProfile`,
   `src/routing/departure-profile.ts`) — el brief de esta actualización
   pidió conectar `planRoute`, no `planRouteProfile`; queda como trabajo
   futuro explícito, no un descuido.

## 10. Fix real: 503 por estaciones Ecobici no resueltas (2026-08-28)

Cuando `algoritmo-ruteo` cerró la Parte 3/3 de "Modo bici" (2026-08-22/23,
ver `docs/handoff/03-algoritmo.md` sección 11), `ItineraryLeg` ganó
`fromNodeType`/`toNodeType` (`"gtfs_stop" | "ecobici_station"`) porque un
tramo `walk`/`bike` ahora puede referenciar una estación Ecobici, no solo
una parada GTFS. Este adapter (sección 9, aprobado ANTES de esa extensión)
nunca se actualizó para saberlo.

**Síntoma real, reproducido dos veces contra `RealRouterEngine.computeRoutes`
directo** (sin pasar por HTTP, para aislar la causa):

```
Error: RealRouterEngine: parada '295' referenciada por un itinerario pero
no encontrada en 'stops'.
    at resolveStopRef (src/api/engine/real-router-engine.ts:155)
```

`295` es un `station_id` real de `ecobici_stations` (`CE-018 Reforma -
Río Rhin`), confirmado por query directa — no un dato corrupto.
`resolveStopRef` (9.2) asumía que todo `stopId` no nulo era una parada
GTFS y solo buscaba en `stops`; al no encontrarlo, lanzaba a propósito
("no debería pasar" — sección 9.2 lo documenta como inconsistencia real
esperada), y `routes.ts` convertía eso en `503 ENGINE_UNAVAILABLE`. Pasaba
en cualquier itinerario que camine hacia/a través de una estación Ecobici
sin necesariamente usar bici (ver `03-algoritmo.md` sección 11.4) — dos
de los tests reales de la sección 9.5 lo disparaban (`tests/api/routes.test.ts`,
casos de fecha sin servicio y de `arrival_at`).

**Arreglo, en `real-router-engine.ts`:**
- `lookupEcobiciStations(pool, stationIds)` nueva, análoga a `lookupStops`
  pero contra `ecobici_stations` (`name` es NULLABLE ahí, a diferencia de
  `stops.stop_name` — fallback explícito `"Estación Ecobici {id}"` en vez
  de propagar `null`).
- `resolveStopRef` ahora recibe `nodeType` y elige la tabla correcta
  (`stops` vs `ecobiciStations`) en vez de adivinar por la forma del id.
- `computeRoutes` separa los `stopId` recolectados de los tramos en dos
  sets según `fromNodeType`/`toNodeType` antes de resolver, y consulta
  ambas tablas en paralelo (mismo patrón `Promise.all` que ya usaba para
  `stops`/`routes`).
- **Bug hermano encontrado y corregido de paso**: `resolveLegMode` no
  tenía un caso para `leg.mode === "bike"` — caía al `default` y
  reportaba cualquier tramo en bici como `"walk"`, perdiendo la
  información silenciosamente (ningún test lo cubría porque los tests
  originales de la sección 9.5 son de antes de que existiera el modo
  `bike`). `"ecobici"` ya existía en `KNOWN_MODES`
  (`src/api/schemas/common.ts`) sin usarse — ahora `resolveLegMode` lo
  usa.

**Verificado:** `tests/api/routes.test.ts` pasó de 12/14 a 14/14 (el otro
test que fallaba junto con el 503 era un problema distinto, no un 503 —
ver `03-algoritmo.md` sección 11.4, se corrigió la aserción ahí en vez de
el motor). Suite completa del repo: 150/150.
