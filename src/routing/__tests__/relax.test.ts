import { describe, it, expect } from "vitest";
import { relaxEdge, filterBikeAvailability, limitBikeFanout } from "../relax.ts";
import { defaultCostWeights } from "../cost.ts";
import type { EcobiciAvailability, Label, StopNeighborRow } from "../types.ts";

function baseLabel(overrides: Partial<Label> = {}): Label {
  return {
    stopId: "A",
    nodeType: "gtfs_stop",
    arrivalSecs: 1000,
    transfers: 0,
    walkSecs: 0,
    costPesos: 0,
    lastTripId: null,
    parent: null,
    viaEdge: null,
    ...overrides,
  };
}

function rideEdge(overrides: Partial<StopNeighborRow> = {}): StopNeighborRow {
  return {
    edge_type: "ride",
    to_node_type: "gtfs_stop",
    to_node_id: "B",
    trip_id: "TRIP_1",
    route_id: "ROUTE_1",
    depart_secs: 1000,
    arrive_secs: 1200,
    distance_meters: null,
    duration_secs: null,
    ...overrides,
  };
}

const weights = defaultCostWeights();
const HORIZON = 100_000;

describe("relaxEdge — ride", () => {
  it("primer abordaje: no cuenta transbordo, sí cobra tarifa", () => {
    const label = baseLabel({ lastTripId: null, transfers: 0, costPesos: 0 });
    const next = relaxEdge({ label, edge: rideEdge(), weights, horizonEndSecs: HORIZON });
    expect(next).not.toBeNull();
    expect(next!.transfers).toBe(0);
    expect(next!.costPesos).toBe(weights.flatFarePesosPerBoarding);
    expect(next!.arrivalSecs).toBe(1200);
    expect(next!.lastTripId).toBe("TRIP_1");
  });

  it("continuar en el mismo trip_id no cuenta transbordo ni cobra tarifa de nuevo", () => {
    const label = baseLabel({ lastTripId: "TRIP_1", transfers: 0, costPesos: 6, stopId: "B", arrivalSecs: 1200 });
    const next = relaxEdge({
      label,
      edge: rideEdge({ trip_id: "TRIP_1", depart_secs: 1200, arrive_secs: 1400, to_node_id: "C" }),
      weights,
      horizonEndSecs: HORIZON,
    });
    expect(next!.transfers).toBe(0);
    expect(next!.costPesos).toBe(6);
  });

  it("abordar un trip_id distinto tras uno previo cuenta como transbordo y cobra tarifa otra vez", () => {
    const label = baseLabel({ lastTripId: "TRIP_1", transfers: 0, costPesos: 6, stopId: "B", arrivalSecs: 1200 });
    const next = relaxEdge({
      label,
      edge: rideEdge({ trip_id: "TRIP_2", depart_secs: 1250, arrive_secs: 1500 }),
      weights,
      horizonEndSecs: HORIZON,
    });
    expect(next!.transfers).toBe(1);
    expect(next!.costPesos).toBe(12);
  });

  it("rechaza abordar un trip que ya salió respecto al arribo actual", () => {
    const label = baseLabel({ arrivalSecs: 1300 });
    const next = relaxEdge({ label, edge: rideEdge({ depart_secs: 1000 }), weights, horizonEndSecs: HORIZON });
    expect(next).toBeNull();
  });

  it("rechaza si el resultado excede maxTransfers", () => {
    const label = baseLabel({ lastTripId: "TRIP_PREV", transfers: weights.maxTransfers });
    const next = relaxEdge({
      label,
      edge: rideEdge({ trip_id: "TRIP_DISTINTO" }),
      weights,
      horizonEndSecs: HORIZON,
    });
    expect(next).toBeNull();
  });

  it("rechaza si el arribo excede el horizonte", () => {
    const label = baseLabel();
    const next = relaxEdge({
      label,
      edge: rideEdge({ arrive_secs: HORIZON + 1 }),
      weights,
      horizonEndSecs: HORIZON,
    });
    expect(next).toBeNull();
  });

});

describe("relaxEdge — transfer", () => {
  it("trata arrive_secs como DURACIÓN (min_transfer_time_secs), no como instante absoluto", () => {
    const label = baseLabel({ arrivalSecs: 1000, lastTripId: "TRIP_1" });
    const edge: StopNeighborRow = {
      edge_type: "transfer",
      to_node_type: "gtfs_stop",
      to_node_id: "D",
      trip_id: null,
      route_id: null,
      depart_secs: null,
      arrive_secs: 180, // 3 minutos de transbordo mínimo, NO un timestamp
      distance_meters: null,
      duration_secs: null,
    };
    const next = relaxEdge({ label, edge, weights, horizonEndSecs: HORIZON });
    expect(next!.arrivalSecs).toBe(1180);
    expect(next!.walkSecs).toBe(180);
    // Un transfer por sí solo no incrementa el contador de transbordos —
    // el contador se mueve al ABORDAR un trip distinto (ver relax.ts).
    expect(next!.transfers).toBe(label.transfers);
    expect(next!.lastTripId).toBe("TRIP_1");
  });
});

describe("relaxEdge — walk", () => {
  it("deriva el tiempo de caminata de distance_meters y la velocidad de user_preferences", () => {
    const label = baseLabel({ arrivalSecs: 1000 });
    const edge: StopNeighborRow = {
      edge_type: "walk",
      to_node_type: "gtfs_stop",
      to_node_id: "E",
      trip_id: null,
      route_id: null,
      depart_secs: null,
      arrive_secs: null,
      distance_meters: 140,
      duration_secs: null,
    };
    const next = relaxEdge({ label, edge, weights, horizonEndSecs: HORIZON });
    const expectedSecs = Math.round(140 / weights.walkingSpeedMps);
    expect(next!.arrivalSecs).toBe(1000 + expectedSecs);
    expect(next!.walkSecs).toBe(expectedSecs);
  });

  it("caminar después de haber abordado un trip mantiene lastTripId (no se resetea al caminar)", () => {
    const label = baseLabel({ arrivalSecs: 1000, lastTripId: "TRIP_1", transfers: 0 });
    const edge: StopNeighborRow = {
      edge_type: "walk",
      to_node_type: "gtfs_stop",
      to_node_id: "F",
      trip_id: null,
      route_id: null,
      depart_secs: null,
      arrive_secs: null,
      distance_meters: 100,
      duration_secs: null,
    };
    const next = relaxEdge({ label, edge, weights, horizonEndSecs: HORIZON });
    expect(next!.lastTripId).toBe("TRIP_1");

    // Abordar un trip distinto después de caminar SÍ debe contar como transbordo.
    const boarded = relaxEdge({
      label: next!,
      edge: rideEdge({ trip_id: "TRIP_2", depart_secs: next!.arrivalSecs, arrive_secs: next!.arrivalSecs + 300 }),
      weights,
      horizonEndSecs: HORIZON,
    });
    expect(boarded!.transfers).toBe(1);
  });

  it("agregado 2026-08-22: caminar hacia una estación Ecobici ya NO se ignora (antes se descartaba ciegamente cualquier to_node_type !== gtfs_stop)", () => {
    const label = baseLabel({ arrivalSecs: 1000 });
    const edge: StopNeighborRow = {
      edge_type: "walk",
      to_node_type: "ecobici_station",
      to_node_id: "E1",
      trip_id: null,
      route_id: null,
      depart_secs: null,
      arrive_secs: null,
      distance_meters: 210,
      duration_secs: null,
    };
    const next = relaxEdge({ label, edge, weights, horizonEndSecs: HORIZON });
    expect(next).not.toBeNull();
    expect(next!.stopId).toBe("E1");
    expect(next!.nodeType).toBe("ecobici_station");
    const expectedSecs = Math.round(210 / weights.walkingSpeedMps);
    expect(next!.arrivalSecs).toBe(1000 + expectedSecs);
  });
});

describe("relaxEdge — bike (agregado 2026-08-22)", () => {
  function bikeEdge(overrides: Partial<StopNeighborRow> = {}): StopNeighborRow {
    return {
      edge_type: "bike",
      to_node_type: "ecobici_station",
      to_node_id: "E2",
      trip_id: null,
      route_id: null,
      depart_secs: null,
      arrive_secs: null,
      distance_meters: 1500,
      duration_secs: 306, // YA calculado (bike_edges), no derivado de distance_meters aquí.
      ...overrides,
    };
  }

  it("usa duration_secs YA calculado, no lo deriva de distance_meters ni de una velocidad genérica", () => {
    const label = baseLabel({ stopId: "E1", nodeType: "ecobici_station", arrivalSecs: 1000 });
    const next = relaxEdge({ label, edge: bikeEdge(), weights, horizonEndSecs: HORIZON });
    expect(next).not.toBeNull();
    expect(next!.stopId).toBe("E2");
    expect(next!.nodeType).toBe("ecobici_station");
    expect(next!.arrivalSecs).toBe(1306); // 1000 + 306, no una fórmula distance/speed.
  });

  it("no incrementa transfers ni walkSecs ni costPesos (no es transbordo de transporte, no es caminata, sin tarifa modelada)", () => {
    const label = baseLabel({
      stopId: "E1",
      nodeType: "ecobici_station",
      arrivalSecs: 1000,
      transfers: 1,
      walkSecs: 400,
      costPesos: 12,
      lastTripId: "TRIP_1",
    });
    const next = relaxEdge({ label, edge: bikeEdge(), weights, horizonEndSecs: HORIZON });
    expect(next!.transfers).toBe(1);
    expect(next!.walkSecs).toBe(400);
    expect(next!.costPesos).toBe(12);
    expect(next!.lastTripId).toBe("TRIP_1"); // preservado, igual que walk/transfer.
  });

  it("rechaza si duration_secs es null (fila incompleta, no debería pasar del contrato real pero se blinda igual)", () => {
    const label = baseLabel({ stopId: "E1", nodeType: "ecobici_station" });
    const next = relaxEdge({ label, edge: bikeEdge({ duration_secs: null }), weights, horizonEndSecs: HORIZON });
    expect(next).toBeNull();
  });

  it("rechaza si el arribo excede el horizonte (misma regla que las demás clases de arista)", () => {
    const label = baseLabel({ stopId: "E1", nodeType: "ecobici_station", arrivalSecs: HORIZON - 100 });
    const next = relaxEdge({ label, edge: bikeEdge({ duration_secs: 200 }), weights, horizonEndSecs: HORIZON });
    expect(next).toBeNull();
  });
});

describe("limitBikeFanout (agregado 2026-08-22)", () => {
  it("conserva solo las N aristas bike más cercanas, dejando pasar el resto de edge_types sin tocar", () => {
    const rows: StopNeighborRow[] = [
      { edge_type: "bike", to_node_type: "ecobici_station", to_node_id: "far", trip_id: null, route_id: null, depart_secs: null, arrive_secs: null, distance_meters: 3000, duration_secs: 600 },
      { edge_type: "bike", to_node_type: "ecobici_station", to_node_id: "near", trip_id: null, route_id: null, depart_secs: null, arrive_secs: null, distance_meters: 500, duration_secs: 100 },
      { edge_type: "bike", to_node_type: "ecobici_station", to_node_id: "mid", trip_id: null, route_id: null, depart_secs: null, arrive_secs: null, distance_meters: 1500, duration_secs: 300 },
      { edge_type: "walk", to_node_type: "gtfs_stop", to_node_id: "W", trip_id: null, route_id: null, depart_secs: null, arrive_secs: null, distance_meters: 100, duration_secs: null },
    ];
    const result = limitBikeFanout(rows, 2);
    const bikeIds = result.filter((r) => r.edge_type === "bike").map((r) => r.to_node_id);
    expect(bikeIds).toEqual(["near", "mid"]); // las 2 más cercanas, "far" descartada.
    expect(result.some((r) => r.edge_type === "walk")).toBe(true); // walk pasa intacto.
  });
});

describe("filterBikeAvailability (agregado 2026-08-22)", () => {
  const thresholds = { minBikesAvailable: 1, minDocksAvailable: 1 };

  function bikeRow(toId: string): StopNeighborRow {
    return {
      edge_type: "bike",
      to_node_type: "ecobici_station",
      to_node_id: toId,
      trip_id: null,
      route_id: null,
      depart_secs: null,
      arrive_secs: null,
      distance_meters: 1000,
      duration_secs: 200,
    };
  }
  const walkRow: StopNeighborRow = {
    edge_type: "walk",
    to_node_type: "gtfs_stop",
    to_node_id: "W",
    trip_id: null,
    route_id: null,
    depart_secs: null,
    arrive_secs: null,
    distance_meters: 100,
    duration_secs: null,
  };

  it("sin bici en el origen, descarta TODAS las aristas bike (fail-closed) pero deja pasar walk", () => {
    const availability = new Map<string, EcobiciAvailability>([
      ["ORIGIN", { numBikesAvailable: 0, numDocksAvailable: 5, capturedAt: new Date() }],
      ["B", { numBikesAvailable: 5, numDocksAvailable: 5, capturedAt: new Date() }],
    ]);
    const result = filterBikeAvailability([bikeRow("B"), walkRow], "ORIGIN", availability, thresholds);
    expect(result).toEqual([walkRow]);
  });

  it("sin snapshot para el origen (nunca visto), trata como sin disponibilidad", () => {
    const availability = new Map<string, EcobiciAvailability>([
      ["B", { numBikesAvailable: 5, numDocksAvailable: 5, capturedAt: new Date() }],
    ]);
    const result = filterBikeAvailability([bikeRow("B")], "ORIGIN", availability, thresholds);
    expect(result).toEqual([]);
  });

  it("con bici en origen, filtra cada destino POR SEPARADO según sus propios docks", () => {
    const availability = new Map<string, EcobiciAvailability>([
      ["ORIGIN", { numBikesAvailable: 3, numDocksAvailable: 0, capturedAt: new Date() }],
      ["FULL_DOCKS", { numBikesAvailable: 0, numDocksAvailable: 0, capturedAt: new Date() }],
      ["FREE_DOCK", { numBikesAvailable: 2, numDocksAvailable: 1, capturedAt: new Date() }],
    ]);
    const result = filterBikeAvailability([bikeRow("FULL_DOCKS"), bikeRow("FREE_DOCK")], "ORIGIN", availability, thresholds);
    expect(result.map((r) => r.to_node_id)).toEqual(["FREE_DOCK"]);
  });

  it("sin ninguna arista bike en la entrada, no toca nada (ni siquiera mira el mapa de disponibilidad)", () => {
    const result = filterBikeAvailability([walkRow], "ORIGIN", new Map(), thresholds);
    expect(result).toEqual([walkRow]);
  });
});
