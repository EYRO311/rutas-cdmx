import { describe, it, expect, afterAll } from "vitest";
import {
  applyCorridorFilter,
  buildOriginLabels,
  estimateWalkSecs,
  resolveAccessStops,
  resolveSearchUniverse,
} from "../window.ts";
import type { SearchUniverse } from "../window.ts";
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

describe("applyCorridorFilter (agregado 2026-08-30, ver docs/handoff/03-algoritmo.md sección 12)", () => {
  // Origen y destino a lo largo del ecuador para que haversineMeters sea
  // fácil de razonar (1 grado de longitud en el ecuador ~= 111,320m).
  const origin = { lon: 0, lat: 0 };
  const destination = { lon: 0.1, lat: 0 }; // ~11,132m al este del origen.

  function makeUniverse(extraStops: Array<{ stopId: string; lat: number; lon: number }>): SearchUniverse {
    const candidates = extraStops.map((s) => ({
      stopId: s.stopId,
      stopName: s.stopId,
      lat: s.lat,
      lon: s.lon,
      distanceMeters: 0,
    }));
    return {
      allowedStopIds: new Set(extraStops.map((s) => s.stopId)),
      radiusMeters: 8000,
      originCandidates: candidates,
      destinationCandidates: [],
    };
  }

  it("conserva una parada casi exactamente sobre la línea recta origen-destino, aun con factor ajustado (~1.0)", () => {
    const universe = makeUniverse([{ stopId: "MIDPOINT", lat: 0, lon: 0.05 }]);
    const filtered = applyCorridorFilter(universe, origin, destination, 1.001);
    expect(filtered.has("MIDPOINT")).toBe(true);
  });

  it("descarta una parada con desvío grande cuando el factor de elipse es chico", () => {
    // ~11,132m al norte de un punto intermedio -- un desvío grande respecto
    // de la línea recta origen-destino (~11,132m totales).
    const universe = makeUniverse([{ stopId: "FAR_SIDE", lat: 0.1, lon: 0.05 }]);
    const filteredTight = applyCorridorFilter(universe, origin, destination, 1.1);
    expect(filteredTight.has("FAR_SIDE")).toBe(false);

    const filteredLoose = applyCorridorFilter(universe, origin, destination, 5.0);
    expect(filteredLoose.has("FAR_SIDE")).toBe(true);
  });

  it("nunca excluye un stopId sin coordenadas conocidas (ej. estación Ecobici, ver comentario de la función)", () => {
    const universe = makeUniverse([]);
    universe.allowedStopIds.add("ECOBICI_SIN_COORDS");
    const filtered = applyCorridorFilter(universe, origin, destination, 1.0);
    expect(filtered.has("ECOBICI_SIN_COORDS")).toBe(true);
  });

  it("conserva las paradas de origen/destino en sí (desvío ~1x la distancia OD)", () => {
    const universe = makeUniverse([
      { stopId: "AT_ORIGIN", lat: 0, lon: 0 },
      { stopId: "AT_DEST", lat: 0, lon: 0.1 },
    ]);
    const filtered = applyCorridorFilter(universe, origin, destination, WINDOW.CORRIDOR_ELLIPSE_FACTOR);
    expect(filtered.has("AT_ORIGIN")).toBe(true);
    expect(filtered.has("AT_DEST")).toBe(true);
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
