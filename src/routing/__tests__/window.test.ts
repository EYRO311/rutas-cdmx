import { describe, it, expect, afterAll } from "vitest";
import { buildOriginLabels, estimateWalkSecs, resolveAccessStops, resolveSearchUniverse } from "../window.ts";
import { defaultCostWeights } from "../cost.ts";
import { COST_DEFAULTS, WINDOW } from "../config.ts";
import { openTestPool } from "./db-pool.ts";

describe("estimateWalkSecs", () => {
  it("aplica el mismo factor de circuidad (x1.3) que usa walk_edges (ver docs/handoff/02-grafo.md 3.3)", () => {
    const secs = estimateWalkSecs(1000, 1.4);
    const expected = Math.round((1000 * COST_DEFAULTS.walkCircuityFactor) / 1.4);
    expect(secs).toBe(expected);
  });
});

describe("buildOriginLabels", () => {
  it("cada label de origen no tiene parent y su arrivalSecs = depart + caminata de acceso", () => {
    const weights = defaultCostWeights();
    const labels = buildOriginLabels(
      [{ stopId: "S1", stopName: "Parada 1", lat: 0, lon: 0, distanceMeters: 280 }],
      28800,
      weights
    );
    expect(labels).toHaveLength(1);
    const [label] = labels;
    expect(label!.parent).toBeNull();
    expect(label!.transfers).toBe(0);
    expect(label!.costPesos).toBe(0);
    expect(label!.arrivalSecs).toBe(28800 + label!.walkSecs);
    expect(label!.walkSecs).toBe(estimateWalkSecs(280, weights.walkingSpeedMps));
  });
});

describe("resolveSearchUniverse / resolveAccessStops (Postgres real)", () => {
  const pool = openTestPool();
  afterAll(async () => {
    await pool.end();
  });

  const zocalo = { lon: -99.1332, lat: 19.4326 };
  const angel = { lon: -99.1677, lat: 19.427 };

  it("el universo de búsqueda es la unión de paradas candidatas de origen y destino", async () => {
    const universe = await resolveSearchUniverse(pool, angel, zocalo, WINDOW.SEARCH_RADIUS_METERS_DEFAULT);
    expect(universe.originCandidates.length).toBeGreaterThan(0);
    expect(universe.destinationCandidates.length).toBeGreaterThan(0);
    expect(universe.allowedStopIds.size).toBeGreaterThanOrEqual(
      Math.max(universe.originCandidates.length, universe.destinationCandidates.length)
    );
    for (const c of universe.originCandidates) expect(universe.allowedStopIds.has(c.stopId)).toBe(true);
  });

  it("resolveAccessStops usa un radio más chico que el de búsqueda (config.ts)", async () => {
    expect(WINDOW.ACCESS_WALK_RADIUS_METERS).toBeLessThan(WINDOW.SEARCH_RADIUS_METERS_DEFAULT);
    const stops = await resolveAccessStops(pool, zocalo);
    expect(stops.length).toBeGreaterThan(0);
    for (const s of stops) expect(s.distanceMeters).toBeLessThanOrEqual(WINDOW.ACCESS_WALK_RADIUS_METERS);
  });
});
