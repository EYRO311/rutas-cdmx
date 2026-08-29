# 04 — Modo AUTO (Fase 3, agente `modo-auto`)

Código en `src/modes/auto/`. Todo lo que toca Postgres en este documento se
corrió de verdad contra el Postgres local (puerto 5433, base `rutas_cdmx`,
el mismo que usan las fases anteriores) — migración `0013_eta_cache.sql`
aplicada con `npm run migrate` y verificada con `information_schema` (ver
sección 4). Todo lo que toca Google Routes API es **implementación real
contra la forma pública y documentada de la API, nunca invocada** — ver la
sección 1 para el porqué exacto y la evidencia de que no se hizo ningún
request real.

## 0. Restricción dura de esta fase — cumplimiento

**No se hizo ningún request real contra Google Routes API en ningún
momento de este trabajo.**

- `GOOGLE_ROUTES_API_KEY` sigue vacía en `.env`, tal como estaba: no se
  tocó, no se pidió que se llenara.
- `GoogleRoutesProvider.getEta()` (`src/modes/auto/google-routes-provider.ts`)
  truena explícitamente con un mensaje claro si `apiKey` está vacía, **sin
  intentar el `fetch`** — probado en
  `tests/auto/google-routes-provider.test.ts` (`"truena con un mensaje
  claro si no hay API key, sin intentar el request"`), que además verifica
  con un mock de vitest que `fetch` nunca se llamó.
- Todos los demás tests de ese archivo inyectan `fetchImpl` (un mock de
  `vitest`) que responde con fixtures JSON construidos a mano con la forma
  real documentada de `computeRoutes` (verificada vía `WebFetch`/`WebSearch`
  contra `developers.google.com/maps/documentation/routes` el 2026-08-16 —
  endpoint, headers, field mask, shape de `Money` para `tollInfo`). Ningún
  test de este proyecto abre un socket hacia `routes.googleapis.com`.
- Esto es exactamente lo que pidió el orquestador: implementar el
  proveedor real, probarlo con mocks, y no gastar ni un solo request hasta
  que el cap de facturación en Google Cloud esté confirmado (bloqueo
  abierto en `PLAN.md`).

## 1. Contrato `EtaProvider`

```ts
// src/modes/auto/eta-provider.ts
interface LatLng { lat: number; lon: number; }

interface EtaRequest {
  origin: LatLng;
  destination: LatLng;
  departureTime: Date;   // afecta tráfico proyectado y la ventana de cache
  avoidTolls?: boolean;
}

type EtaProviderName = "google-routes" | "osrm";

interface EtaResult {
  provider: EtaProviderName;
  durationSecs: number;             // con tráfico, si el proveedor lo soporta
  staticDurationSecs: number | null; // sin tráfico, si el proveedor lo distingue
  distanceMeters: number;
  polyline: string | null;
  tollInfoMxn: number | null;        // costo estimado de casetas, si el proveedor lo trae
  fetchedAt: Date;
  fromCache: boolean;
}

interface EtaProvider {
  readonly name: EtaProviderName;
  getEta(request: EtaRequest): Promise<EtaResult>;
}
```

Implementaciones:

| Archivo | Rol | Estado real |
|---|---|---|
| `google-routes-provider.ts` | `GoogleRoutesProvider` — default | Implementación completa contra la API real. **Nunca invocada contra el endpoint real** (ver sección 0). Probada con fixtures HTTP mockeados. |
| `osrm-provider.ts` | `OsrmProvider` — fallback | Implementación completa contra el contrato HTTP real y estable de OSRM (`/route/v1/{profile}/{lon,lat};{lon,lat}`). **No hay ninguna instancia de OSRM corriendo en este proyecto todavía** (no está en `docker-compose`, no hay `osrm-backend` local ni remoto configurado) — ver sección 5. |
| `fallback-provider.ts` | `FallbackEtaProvider` | Compone dos `EtaProvider`: intenta el primario, si truena cae al secundario y notifica vía callback opcional. |
| `eta-cache.ts` | `CachingEtaProvider` + `getCachedEta`/`setCachedEta`/`windowStart` | Envuelve cualquier `EtaProvider` con lookup/write transparente en `eta_cache` (Postgres). |
| `costo.ts` | `calcularCostoAuto` | Gasolina + casetas + estacionamiento. No lee Postgres — recibe todo como input explícito. |
| `hoy-no-circula.ts` | `evaluarHoyNoCircula` | Hoy No Circula + Contingencia Ambiental. No toca red ni DB — función pura. |
| `index.ts` | `resolveAutoRoute`, `buildDefaultEtaProvider` | Orquesta las piezas de arriba en el orden correcto (ver sección 3). |

**Composición para producción** (una sola vez, reusar entre requests —
importante en serverless, no reconstruir por invocación si el runtime lo
permite reusar entre invocaciones "warm"):

```ts
import { buildDefaultEtaProvider, resolveAutoRoute } from "src/modes/auto/index.ts";

const provider = buildDefaultEtaProvider({
  googleApiKey: process.env.GOOGLE_ROUTES_API_KEY!,
  osrmBaseUrl: process.env.OSRM_BASE_URL!, // no existe todavía, ver sección 5
  pool, // pg.Pool ya existente (p.ej. de scripts/db.ts::getPool())
});

const resultado = await resolveAutoRoute(provider, {
  perfil: { terminacionPlaca, holograma, rendimientoKmPorLitro, precioLitroMxn, evitaCasetas, estacionamiento },
  origin, destination, departureTime,
  contingencia, // opcional — ver sección 2
});
```

`resolveAutoRoute` nunca expone qué proveedor respondió realmente ni si
vino de cache: eso vive detrás de `EtaProvider`, tal como pide el blindaje
#3. `algoritmo-ruteo`/`api-http` solo ven `ResolveAutoRouteResult`
(`disponible: false` con motivo, o `disponible: true` con `eta` + `costo`).

**Nadie fuera de `src/modes/auto/` construye un `EtaProvider` a mano** —
usan `buildDefaultEtaProvider` (o, en tests, un fake que implemente la
interfaz).

## 2. Hoy No Circula + Contingencia Ambiental

`evaluarHoyNoCircula(input): { restringido, motivo, confianza }` en
`hoy-no-circula.ts`. Se llama **antes** de tocar el `EtaProvider`
(`resolveAutoRoute` lo hace primero y retorna de inmediato si
`restringido === true`, sin llamar `provider.getEta()` — probado en
`tests/auto/resolve-auto-route.test.ts`, verificando con un mock que
`getEta` nunca se invocó cuando el auto no puede circular).

Reglas verificadas vía `WebSearch`/`WebFetch` el 2026-08-16 (no asumidas
del conocimiento de entrenamiento, porque el programa ha cambiado varias
veces en su historia) contra `sedema.cdmx.gob.mx`, `verificentroscdmx.com`
y `hoynocircula.info`:

**Programa regular** (lunes a sábado, 5:00-22:00; domingo circulan todos):
- Holograma `0`, `00` y `exento`: circulan todos los días.
- Holograma `1`, `2` y `foraneo`: descansan un color/terminación entre
  semana según tabla fija (`lunes=5,6 · martes=7,8 · miércoles=3,4 ·
  jueves=1,2 · viernes=9,0`).
- Sábado: holograma `2`/`foraneo` descansan siempre; holograma `1`
  descansa 1er/3er sábado (terminación non) o 2do/4to (terminación par); si
  el mes tiene 5to sábado, circulan todos los holograma `1`.

**Contingencia Ambiental (Fase 1 "doble hoy no circula" / Fase 2):** CAME
(Comisión Ambiental de la Megalópolis) anuncia **cada día de contingencia,
vía boletín**, exactamente qué terminaciones/hologramas adicionales se
restringen — esto **no es una tabla fija reproducible en código**, cambia
según qué tan grave está la calidad del aire ese día específico. Lo que sí
es estable y está codificado:

- Fase 1: holograma `2` se restringe al 100%; holograma `1` se restringe
  por paridad (todas las non o todas las par, según el boletín); holograma
  `0`/`00` — normalmente exentos — también quedan restringidos por
  terminación ese día.
- Fase 2: restricciones más severas que Fase 1 (las fuentes coinciden en
  que escala, sin una tabla fija reproducible).

`ContingenciaAmbiental.boletin` es el hook para pasar el boletín real del
día cuando exista una fuente de datos para él (scraping o API de CAME —
**no implementado en esta fase**, es trabajo futuro explícito). Si
`contingencia.activa` es `true` pero no se pasa `boletin`, la función usa
un **fallback conservador** documentado en el código (`hoy-no-circula.ts`,
función `evaluarConBoletinDesconocido`): Fase 2 restringe todo lo que no
sea `exento`; Fase 1 restringe holograma `1`/`2` sin importar terminación,
y holograma `0`/`00` solo si su terminación coincide con la que descansa
ese día en el programa regular. La razón de este diseño: equivocarse hacia
"sí puede circular" es el error caro (multa 20-30 UMA ≈ $2,346-$3,519 MXN
en 2026 + corralón); equivocarse hacia "no puede" solo le quita al usuario
la opción de AUTO ese día. El resultado trae `confianza: "baja"` en ese
caso para que quien consuma esto pueda, si quiere, avisar al usuario que
es una estimación conservadora y no el boletín oficial.

23 tests cubren esto en `tests/auto/hoy-no-circula.test.ts` (tabla
entre-semana completa, las 4 combinaciones de sábado + 5to sábado,
holograma exento/0/00, contingencia con boletín conocido y sin él en
ambas fases, terminación inválida).

## 3. Costeo

`calcularCostoAuto(input): { gasolinaMxn, casetasMxn, estacionamientoMxn, totalMxn }`
en `costo.ts`:

- **Gasolina** = `(distanciaMetros/1000 / rendimientoKmPorLitro) *
  precioLitroMxn`. Ni el rendimiento ni el precio del litro están
  hardcodeados aquí — vienen de `user_modes.rendimiento_km_l` /
  `user_modes.costo_combustible` (migración `0010`, Fase 2), porque el
  precio de la gasolina en CDMX cambia semana a semana y un valor fijo en
  código se desactualiza rápido.
- **Casetas** = `eta.tollInfoMxn` si el proveedor lo trajo (Google Routes
  con `extraComputations: ["TOLLS"]`, "solo disponible en ciudades
  seleccionadas" según la documentación de Google — no garantizado para
  CDMX); si es `null`, se asume **0**, no una heurística inventada.
  Justificación: para el propósito de esta comparación ("que el número
  demuestre que el auto casi nunca gana"), subestimar el costo real es el
  error caro, así que es mejor un 0 explícito y documentado que un número
  inventado que aparente precisión que no tiene.
- **Estacionamiento** = `tarifaPorHoraMxn * horasEstimadas`, ambos
  explícitos en el input (`EstacionamientoInput`), sin default silencioso.
  No hay una fuente de datos de tarifas de estacionamiento en CDMX
  integrada en esta fase — quien llame a `resolveAutoRoute` decide de
  dónde saca esos dos números (input manual del usuario, o una tabla
  futura por zona).

7 tests en `tests/auto/costo.test.ts`.

## 4. Cache de ETA en Postgres

Tabla `eta_cache` (migración `migrations/0013_eta_cache.sql`, aplicada y
verificada contra el Postgres local real):

```sql
CREATE TABLE eta_cache (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google-routes', 'osrm')),
  origin_lat DOUBLE PRECISION NOT NULL,
  origin_lon DOUBLE PRECISION NOT NULL,
  destination_lat DOUBLE PRECISION NOT NULL,
  destination_lon DOUBLE PRECISION NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,       -- ventana de 15 min, truncada en TS
  duration_secs INTEGER NOT NULL CHECK (duration_secs > 0),
  static_duration_secs INTEGER,
  distance_meters INTEGER NOT NULL CHECK (distance_meters >= 0),
  polyline TEXT,
  toll_mxn DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, origin_lat, origin_lon, destination_lat, destination_lon, window_start)
);
```

- **Por qué Postgres y no un `Map` en memoria** (blindaje #2): serverless
  (Vercel, `CLAUDE.md` decisión #6) no garantiza que una invocación fría
  vea nada de lo que tenía en RAM la invocación anterior. Un cache en
  memoria de proceso no cachea nada entre requests reales en ese entorno.
- **Bucketing de tiempo** (`windowStart()`, `eta-cache.ts`): trunca la
  `departureTime` hacia abajo a bloques de 15 minutos, en TypeScript (no
  en SQL) para poder probarlo sin tocar la base — probado con casos borde
  exactos (`08:14:59.999` cae en el bucket de `08:00`, `08:15:00.000` cae
  en el siguiente).
- **Redondeo de coordenadas**: 5 decimales (~1.1m en la latitud de CDMX)
  antes de cachear, para que un mismo origen/destino repetido (casa,
  trabajo — `saved_places`) golpee la misma fila incluso con jitter de GPS
  menor a esa precisión. Documentado como trade-off explícito: preferimos
  cache misses de más a servir el ETA de un punto ligeramente distinto.
- **Upsert** vía `ON CONFLICT ... DO UPDATE` sobre el índice único
  compuesto — dos requests dentro de la misma ventana actualizan la misma
  fila en vez de duplicar.
- **9 tests en `tests/auto/eta-cache.test.ts` corridos contra el Postgres
  local real** (no un mock de `pg`): cache miss inicial, write+read dentro
  de la misma ventana, miss en la ventana siguiente, redondeo de
  coordenadas verificado con puntos a 6 decimales de diferencia, upsert
  (confirmado con `SELECT count(*)` que no duplica fila), y que
  `google-routes`/`osrm` no comparten cache entre sí. Las pruebas limpian
  sus propias filas al terminar (`afterAll` con `DELETE ... WHERE
  origin_lat BETWEEN 9 AND 10`, coordenadas sentinela fuera del rango real
  de CDMX para no arriesgar datos reales).
- **Sin purga automática de filas viejas** en esta fase — uso personal,
  volumen bajo. Pendiente explícito si esto crece: un job que borre filas
  con `window_start` viejo.

## 5. Verificación de cuota y precio vigente (Google Routes API, SKU Pro)

Verificado vía `WebFetch` contra `developers.google.com/maps/billing-and-pricing/pricing`
el 2026-08-16 (sin usar ninguna API key):

| SKU | Free tier mensual | Precio por 1,000 llamadas (después del free tier) |
|---|---|---|
| **Compute Routes Pro** (incluye `TRAFFIC_AWARE`/`TRAFFIC_AWARE_OPTIMAL`, el que usa este proyecto) | **5,000 eventos** | 5,001-100,000: **$10.00** · 100,001-500,000: $8.00 · 500,001-1,000,000: $6.00 · 1,000,001-5,000,000: $3.00 · 5,000,001+: $0.75 (USD) |
| Compute Routes Essentials (referencia, no es el SKU usado) | 10,000 eventos | 10,001-100,000: $5.00 · ... |

Esto confirma el número que ya traía `.claude/agents/modo-auto.md`
("5,000 eventos gratis al mes" para el SKU Pro) contra la fuente pública
actual, y agrega el precio marginal después del free tier ($10 USD por
1,000 requests adicionales) — relevante para dimensionar qué tan grave
sería un bug con bucle si el cap de facturación (blindaje #1, todavía
pendiente en `PLAN.md`) no estuviera puesto.

## 6. Restricción de licencia de Google Maps Platform sobre cacheo

Verificado vía `WebFetch`/`WebSearch` contra `cloud.google.com/maps-platform/terms/maps-service-terms`
el 2026-08-16:

> "Customer no hará pre-fetch, cache, index, ni almacenará ningún
> `Content` (incluyendo cualquier Google Map o dato incluido en él) para
> usarlo fuera del Servicio, **excepto**: puede cachear temporalmente
> coordenadas de latitud/longitud (geocodes) hasta por **30 días
> consecutivos** para mejorar el desempeño, después de lo cual debe
> borrarlas. `place_id` está exento de esta restricción y se puede
> almacenar indefinidamente."

**Punto importante que hay que documentar con precisión, no simplificar:**
la excepción de 30 días que citan la mayoría de fuentes que hablan de
"cachear Google Maps" es específicamente para **coordenadas lat/lng**
(geocodes) y `place_id` — **no** para duración/ETA/tráfico de una ruta.
El texto de "no pre-fetch, cache, ni storage de Content" es la regla
general, y `duration`/`staticDuration`/`distanceMeters`/`tollInfo` de
`computeRoutes` no caen claramente dentro de la excepción de geocodes.

**Por eso `eta_cache` usa un TTL efectivo de 15 minutos** (bucket de
ventana temporal, ver sección 4) — muy por debajo de cualquier límite que
mencionan los Términos, y alineado con la razón de negocio real del cache
(evitar pedir el mismo tráfico dos veces en la misma ventana de
relevancia, no "almacenar" el dato). **Esto es defendible para el caso de
uso actual** (un único usuario beta, `CLAUDE.md` decisión #4, uso
personal, sin redistribuir el dato a terceros) pero **no está
verificado contra los Términos como un cache de "resultados de ruta" en
sentido estricto** — si este proyecto se abre a terceros (más de un
usuario, o un producto con usuarios externos), esto necesita revisión
legal/técnica explícita contra los Términos vigentes en ese momento antes
de reusar `eta_cache` tal cual. Este documento dice exactamente eso porque
`.claude/agents/modo-auto.md` lo pide explícito ("documenta la
restricción... para cuando la API se abra a terceros") — no se resuelve
aquí, se deja marcado.

## 7. Lo que no se hizo (explícito)

1. **Ningún request real contra Google Routes API** — por diseño, blindaje
   duro de esta fase (ver sección 0). `GoogleRoutesProvider` está
   implementado completo y probado con fixtures, pero nunca se ejecutó
   contra `routes.googleapis.com` de verdad. Esto se "arregla" solo cuando
   el orquestador confirme que el cap de facturación en Google Cloud ya
   está puesto (bloqueo en `PLAN.md`) — no antes, y no configurando una key
   sin esa confirmación.
2. **`OsrmProvider` nunca se probó contra un servidor OSRM real** — no hay
   ninguna instancia corriendo en la infra de este proyecto (no está en
   `docker-compose`, no hay contenedor `osrm-backend`). El código
   implementa el contrato HTTP real y documentado de OSRM y se prueba con
   fixtures mockeados, pero es honesto decir que nunca vio un OSRM real.
   Levantar `osrm-backend` con un extracto `.osm.pbf` de CDMX (distinto
   del extracto ya filtrado a peatonal/ciclista que usó `modelo-grafo` para
   `walk_edges` — OSRM necesita el `.osm.pbf` completo con vías
   vehiculares) es trabajo de infraestructura fuera del alcance de esta
   fase.
3. **Sin feed en vivo del boletín de CAME para Contingencia Ambiental** —
   `evaluarHoyNoCircula` acepta un boletín explícito si existe (
   `ContingenciaAmbiental.boletin`), pero no hay ningún scraper/API
   integrado que lo llene automáticamente. Sin él, se usa el fallback
   conservador documentado en la sección 2. Integrar una fuente real
   (SEDEMA/CAME publican el estado de contingencia, aunque no siempre en
   un formato fácil de scrapear) es trabajo futuro.
4. **Sin fuente de datos de tarifas de estacionamiento en CDMX** —
   `calcularCostoAuto` recibe `tarifaPorHoraMxn`/`horasEstimadas` como
   input explícito, no los deriva de ninguna tabla. No existe todavía una
   tabla de tarifas por zona; se decidió no inventar una constante global
   (el costo de estacionamiento varía muchísimo por alcaldía/colonia en
   CDMX) en vez de fingir precisión que no hay.
5. **Purga de `eta_cache`** no implementada (ver sección 4) — no hace
   falta con el volumen actual (un usuario), documentado como pendiente
   explícito si el proyecto crece.
6. **La restricción de licencia de Maps Platform sobre ETAs/rutas cacheadas
   no está resuelta, solo documentada** (sección 6) — es una decisión que
   corresponde a cuando (si) el proyecto se abra a terceros, no a esta
   fase de uso personal.

## 8. Tests corridos — números reales

```
$ npx vitest run tests/auto
 Test Files  7 passed (7)
      Tests  56 passed (56)
```

Desglose por archivo:

| Archivo | Tests | Qué prueba |
|---|---|---|
| `hoy-no-circula.test.ts` | 23 | Tabla entre semana completa, las 4 combinaciones de sábado + 5to sábado, holograma 0/00/exento, contingencia con boletín y sin él (Fase 1 y 2), validación de terminación inválida. |
| `costo.test.ts` | 7 | Gasolina, casetas (con valor, con `null`), estacionamiento, suma total, validaciones de rendimiento/precio inválidos. |
| `google-routes-provider.test.ts` | 10 | Parseo de `duration`/`Money`, mapeo de respuesta con y sin casetas, headers/field mask/body del request, error sin API key (sin llamar `fetch`), errores 4xx y respuesta sin rutas. |
| `osrm-provider.test.ts` | 4 | Orden de coordenadas lon/lat, mapeo de respuesta, `code` distinto de `Ok`, error 5xx, `profile` custom. |
| `fallback-provider.test.ts` | 3 | Primario exitoso no toca el fallback; primario falla y cae al fallback (con callback); ambos fallan propaga el error del fallback. |
| `eta-cache.test.ts` | 9 | `windowStart` puro (bucketing), cache miss, write+read en la misma ventana, miss en ventana siguiente, redondeo de coordenadas, upsert sin duplicar, aislamiento por `provider` — **todo contra Postgres local real**. |
| `resolve-auto-route.test.ts` | 4 (dentro de 7 en el archivo, contando describe raíz) | HNC bloquea sin llamar `getEta`; camino feliz con costo calculado; `evitaCasetas` se propaga como `avoidTolls`; contingencia Fase 2 sin boletín bloquea con `confianza: "baja"`. |

También se corrió el suite completo del repo (`npm test`) para confirmar
que nada de lo demás se rompió: **94 passed (94)**, 14 archivos — el
delta sobre los 56 de este agente son tests de otros agentes corriendo en
paralelo (`algoritmo-ruteo`, `api-http`), no tocados por este trabajo.

Typecheck: `npx tsc --noEmit` no reporta ningún error nuevo en
`src/modes/auto/` ni `tests/auto/` más allá de `TS5097` (imports con
extensión `.ts` explícita), que es un patrón pre-existente en **todo** el
repo (`scripts/`, `src/routing/`, etc. — 71 de las 85 líneas de error del
repo completo son ese mismo `TS5097`) porque el proyecto corre con `tsx`
(que sí resuelve `.ts`), no con `tsc` como mecanismo de build — no es algo
introducido por este agente ni algo que corresponda arreglar aquí.

## 9. Migración

`migrations/0013_eta_cache.sql` — aplicada. Nota sobre coordinación entre
agentes en paralelo: al correr `npm run migrate` para verificar, el
archivo ya aparecía "ya aplicada" con timestamp `2026-08-17T04:25:23.056Z`,
junto con `0014_api_keys.sql` (de `api-http`, corriendo en paralelo)
aplicada 47ms después en el mismo lote — confirma que otro agente corrió
`npm run migrate` sobre el mismo checkout casi al mismo tiempo y aplicó
ambos archivos nuevos juntos, sin colisión de número (`api-http` tomó
`0014`, como preveía la nota de coordinación del encargo). Verificado con
`information_schema.columns` que las 13 columnas de `eta_cache` en la base
real coinciden exactamente con las de la migración.
