import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { getPool, closePool } from "../../scripts/db.ts";
import { getCachedEta, setCachedEta, windowStart } from "../../src/modes/auto/eta-cache.ts";
import type { EtaResult } from "../../src/modes/auto/eta-provider.ts";

/**
 * Estas pruebas SÍ corren contra el Postgres local real (puerto 5433,
 * base rutas_cdmx) -- igual que el resto del proyecto (ver
 * docs/handoff/02-grafo.md: "todo lo descrito aquí se corrió de verdad").
 * eta_cache es justo la pieza que existe para no vivir en memoria de
 * proceso, así que probarla contra un Map en vez de Postgres real no
 * probaría lo que importa (blindaje #2 de .claude/agents/modo-auto.md).
 * Requiere que la migración 0013_eta_cache.sql ya esté aplicada
 * (`npm run migrate`).
 *
 * Coordenadas sentinela (9.99999, -9.99999 y vecinas) para no colisionar
 * con datos reales de CDMX (lat ~19, lon ~-99) y poder limpiar por rango
 * sin arriesgar filas de otra prueba/uso real.
 */

const SENTINEL_LAT_MIN = 9;
const SENTINEL_LAT_MAX = 10;

let pool: Pool;

beforeAll(() => {
  pool = getPool();
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM eta_cache WHERE origin_lat >= $1 AND origin_lat < $2;",
    [SENTINEL_LAT_MIN, SENTINEL_LAT_MAX]
  );
  await closePool();
});

function fakeResult(overrides: Partial<EtaResult> = {}): EtaResult {
  return {
    provider: "google-routes",
    durationSecs: 900,
    staticDurationSecs: 800,
    distanceMeters: 15000,
    polyline: "fake-polyline",
    tollInfoMxn: 12.5,
    fetchedAt: new Date(),
    fromCache: false,
    ...overrides,
  };
}

describe("windowStart (bucketing puro, sin DB)", () => {
  it("trunca hacia abajo a la ventana de 15 minutos", () => {
    expect(windowStart(new Date("2026-08-17T08:07:00.000Z"))).toEqual(
      new Date("2026-08-17T08:00:00.000Z")
    );
    expect(windowStart(new Date("2026-08-17T08:14:59.999Z"))).toEqual(
      new Date("2026-08-17T08:00:00.000Z")
    );
    expect(windowStart(new Date("2026-08-17T08:15:00.000Z"))).toEqual(
      new Date("2026-08-17T08:15:00.000Z")
    );
  });

  it("dos horas dentro de la misma ventana producen el mismo bucket", () => {
    const a = windowStart(new Date("2026-08-17T08:01:00.000Z"));
    const b = windowStart(new Date("2026-08-17T08:13:00.000Z"));
    expect(a).toEqual(b);
  });
});

describe("getCachedEta / setCachedEta contra Postgres real", () => {
  it("devuelve null cuando no hay nada cacheado", async () => {
    const result = await getCachedEta(pool, {
      provider: "google-routes",
      origin: { lat: 9.11111, lon: -9.11111 },
      destination: { lat: 9.22222, lon: -9.22222 },
      departureTime: new Date("2026-08-17T08:00:00.000Z"),
    });
    expect(result).toBeNull();
  });

  it("escribe y relee un resultado dentro de la misma ventana", async () => {
    const key = {
      provider: "google-routes" as const,
      origin: { lat: 9.33333, lon: -9.33333 },
      destination: { lat: 9.44444, lon: -9.44444 },
      departureTime: new Date("2026-08-17T09:05:00.000Z"),
    };
    const fresh = fakeResult({ durationSecs: 1234, distanceMeters: 5678 });

    await setCachedEta(pool, key, fresh);

    // Otra hora dentro de la misma ventana de 15 min (9:05-9:15) debe pegarle a la misma entrada.
    const hit = await getCachedEta(pool, { ...key, departureTime: new Date("2026-08-17T09:12:00.000Z") });

    expect(hit).not.toBeNull();
    expect(hit).toMatchObject({
      provider: "google-routes",
      durationSecs: 1234,
      distanceMeters: 5678,
      tollInfoMxn: 12.5,
      fromCache: true,
    });
  });

  it("una ventana distinta (15 min después) es un cache miss", async () => {
    const key = {
      provider: "google-routes" as const,
      origin: { lat: 9.55555, lon: -9.55555 },
      destination: { lat: 9.66666, lon: -9.66666 },
      departureTime: new Date("2026-08-17T10:00:00.000Z"),
    };
    await setCachedEta(pool, key, fakeResult());

    const missDeSiguienteVentana = await getCachedEta(pool, {
      ...key,
      departureTime: new Date("2026-08-17T10:16:00.000Z"),
    });

    expect(missDeSiguienteVentana).toBeNull();
  });

  it("redondea coordenadas a 5 decimales: dos puntos casi idénticos comparten cache", async () => {
    const departureTime = new Date("2026-08-17T11:00:00.000Z");
    const origin = { lat: 9.777771, lon: -9.777771 }; // 6 decimales
    const destination = { lat: 9.888882, lon: -9.888882 };

    await setCachedEta(
      pool,
      { provider: "google-routes", origin, destination, departureTime },
      fakeResult({ durationSecs: 4321 })
    );

    // Mismo punto redondeado a 5 decimales pero escrito con más ruido en el 6to decimal.
    const hit = await getCachedEta(pool, {
      provider: "google-routes",
      origin: { lat: 9.777769, lon: -9.777769 },
      destination: { lat: 9.888884, lon: -9.888884 },
      departureTime,
    });

    expect(hit?.durationSecs).toBe(4321);
  });

  it("upsert: escribir dos veces la misma clave actualiza el valor en vez de duplicar filas", async () => {
    const key = {
      provider: "osrm" as const,
      origin: { lat: 9.9, lon: -9.9 },
      destination: { lat: 9.91, lon: -9.91 },
      departureTime: new Date("2026-08-17T12:00:00.000Z"),
    };

    await setCachedEta(pool, key, fakeResult({ provider: "osrm", durationSecs: 100 }));
    await setCachedEta(pool, key, fakeResult({ provider: "osrm", durationSecs: 200 }));

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM eta_cache
       WHERE provider = 'osrm' AND origin_lat = 9.9 AND origin_lon = -9.9
         AND destination_lat = 9.91 AND destination_lon = -9.91;`
    );
    expect(rows[0]?.n).toBe(1);

    const hit = await getCachedEta(pool, key);
    expect(hit?.durationSecs).toBe(200);
  });

  it("providers distintos para el mismo origen/destino/ventana no comparten cache", async () => {
    const departureTime = new Date("2026-08-17T13:00:00.000Z");
    const origin = { lat: 9.12121, lon: -9.12121 };
    const destination = { lat: 9.13131, lon: -9.13131 };

    await setCachedEta(
      pool,
      { provider: "google-routes", origin, destination, departureTime },
      fakeResult({ provider: "google-routes", durationSecs: 111 })
    );

    const osrmHit = await getCachedEta(pool, { provider: "osrm", origin, destination, departureTime });
    expect(osrmHit).toBeNull();
  });
});
