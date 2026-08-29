/**
 * Cache de ETA en Postgres, por (origen, destino, ventana de 15 min) —
 * blindaje #2 de .claude/agents/modo-auto.md. Deliberadamente NO es un
 * `Map` en memoria de proceso: en serverless (Vercel, ver CLAUDE.md
 * decisión #6) cada invocación puede arrancar en frío sin nada de lo que
 * la anterior tenía en RAM, así que un cache en memoria de proceso no
 * cachea nada en la práctica. La tabla es `eta_cache` (migración 0013).
 *
 * Restricción de licencia de Maps Platform (ver docs/handoff/04-auto.md
 * para el detalle completo): esta tabla persiste resultados de Google
 * Routes por más que el request individual, así que el TTL de 15 minutos
 * es la salvaguarda deliberada — mucho más corto que cualquier ventana que
 * mencionan los Términos de Servicio (30 días para lat/lng cacheados). No
 * hay borrado activo de filas viejas en esta fase (uso personal, volumen
 * bajo); si esto se abre a terceros hace falta un job que purgue filas con
 * window_start viejo, documentado como pendiente explícito.
 *
 * Bucketing de tiempo y redondeo de coordenadas viven aquí (no en SQL) a
 * propósito: es la única pieza de esta cache con lógica no trivial, y así
 * se puede probar sin tocar Postgres (ver tests/auto/eta-cache.test.ts).
 */
import type { Pool } from "pg";
import type {
  EtaProvider,
  EtaProviderName,
  EtaRequest,
  EtaResult,
  LatLng,
} from "./eta-provider.ts";

const WINDOW_MS = 15 * 60 * 1000;

/**
 * Precisión de redondeo de coordenadas antes de cachear: 5 decimales
 * (~1.1m en latitud a la latitud de CDMX). Suficiente para que un mismo
 * origen/destino guardado (casa, trabajo, ESCOM — saved_places) golpee la
 * misma entrada de cache en requests repetidos, sin colapsar puntos
 * distintos que casualmente caen cerca. Un GPS con jitter de más de esa
 * precisión no compartirá cache entre dos requests del "mismo" punto —
 * trade-off documentado, no un bug: preferimos cache misses de más a
 * servir el ETA de un punto ligeramente distinto.
 */
const COORD_DECIMALS = 5;

function roundCoord(value: number): number {
  const factor = 10 ** COORD_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** Trunca una fecha a su ventana de 15 minutos (hacia abajo). Exportada para poder probarla directo. */
export function windowStart(date: Date): Date {
  const ms = date.getTime();
  return new Date(Math.floor(ms / WINDOW_MS) * WINDOW_MS);
}

export interface EtaCacheKey {
  provider: EtaProviderName;
  origin: LatLng;
  destination: LatLng;
  departureTime: Date;
}

interface EtaCacheRow {
  duration_secs: number;
  static_duration_secs: number | null;
  distance_meters: number;
  polyline: string | null;
  toll_mxn: string | null; // numeric llega como string por pg
}

export async function getCachedEta(
  pool: Pool,
  key: EtaCacheKey
): Promise<EtaResult | null> {
  const { rows } = await pool.query<EtaCacheRow>(
    `SELECT duration_secs, static_duration_secs, distance_meters, polyline, toll_mxn
     FROM eta_cache
     WHERE provider = $1
       AND origin_lat = $2 AND origin_lon = $3
       AND destination_lat = $4 AND destination_lon = $5
       AND window_start = $6
     LIMIT 1;`,
    [
      key.provider,
      roundCoord(key.origin.lat),
      roundCoord(key.origin.lon),
      roundCoord(key.destination.lat),
      roundCoord(key.destination.lon),
      windowStart(key.departureTime),
    ]
  );

  const row = rows[0];
  if (!row) return null;

  return {
    provider: key.provider,
    durationSecs: row.duration_secs,
    staticDurationSecs: row.static_duration_secs,
    distanceMeters: row.distance_meters,
    polyline: row.polyline,
    tollInfoMxn: row.toll_mxn === null ? null : Number(row.toll_mxn),
    fetchedAt: new Date(),
    fromCache: true,
  };
}

export async function setCachedEta(
  pool: Pool,
  key: EtaCacheKey,
  result: EtaResult
): Promise<void> {
  await pool.query(
    `INSERT INTO eta_cache (
       provider, origin_lat, origin_lon, destination_lat, destination_lon,
       window_start, duration_secs, static_duration_secs, distance_meters,
       polyline, toll_mxn
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (provider, origin_lat, origin_lon, destination_lat, destination_lon, window_start)
     DO UPDATE SET
       duration_secs = EXCLUDED.duration_secs,
       static_duration_secs = EXCLUDED.static_duration_secs,
       distance_meters = EXCLUDED.distance_meters,
       polyline = EXCLUDED.polyline,
       toll_mxn = EXCLUDED.toll_mxn;`,
    [
      key.provider,
      roundCoord(key.origin.lat),
      roundCoord(key.origin.lon),
      roundCoord(key.destination.lat),
      roundCoord(key.destination.lon),
      windowStart(key.departureTime),
      result.durationSecs,
      result.staticDurationSecs,
      result.distanceMeters,
      result.polyline,
      result.tollInfoMxn,
    ]
  );
}

/**
 * Envuelve cualquier `EtaProvider` con lookup/write en `eta_cache`. Esto es
 * lo que hace que el cache sea transparente: quien pide un ETA no sabe (ni
 * le importa) si la respuesta vino de un HTTP request o de Postgres.
 */
export class CachingEtaProvider implements EtaProvider {
  readonly name: EtaProviderName;

  constructor(
    private readonly inner: EtaProvider,
    private readonly pool: Pool
  ) {
    this.name = inner.name;
  }

  async getEta(request: EtaRequest): Promise<EtaResult> {
    const key: EtaCacheKey = {
      provider: this.inner.name,
      origin: request.origin,
      destination: request.destination,
      departureTime: request.departureTime,
    };

    const cached = await getCachedEta(this.pool, key);
    if (cached) return cached;

    const fresh = await this.inner.getEta(request);
    await setCachedEta(this.pool, key, fresh);
    return fresh;
  }
}
