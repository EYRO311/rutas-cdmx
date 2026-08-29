import { describe, it, expect, afterAll } from "vitest";
import { defaultCostWeights, loadCostWeights, scalarCost, walkSecondsFromMeters } from "../cost.ts";
import type { Label } from "../types.ts";
import { openTestPool } from "./db-pool.ts";
import { USER_PREFERENCES_DEFAULTS } from "../config.ts";

describe("defaultCostWeights", () => {
  it("usa los defaults documentados de USER_PREFERENCES_DEFAULTS", () => {
    const w = defaultCostWeights();
    expect(w.weightTime).toBe(USER_PREFERENCES_DEFAULTS.weightTime);
    expect(w.weightCost).toBe(USER_PREFERENCES_DEFAULTS.weightCost);
    expect(w.walkingSpeedMps).toBe(USER_PREFERENCES_DEFAULTS.walkingSpeedMps);
    expect(w.maxTransfers).toBe(USER_PREFERENCES_DEFAULTS.maxTransfers);
  });

  it("acota maxTransfers al tope duro aunque el default fuera mayor (invariante de config.ts)", () => {
    const w = defaultCostWeights();
    expect(w.maxTransfers).toBeLessThanOrEqual(6);
  });
});

describe("walkSecondsFromMeters", () => {
  it("es una división simple distancia/velocidad", () => {
    expect(walkSecondsFromMeters(140, 1.4)).toBe(100);
  });
});

describe("scalarCost", () => {
  it("un label con más tiempo de viaje tiene mayor costo escalar (todo lo demás igual)", () => {
    const weights = defaultCostWeights();
    const depart = 0;
    const fast: Label = {
      stopId: "X",
      arrivalSecs: 600,
      transfers: 0,
      walkSecs: 0,
      costPesos: 0,
      lastTripId: null,
      parent: null,
      viaEdge: null,
    };
    const slow: Label = { ...fast, arrivalSecs: 1800 };
    expect(scalarCost(fast, weights, depart)).toBeLessThan(scalarCost(slow, weights, depart));
  });

  it("más transbordos incrementa el costo escalar aunque el tiempo de arribo sea igual", () => {
    const weights = defaultCostWeights();
    const depart = 0;
    const base: Label = {
      stopId: "X",
      arrivalSecs: 1000,
      transfers: 0,
      walkSecs: 0,
      costPesos: 0,
      lastTripId: null,
      parent: null,
      viaEdge: null,
    };
    const withTransfer: Label = { ...base, transfers: 1 };
    expect(scalarCost(withTransfer, weights, depart)).toBeGreaterThan(scalarCost(base, weights, depart));
  });
});

describe("loadCostWeights (Postgres real)", () => {
  const pool = openTestPool();
  afterAll(async () => {
    await pool.end();
  });

  it("sin userId, devuelve defaults sin tocar la base", async () => {
    const w = await loadCostWeights(pool, undefined);
    expect(w).toEqual(defaultCostWeights());
  });

  it("con un userId que no tiene fila en user_preferences (tabla vacía hoy, ver docs/handoff/02-grafo.md), cae a defaults", async () => {
    const w = await loadCostWeights(pool, "usuario-que-no-existe-todavia");
    expect(w.weightTime).toBe(USER_PREFERENCES_DEFAULTS.weightTime);
    expect(w.walkingSpeedMps).toBe(USER_PREFERENCES_DEFAULTS.walkingSpeedMps);
  });
});
