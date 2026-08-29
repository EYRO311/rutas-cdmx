import { describe, it, expect, afterAll } from "vitest";
import { planRouteProfile } from "../departure-profile.ts";
import { DEPARTURE_PROFILE, WINDOW } from "../config.ts";
import { openTestPool, TEST_SERVICE_DATE } from "./db-pool.ts";

describe("planRouteProfile — Postgres real", () => {
  const pool = openTestPool();
  afterAll(async () => {
    await pool.end();
  });

  it("evalúa varias salidas dentro de la ventana pedida y devuelve una unión Pareto-óptima", async () => {
    // Ventana chica (30 min con paso de 15 min = 3 muestras) para no disparar
    // 6 búsquedas RAPTOR completas en un test — el muestreo denso ya se
    // ejercita indirectamente por MAX_SAMPLES (ver test de tope abajo).
    const windowSecs = 30 * 60;
    const result = await planRouteProfile(
      pool,
      {
        origin: { lon: -99.1677, lat: 19.427 },
        destination: { lon: -99.1332, lat: 19.4326 },
        serviceDate: TEST_SERVICE_DATE,
        departSecs: 8 * 3600,
      },
      windowSecs
    );

    const expectedSamples = Math.min(DEPARTURE_PROFILE.MAX_SAMPLES, Math.floor(windowSecs / DEPARTURE_PROFILE.SAMPLE_STEP_SECS) + 1);
    expect(result.samples).toHaveLength(expectedSamples);
    expect(result.samples[0]!.departSecs).toBe(8 * 3600);

    // Cada muestra usó el horizonte extendido de perfil (120 min), no el de 90.
    for (const sample of result.samples) {
      expect(sample.result.confidence).not.toBe("no_coverage");
    }

    expect(result.bestItineraries.length).toBeGreaterThan(0);
    // La unión debe ser Pareto-óptima: ningún itinerario domina a otro en el resultado final.
    for (const a of result.bestItineraries) {
      for (const b of result.bestItineraries) {
        if (a === b) continue;
        const aDominatesB =
          a.arriveSecs <= b.arriveSecs &&
          a.transfers <= b.transfers &&
          a.walkSecs <= b.walkSecs &&
          a.costPesos <= b.costPesos &&
          (a.arriveSecs < b.arriveSecs || a.transfers < b.transfers || a.walkSecs < b.walkSecs || a.costPesos < b.costPesos);
        expect(aDominatesB).toBe(false);
      }
    }
  }, 60_000);

  it("nunca muestrea más de DEPARTURE_PROFILE.MAX_SAMPLES salidas aunque la ventana pedida sea enorme", async () => {
    const hugeWindowSecs = 10 * WINDOW.TIME_HORIZON_SECS_PROFILE;
    const result = await planRouteProfile(
      pool,
      {
        origin: { lon: -99.1677, lat: 19.427 },
        destination: { lon: -99.1332, lat: 19.4326 },
        serviceDate: TEST_SERVICE_DATE,
        departSecs: 8 * 3600,
      },
      hugeWindowSecs
    );
    expect(result.samples.length).toBeLessThanOrEqual(DEPARTURE_PROFILE.MAX_SAMPLES);
  }, 60_000);
});
