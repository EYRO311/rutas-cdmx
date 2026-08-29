import { describe, it, expect, afterAll } from "vitest";
import { planRoute } from "../index.ts";
import { openTestPool, TEST_SERVICE_DATE } from "./db-pool.ts";

/**
 * Casos de ejemplo end-to-end, con coordenadas reales de CDMX, sobre
 * Postgres real. Esto es lo que el brief pide como sustituto explícito del
 * banco de casos de `qa-rutas` (que todavía no existe — Fase 4, ver
 * docs/handoff/03-algoritmo.md sección de limitaciones): rutas de ejemplo
 * razonables construidas por este mismo agente para demostrar que el motor
 * produce resultados sensatos, no una validación cruzada contra el banco
 * real.
 */
describe("planRoute — casos de ejemplo end-to-end (Postgres real)", () => {
  const pool = openTestPool();
  afterAll(async () => {
    await pool.end();
  });

  it("El Ángel -> Zócalo, lunes real de servicio 08:00: encuentra al menos un itinerario sensato", async () => {
    const result = await planRoute(pool, {
      origin: { lon: -99.1677, lat: 19.427 },
      destination: { lon: -99.1332, lat: 19.4326 },
      serviceDate: TEST_SERVICE_DATE,
      departSecs: 8 * 3600,
    });

    expect(result.confidence).toBe("full");
    expect(result.itineraries.length).toBeGreaterThan(0);

    const best = result.itineraries[0]!;
    expect(best.departSecs).toBe(8 * 3600);
    expect(best.arriveSecs).toBeGreaterThan(best.departSecs);
    // ~3.6km en línea recta: cualquier ruta sensata (caminando, en Metro o
    // Metrobús) debería llegar en bastante menos que el horizonte de 90 min.
    expect(best.durationSecs).toBeLessThan(90 * 60);
    expect(best.durationSecs).toBeGreaterThan(2 * 60);
    expect(best.transfers).toBeLessThanOrEqual(6);
    expect(best.legs.length).toBeGreaterThanOrEqual(2); // al menos acceso inicial + acceso final
    expect(best.legs[0]!.mode).toBe("walk_access");
    expect(best.legs.at(-1)!.mode).toBe("walk_access");

    // Los itinerarios devueltos deben venir ordenados por costo escalar ascendente.
    for (let i = 1; i < result.itineraries.length; i++) {
      expect(result.itineraries[i]!.scalarCost).toBeGreaterThanOrEqual(result.itineraries[i - 1]!.scalarCost);
    }

    expect(result.meta.dbQueryCount).toBeGreaterThan(0);
    expect(result.meta.searchRadiusMeters).toBe(5000);
  }, 20_000);

  it("un origen sin ninguna parada cercana (fuera de cobertura) degrada a no_coverage en vez de fallar", async () => {
    const result = await planRoute(pool, {
      // Punto en el norte de Chihuahua, muy lejos de cualquier parada del feed de CDMX.
      origin: { lon: -106.0691, lat: 28.6353 },
      destination: { lon: -99.1332, lat: 19.4326 },
      serviceDate: TEST_SERVICE_DATE,
      departSecs: 8 * 3600,
    });

    expect(result.confidence).toBe("no_coverage");
    expect(result.itineraries).toEqual([]);
    // Debe intentar el radio ampliado (8km) antes de rendirse.
    expect(result.meta.searchRadiusMeters).toBe(8000);
  }, 20_000);

  it("acepta un userId sin fila en user_preferences sin fallar (usa defaults documentados)", async () => {
    const result = await planRoute(pool, {
      origin: { lon: -99.1677, lat: 19.427 },
      destination: { lon: -99.1332, lat: 19.4326 },
      serviceDate: TEST_SERVICE_DATE,
      departSecs: 8 * 3600,
      userId: "usuario-sin-preferencias-guardadas",
    });
    expect(["full", "degraded_radius_8km"]).toContain(result.confidence);
  }, 20_000);

  it("dijkstra y raptor coinciden en si existe cobertura para el mismo caso (misma ventana, mismos datos)", async () => {
    const request = {
      origin: { lon: -99.1677, lat: 19.427 },
      destination: { lon: -99.1332, lat: 19.4326 },
      serviceDate: TEST_SERVICE_DATE,
      departSecs: 8 * 3600,
    };
    const [viaRaptor, viaDijkstra] = await Promise.all([
      planRoute(pool, request, "raptor"),
      planRoute(pool, request, "dijkstra"),
    ]);
    expect(viaRaptor.itineraries.length).toBeGreaterThan(0);
    expect(viaDijkstra.itineraries.length).toBeGreaterThan(0);
  }, 30_000);
});
