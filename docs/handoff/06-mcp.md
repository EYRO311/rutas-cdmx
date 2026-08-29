# 06 — Servidor MCP (Fase 4, agente `mcp-asistente`)

Todo lo descrito aquí se corrió de verdad: contra la API HTTP real
(`npm run dev:api`, puerto 3000, motor de ruteo real conectado --
`RealRouterEngine` sobre `src/routing/index.ts`, ver docs/handoff/05-api.md
sección 9) y contra el mismo Postgres local (puerto 5433, base
`rutas_cdmx`). El protocolo MCP también se probó de punta a punta: un
`Client` real del SDK oficial (`@modelcontextprotocol/sdk`), conectado por
`StreamableHTTPClientTransport` a un servidor HTTP real que envuelve el
mismo handler que corre en `api/mcp.ts` -- no se llamó a las funciones de
las tools directamente saltándose el protocolo. Corrí en paralelo con
`qa-rutas` (bloqueado esperando datos reales del usuario, sin
dependencias entre nosotros).

## 1. Qué se construyó

```
src/mcp/
  config.ts            env vars: RUTAS_API_URL, RUTAS_API_KEY, DATABASE_URL
  http-client.ts        cliente fetch hacia la API HTTP real -- nunca importa src/api/
  db.ts                  pool de Postgres propio, SOLO LECTURA, SOLO para
                          saved_places y ecobici (sin equivalente HTTP hoy)
  places.ts               resuelve "casa"/"ESCOM"/coords -> lat/lon, o candidatos
  format.ts                helpers de lenguaje natural (duración, dinero, confianza...)
  route-summary.ts          colapsa legs por-salto del motor real en tramos legibles
  server.ts                  registra las 5 tools en un McpServer
  local-stdio.ts              entrypoint local por stdio (npm run mcp:stdio)
  tools/
    calcular-ruta.ts          POST /v1/routes
    paradas-cercanas.ts        GET /v1/stops/near
    registrar-viaje.ts          POST /v1/trips
    estado-ecobici.ts            Postgres directo (ecobici_stations/snapshots)
    puede-circular-hoy.ts         GET /v1/modes + import directo de evaluarHoyNoCircula

api/mcp.ts              handler serverless de Vercel, Streamable HTTP, stateless
vercel.json               (modificado) ruta /mcp -> api/mcp.ts antes del catch-all existente
package.json               (modificado) + "mcp:stdio": "tsx src/mcp/local-stdio.ts"
```

No se tocó nada dentro de `src/api/`, `src/routing/` ni `src/modes/` --
solo se **importó** (lectura) una función pura de `src/modes/auto/` (ver
sección 3) y dos constantes de forma de `src/api/schemas/common.ts`
inlineadas como copia literal en los tools (no import, para no crear una
dependencia de build entre este servidor y `src/api/`; ver nota en
`calcular-ruta.ts`/`registrar-viaje.ts` si hace falta re-sincronizar el
enum de modos a mano cuando cambie `KNOWN_MODES`).

## 2. Cómo conectarlo

### Local, por stdio (Claude Desktop / Claude Code / cualquier cliente MCP de escritorio)

1. `npm run dev:api` en una terminal (dejarlo corriendo).
2. Configurar el cliente MCP para lanzar:
   ```json
   {
     "mcpServers": {
       "rutas-cdmx": {
         "command": "npx",
         "args": ["tsx", "src/mcp/local-stdio.ts"],
         "cwd": "/ruta/a/rutas-cdmx",
         "env": {
           "RUTAS_API_URL": "http://localhost:3000",
           "RUTAS_API_KEY": "rk_...",
           "DATABASE_URL": "postgresql://postgres:dev@localhost:5433/rutas_cdmx"
         }
       }
     }
   }
   ```
   (`RUTAS_API_KEY` = el valor de `API_KEY` en `.env`, generado con
   `npm run seed:api-key`. `DATABASE_URL` puede omitirse si ya está en
   `.env` del cwd -- `local-stdio.ts` carga `dotenv/config`.)
3. `npm run mcp:stdio` (o dejar que el cliente lo lance) imprime en
   stderr `[mcp-asistente] servidor MCP conectado por stdio.` cuando está
   listo.

### Producción, Vercel (Streamable HTTP)

1. Mismo proyecto de Vercel que la API HTTP (`api/index.ts`) -- se
   agregó `api/mcp.ts` como función adicional. `vercel.json` ahora tiene
   una regla explícita `"/mcp" -> "/api/mcp"` ANTES del catch-all
   `"/(.*)" -> "/api"` que ya existía, para que este path no se lo trague
   la API HTTP.
2. Variables de entorno en Vercel (mismas que la API HTTP, más las
   propias de este servidor): `DATABASE_URL` (pooler de Supabase),
   `RUTAS_API_URL` (URL pública del deployment, ej.
   `https://rutas-cdmx.vercel.app`), `RUTAS_API_KEY` (una API key real,
   generada con `npm run seed:api-key` contra la base de producción).
3. El cliente MCP remoto apunta a `https://<deployment>/mcp` con
   transporte Streamable HTTP (`StreamableHTTPClientTransport` del SDK, o
   el soporte nativo de MCP remoto del cliente que sea). Solo acepta
   `POST` -- `GET`/`DELETE` devuelven 405 explícito (no hay sesiones que
   cerrar en modo stateless).
4. **No se desplegó a Vercel de verdad en esta fase** (mismo motivo que
   documentó `api-http`, sección 6 de docs/handoff/05-api.md: no hay
   cuenta/proyecto conectado en este entorno). `api/mcp.ts`/`vercel.json`
   siguen el patrón oficial del SDK para transporte stateless
   (`simpleStatelessStreamableHttp.ts` en los ejemplos del propio
   paquete), pero no hay medición real de cold start en Vercel.

## 3. Las 5 herramientas

| Tool | Envuelve | Nota |
|---|---|---|
| `calcular_ruta` | `POST /v1/routes` (motor real) | principal -- ver sección 5 |
| `paradas_cercanas` | `GET /v1/stops/near` | real desde Fase 3, nunca fue stub |
| `registrar_viaje` | `POST /v1/trips` | inserta en `trip_history` real |
| `estado_ecobici` | Postgres directo | sin endpoint HTTP -- ver sección 4 |
| `puede_circular_hoy` | `GET /v1/modes` + import directo | sin endpoint HTTP -- ver sección 4 |

Cada una tiene su propio `inputSchema` en Zod con `.describe()` por
campo con ejemplos concretos de CDMX (ver los archivos en
`src/mcp/tools/`) y una `description` de nivel-tool que dice **cuándo**
usarla (con ejemplos de frases de usuario) y cuándo NO ("no uses esto
para X, usa Y") -- es el entregable real de esta fase, no el código.

## 4. Decisiones

### 4.1 `estado_ecobici` -- Postgres directo, no HTTP

`src/api/routes/` no tiene ningún endpoint de Ecobici (confirmado
leyendo `src/api/app.ts`: solo registra health/routes/stops/trips/modes).
El brief de esta fase autoriza explícitamente esta ruta ("consulta
directa a `ecobici_snapshots`/`ecobici_stations` vía la API o Postgres").
Se eligió Postgres directo (`src/mcp/db.ts`, pool propio de solo lectura,
nunca escribe) en vez de proponer un endpoint nuevo en `src/api/` porque
eso está fuera de mi alcance (tocaría código de `api-http`). El pool es
independiente del de `src/api/db/prisma.ts` a propósito -- importar ese
módulo arrastraría el cliente Prisma completo de otro agente a este
servidor solo para dos `SELECT`.

Consultado en vivo: 677 estaciones reales (`ecobici_stations`), 1354
snapshots reales (`ecobici_snapshots`, alimentados por el cron real de
GitHub Actions, `scripts/ecobici/snapshot.ts`) -- los snapshots
disponibles al momento de esta prueba tenían ~16h de antigüedad (el cron
no corrió más veces en este entorno de desarrollo), y la herramienta lo
dice explícito ("actualizado hace 16 h") en vez de aparentar un dato en
vivo.

**Limitación real, ya documentada por `algoritmo-ruteo`** (docs/handoff/
03-algoritmo.md sección 8, punto 1): Ecobici NO participa de
`calcular_ruta` -- el grafo no expande vecinos desde una estación
Ecobici. `estado_ecobici` es standalone, nunca se mezcla con una ruta
calculada. La descripción de la tool lo advierte explícito.

### 4.2 `puede_circular_hoy` -- import directo de `evaluarHoyNoCircula`, no HTTP

`modo-auto` (Fase 3) construyó y probó `evaluarHoyNoCircula`
(`src/modes/auto/hoy-no-circula.ts`), pero **ningún endpoint de
`api-http` la expone** -- confirmado leyendo `src/api/app.ts` (solo
health/routes/stops/trips/modes registrados) y docs/handoff/05-api.md
(nunca menciona el modo AUTO). El brief de esta fase deja la decisión
explícitamente abierta ("¿importas la función directamente... o
documentas el gap y dejas la herramienta con una implementación
parcial?").

**Decisión: importar la función directamente** (dependencia de código
entre módulos, no vía HTTP), documentada en el docblock de
`src/mcp/tools/puede-circular-hoy.ts`. Razones:

1. Es una función **pura**: se leyó el archivo completo --
   `src/modes/auto/hoy-no-circula.ts` no tiene ningún `import`, cero I/O,
   cero conexión a Postgres, cero red. No arrastra nada de `modo-auto`
   más allá de un cálculo de calendario (a diferencia de, por ejemplo,
   `eta-provider.ts`, que sí necesita `GOOGLE_ROUTES_API_KEY` y hace
   requests reales).
2. El brief prohíbe explícitamente inventar un endpoint HTTP nuevo en
   `src/api/` (fuera de mi alcance). La alternativa real a "importar la
   función" no era "un endpoint HTTP", era "dejar la tool sin lógica
   real" -- y HNC es justo el caso de uso central del brief original de
   `modo-auto` ("¿me conviene sacar el coche hoy?").
3. A diferencia de `calcular_ruta` (que sí depende del GTFS con vigencia
   limitada), la evaluación de HNC es pura lógica de calendario -- nunca
   da "sin cobertura", funciona para cualquier fecha, lo que la hace
   particularmente barata de ofrecer bien en vez de a medias.

**Costo real aceptado**: si `modo-auto` cambia la firma o el
comportamiento de `evaluarHoyNoCircula` en el futuro, este servidor se
rompe en build time (import directo, TypeScript lo marca), no
silenciosamente en runtime -- se consideró preferible a las otras dos
opciones.

La config del vehículo (`terminacion_placa`, `holograma`) SÍ viene por
HTTP real cuando se manda `user_id` (`GET /v1/modes`, tabla
`user_modes`, poblada antes con `PUT /v1/modes`) -- solo la función de
evaluación en sí es import directo. Probado real: se guardó
`{mode:"auto", terminacion_placa:3, holograma:"1"}` vía `PUT /v1/modes`
real y `puede_circular_hoy({user_id})` lo leyó correctamente vía
`GET /v1/modes` real y evaluó "NO puede circular el miércoles...
terminación 3 descansa este día (holograma 1)" -- correcto (miércoles
descansa 3,4 en el programa regular).

**Gotcha de zona horaria resuelto explícitamente**: `evaluarHoyNoCircula`
llama a `fecha.getDay()`/`getDate()`/`getMonth()` -- métodos que leen la
zona horaria LOCAL del proceso, no UTC. Un proceso corriendo en Vercel
(típicamente UTC) calcularía mal el día de la semana para una fecha CDMX
cerca de medianoche. `puede-circular-hoy.ts` incluye `cdmxCalendarDate()`,
que deriva año/mes/día/hora reales de CDMX vía `Intl.DateTimeFormat` con
`timeZone: "America/Mexico_City"` y construye un `Date` con esos
componentes como "locales" -- el día de la semana de una fecha calendario
es un hecho absoluto, así que mientras se escriban y lean los componentes
de forma consistente el resultado es correcto sin importar la zona
horaria real del proceso. Mismo problema que resolvió
`src/api/lib/cdmx-time.ts` para el motor de ruteo (05-api.md sección 9),
resuelto aquí con una función propia porque la forma de salida que
necesito (`Date`) es distinta a la de ese helper (`{serviceDate, secs}`).

### 4.3 Resolución de lugares (`"casa"`, `"ESCOM"`) -- Postgres directo sobre `saved_places`

Tabla real `saved_places` (migración `0010_user_tables.sql`, Fase 2) ya
tiene exactamente lo que pedía el brief -- `user_id`, `label`, `lat`,
`lon`, `UNIQUE(user_id, label)` -- pero tampoco tiene ningún endpoint
HTTP. Mismo argumento que Ecobici (sección 4.1): Postgres directo, mismo
pool de solo lectura de `src/mcp/db.ts`, sin tocar `src/api/`.

`resolvePlace()` (`src/mcp/places.ts`): si el texto matchea el patrón
`lat,lon`, se usa directo. Si no, busca en `saved_places` del `user_id`
dado: exacto (case-insensitive) primero, luego `ILIKE '%texto%'`. Cero
o más de un resultado -> la tool NO adivina, devuelve la lista de
lugares guardados del usuario (o "ninguno") para que el asistente le
pregunte -- regla dura del brief, probada real: `"al centro"` con
`saved_places = {casa, oficina}` devolvió
`'No reconozco "al centro"... Sus lugares guardados son: "casa",
"oficina". Pregunta cuál quiso decir, o pide coordenadas.'`.

**Limitación real, documentada sin adornos**: este proyecto NO tiene
ningún geocodificador de texto libre conectado (CLAUDE.md solo menciona
Google Routes API para ETA de auto, nunca Google Geocoding ni
Nominatim). Por eso "candidatos" aquí significa, honestamente,
coincidencias dentro de `saved_places` del usuario -- nunca una búsqueda
geográfica real de topónimos libres tipo "Roma Norte" o "el centro" sin
que el usuario los haya guardado antes. Si se quiere ese comportamiento
completo, hace falta un geocodificador nuevo en el stack -- fuera del
alcance de esta fase (y no pedido por CLAUDE.md).

## 5. Evidencia real end-to-end

Cliente MCP oficial (`Client` + `StreamableHTTPClientTransport`,
`@modelcontextprotocol/sdk`) contra un servidor HTTP real que corre el
mismo handler que `api/mcp.ts`, con `npm run dev:api` corriendo de
verdad en paralelo (motor real conectado). `saved_places` de prueba
(`mcp-test-user`: "casa" = El Ángel, "oficina" = Zócalo -- mismo par que
ya probaron `algoritmo-ruteo`/`api-http`) y `user_modes` de prueba
sembrados y borrados al final de la corrida (mismo patrón que
docs/handoff/05-api.md sección 5).

**`calcular_ruta`, coordenadas explícitas, fecha real dentro de la
vigencia del GTFS (2025-06-16, lunes 08:00 CDMX):**

```
args: {"origen":{"lat":19.427,"lon":-99.1677},"destino":{"lat":19.4326,"lon":-99.1332},
       "hora_salida":"2025-06-16T08:00:00-06:00","max_resultados":2}
isError: false

1 ruta(s) de (19.4270, -99.1677) a (19.4326, -99.1332):

Ruta 1: 21 min, 1 transbordo, $12 MXN, confianza media
Sale 08:00 hora CDMX.
1. Camina 2 min ((19.4270, -99.1677) -> El Ángel)
2. Metrobús: El Ángel -> Hidalgo, 11 min
3. Camina 2 min (Hidalgo -> Hidalgo)
4. Metro: Hidalgo -> Zócalo, 3 min
5. Camina 2 min (Zócalo -> (19.4326, -99.1332))
```

`21 min` / `1 transbordo` / `$12 MXN` coinciden con `duration_s: 1238`
(1238/60 ≈ 21), `transfers: 1`, `cost_mxn: 12` que reportó `api-http` para
ESTE MISMO par exacto contra el servidor HTTP real (docs/handoff/05-api.md
sección 9.3) -- confirma que esta capa no altera el resultado del motor,
solo lo traduce y lo colapsa (5 legs de salida visibles arriba vs. los
~11 legs crudos por-salto que reportó `api-http`, "metrobus×6,
metro×3" -- ver sección 6 sobre por qué se colapsan). Respuesta completa:
~75 palabras, muy por debajo del presupuesto de 500 tokens.

**Mismo par, mismos lugares guardados ("casa"->"oficina"), misma
fecha -- confirma que la resolución de nombre + HTTP real dan el mismo
resultado que coordenadas explícitas:**

```
args: {"origen":"casa","destino":"oficina","user_id":"mcp-test-user",
       "hora_salida":"2025-06-16T08:00:00-06:00"}
1 ruta(s) de "casa" a "oficina":
Ruta 1: 21 min, 1 transbordo, $12 MXN, confianza media
[... mismos 5 tramos ...]
```

**Sin fecha (hoy, fuera de la vigencia real del GTFS) -- confirma que el
`no_coverage` de la sección 9.4 de `05-api.md` se traduce a texto
explícito, no a un error genérico:**

```
No encontré ninguna ruta de (19.4270, -99.1677) a (19.4326, -99.1332).
Sin cobertura de horarios para esa fecha/hora (el GTFS cargado tiene
vigencia real aproximadamente 2024-12-01 a 2025-12-31 -- si no mandaste
hora_salida se usó 'ahora', que puede caer fuera de ese rango). Prueba
con una fecha dentro de esa vigencia.
```

**Lugar no reconocido (`"al centro"`) -- confirma manejo de ambigüedad
sin adivinar:**

```
Origen: No reconozco "al centro" -- no son coordenadas válidas y no
coincide con ningún lugar guardado de este usuario. Sus lugares
guardados son: "casa", "oficina". Pregunta cuál quiso decir, o pide
coordenadas.
```

**`paradas_cercanas` (Zócalo, radio 500m):**

```
Paradas cerca de (19.4326, -99.1332):
1. Zócalo -- 100 m (accesible en silla de ruedas)
2. 20 de Noviembre -- 373 m (accesible en silla de ruedas)
3. Museo de la Ciudad -- 392 m (accesible en silla de ruedas)
4. C. C. República del Salvador - José María Pino Suarez y Mesones -- 397 m
5. Museo de la Ciudad -- 408 m (accesible en silla de ruedas)
```

Coincide con la parada real que ya había encontrado `api-http`
("Zócalo" a 100.37m, docs/handoff/05-api.md sección 5) -- el 100m
redondeado aquí es el mismo dato real, solo formateado.

**`estado_ecobici` por lugar (cerca de El Ángel) y por nombre:**

```
Estaciones Ecobici cerca de (19.4270, -99.1677):
1. CE-024 Reforma- Florencia (58 m): 6 bicis disponibles, 12 espacios libres (actualizado hace 16 h).
2. CE-017 Reforma - Río Tiber (69 m): 3 bicis disponibles, 21 espacios libres (actualizado hace 16 h).
3. CE-016 Reforma - Río Tiber (100 m): 5 bicis disponibles, 24 espacios libres (actualizado hace 16 h).

CE-710 Molino del Rey - Glorieta de la Lealtad: 4 bicis disponibles,
30 espacios libres (actualizado hace 16 h).
```

**`puede_circular_hoy`, tres casos reales** (programa regular sin
restricción, contingencia Fase 1 sin boletín con fallback conservador
marcado confianza baja, y vía `user_id`/`GET /v1/modes` real):

```
SÍ puede circular el jueves, 20 de agosto. Programa regular: terminación
no restringida hoy.                                  [placa 7, holograma 2]

SÍ puede circular el jueves, 20 de agosto. Holograma 0: terminación no
coincide con la restringida hoy (fallback conservador de Fase 1).
(confianza BAJA -- es un estimado conservador por contingencia sin
boletín oficial confirmado, verifica con SEDEMA/CAME)

NO puede circular el miércoles, 19 de agosto. Programa regular:
terminación 3 descansa este día (holograma 1).      [vía user_id real]
```

**`registrar_viaje`:**

```
args: {"user_id":"mcp-test-user","origen":"casa","destino":"oficina",
       "duracion_real_min":38,"duracion_planeada_min":34,
       "modos_usados":["walk","metro"],"calificacion":4,
       "notas":"prueba real de mcp-asistente"}
Viaje registrado (id 17). Gracias -- esto ayuda a calibrar mejor las
próximas rutas.
```

Confirmado con una query directa a `trip_history` que la fila 17 existía
de verdad con los datos correctos antes de borrarla en la limpieza de la
prueba (mismo patrón que `05-api.md` sección 5: datos de prueba
limpiados después de la corrida).

**Un caso real de "encontré la parada pero no una ruta"**, para dejar
documentado que no todo par de coordenadas produce una ruta aunque la
fecha sea válida: `El Ángel -> (19.5039, -99.1467)` (Zacatenco/ESCOM
real, ~9km) con `departure_at` válido devolvió
`plan_confidence: "no_coverage"` igual (confirmado con `curl` directo
contra `/v1/routes`, no es un bug de esta capa: `search_radius_meters:
8000`, `candidate_destination_stops: 12`, `truncated_by_expansion_cap:
true` -- el motor sí encontró paradas candidatas cerca del destino pero
no conectó un itinerario dentro de su presupuesto de expansión real,
limitación ya documentada por `algoritmo-ruteo`, docs/handoff/
03-algoritmo.md sección 4 "pérdida de completitud Pareto bajo carga").
Por eso el ejemplo de "lugares guardados" de esta sección usa Zócalo real
en vez de coordenadas inventadas de ESCOM -- se prefirió un ejemplo que
demuestre el camino feliz de verdad en vez de forzar uno que no conecta.

**Regresión**: `npx vitest run tests/api` sigue en 16/16 después de
agregar `src/mcp/`, `api/mcp.ts` y el cambio a `vercel.json`/`package.json`
(no se tocó nada que esos tests cubran). `npx tsc --noEmit` sobre todo el
repo no agrega ningún error nuevo fuera de dos categorías ya presentes
antes de esta fase: los `TS5097` preexistentes (imports con extensión
`.ts` literal, documentados como aceptados en 05-api.md sección 9.5) y la
misma fricción de `exactOptionalPropertyTypes: true` contra tipos de una
librería externa que ya existía en `prisma.config.ts` (aquí, contra los
accessors `onclose`/`onerror` que declara el SDK de MCP) -- resuelta con
un cast de tipos documentado en el docblock de `api/mcp.ts`, sin cambiar
comportamiento en runtime.

## 6. Diseño de la respuesta compacta

- **Colapsado de tramos** (`src/mcp/route-summary.ts`): el motor real
  expone un leg por SALTO del grafo (evidencia real en 05-api.md sección
  9.3: un solo viaje en Metrobús aparece como 6 legs consecutivos, uno
  por parada intermedia). Volcar eso tal cual reventaría el presupuesto
  de tokens en cualquier viaje real con más de un par de paradas. Se
  colapsan corridas consecutivas de legs con el mismo `mode` + `route_id`
  en un solo tramo ("Metrobús: El Ángel -> Hidalgo, 11 min") antes de
  formatear texto -- confirmado con el ejemplo real de la sección 5 (11
  legs crudos -> 5 líneas de texto).
- **Tiempos en lenguaje natural**: `formatDuration()` nunca imprime
  segundos crudos ("21 min", "1 h 5 min"). `formatMoney()` nunca imprime
  el número pelón ("gratis", "$12 MXN"). `describeConfidence()` traduce
  el número 0-1 a "alta"/"media"/"baja" y marca explícitamente cuándo
  advertir al usuario (`confidence < 0.5`) -- regla dura del brief.
- **Nunca JSON crudo**: cada tool devuelve `content: [{type:"text",...}]`
  con la salida de `renderRouteOption()`/formateadores equivalentes,
  nunca el envelope `{data,meta,error}` de la API tal cual.

## 7. Lo que no se hizo (explícito)

1. **No se desplegó a Vercel de verdad** -- mismo motivo que `api-http`
   (sección 2 de este documento, y sección 6 de 05-api.md): sin cuenta de
   Vercel conectada en este entorno. `api/mcp.ts`/`vercel.json` siguen el
   patrón oficial documentado por el propio SDK para transporte
   stateless, pero no hay cold start real medido.
2. **No hay geocodificador de texto libre** (sección 4.3) -- "candidatos"
   ante ambigüedad significa coincidencias dentro de `saved_places` del
   usuario, no una búsqueda geográfica real de topónimos libres. Este
   proyecto nunca conectó Google Geocoding/Nominatim (CLAUDE.md solo
   menciona Google Routes API para ETA de auto).
3. **`allowed_modes` hereda la limitación de `api-http`**: el filtro es
   post-hoc sobre itinerarios ya calculados (docs/handoff/05-api.md
   sección 9.2 punto 5) -- si la única forma real de llegar usa un modo
   excluido, `calcular_ruta` reporta "no encontré ninguna ruta" en vez de
   ofrecer la mejor alternativa dentro de los modos permitidos. No es
   arreglable desde esta capa sin tocar `src/routing/`.
4. **`hora_llegada` ("llegar antes de X") sigue sin resolverse de
   verdad** -- se pasa tal cual al motor (que la ignora y avisa por
   `meta.warnings`, ver 05-api.md sección 9.2 punto 7); `calcular_ruta`
   propaga ese aviso en texto (`"Aviso: arrival_at fue ignorado..."`) en
   vez de ocultarlo.
5. **No se implementó ningún tipo de caché ni rate limiting** en este
   servidor -- cada llamada a una tool es una invocación fresca contra la
   API real y/o Postgres, coherente con "stateless entre invocaciones"
   del brief. Si se necesita después, tendría que ser contra Postgres
   (mismo argumento que ya documentó `api-http`), nunca un `Map` en
   memoria de proceso.
6. **No se probó contra el pooler de Supabase de producción** -- todo
   contra Postgres local, puerto 5433, igual que el resto de las fases.
7. **No se agregó un `outputSchema` estructurado a las tools** -- todas
   devuelven `content: [{type:"text"}]` puro. Se decidió así a propósito
   (la regla dura es "texto compacto y legible", y el consumidor real es
   un asistente conversacional, no una UI que necesite campos tipados) --
   si en el futuro hace falta que el asistente parsee campos específicos
   (ej. `duration_s` exacto para lógica propia), se puede agregar
   `outputSchema` sin romper el texto existente.
8. **Modo AUTO como ruta completa/terminal** (CLAUDE.md decisión #3) NO
   tiene ninguna tool en este servidor más allá de `puede_circular_hoy` --
   no hay forma de pedir un ETA de auto real (`src/modes/auto/eta-provider.ts`
   necesita `GOOGLE_ROUTES_API_KEY`, que está vacía en `.env` de este
   entorno, y de cualquier forma no hay endpoint HTTP que lo exponga,
   mismo gap que documenta la sección 4.2). Fuera del alcance que pidió
   el brief de esta fase (solo pedía las 5 tools listadas).

## 8. Criterio de terminado

- "Las 5 herramientas existen y envuelven la API real": **sí** -- 3 vía
  HTTP real (`calcular_ruta`, `paradas_cercanas`, `registrar_viaje`), 2
  con decisión documentada y justificada de acceso directo (`estado_ecobici`
  a Postgres, `puede_circular_hoy` a Postgres+import puro) porque no
  tienen equivalente HTTP y agregarlo estaba fuera de mi alcance.
- "Descripciones dicen cuándo usar cada tool, con ejemplos de CDMX":
  **sí** -- ver `description` de cada `registerTool()` en
  `src/mcp/tools/*.ts`.
- "Manejo de ambigüedad sin adivinar": **sí**, evidencia real en sección 5
  (`"al centro"` devuelve candidatos, nunca una coordenada inventada).
- "Respuestas compactas, tiempos en lenguaje natural, ruta completa <500
  tokens": **sí**, evidencia real en sección 5-6 (~75 palabras por
  respuesta de ruta completa, nunca segundos/JSON crudo).
- "Confidence bajo se advierte explícito": **sí** -- `describeConfidence()`
  marca `shouldWarn` bajo 0.5 y el texto lo dice ("OJO, dato poco
  confiable, adviértele al usuario"); Metro real (`confidence: 0.55`) cae
  en "media", no dispara la advertencia -- coherente con la heurística
  real de `api-http` (05-api.md sección 9.2 punto 3: Metro = 0.55 porque
  se sospecha, no se confirma, que su GTFS es de 2022).
