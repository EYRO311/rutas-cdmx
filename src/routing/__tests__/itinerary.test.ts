import { describe, it, expect } from "vitest";
import { buildItinerary, findRootLabel, reconstructLegs } from "../itinerary.ts";
import { defaultCostWeights } from "../cost.ts";
import type { CandidateStop, Label } from "../types.ts";

/**
 * Cadena sintética: origen (parada A, sin parent) -> ride hasta B -> walk
 * hasta C. No toca Postgres: reconstructIterinary/buildItinerary son
 * funciones puras sobre la cadena de .parent, por diseño (ver comentario de
 * módulo en itinerary.ts).
 */
function buildSyntheticChain(): Label {
  const origin: Label = {
    stopId: "A",
    nodeType: "gtfs_stop",
    arrivalSecs: 28800 + 120, // depart 08:00 + 2 min de caminata de acceso
    transfers: 0,
    walkSecs: 120,
    costPesos: 0,
    lastTripId: null,
    parent: null,
    viaEdge: null,
  };

  const afterRide: Label = {
    stopId: "B",
    nodeType: "gtfs_stop",
    arrivalSecs: origin.arrivalSecs + 600,
    transfers: 0,
    walkSecs: origin.walkSecs,
    costPesos: 6,
    lastTripId: "TRIP_1",
    parent: origin,
    viaEdge: {
      edgeType: "ride",
      tripId: "TRIP_1",
      routeId: "ROUTE_1",
      departSecs: origin.arrivalSecs,
      fromStopId: "A",
      distanceMeters: null,
    },
  };

  const afterWalk: Label = {
    stopId: "C",
    nodeType: "gtfs_stop",
    arrivalSecs: afterRide.arrivalSecs + 90,
    transfers: 0,
    walkSecs: afterRide.walkSecs + 90,
    costPesos: 6,
    lastTripId: "TRIP_1",
    parent: afterRide,
    viaEdge: { edgeType: "walk", tripId: null, routeId: null, departSecs: null, fromStopId: "B", distanceMeters: 117 },
  };

  return afterWalk;
}

describe("findRootLabel", () => {
  it("encuentra el label de origen (parent === null) al final de la cadena", () => {
    const chain = buildSyntheticChain();
    const root = findRootLabel(chain);
    expect(root.stopId).toBe("A");
    expect(root.parent).toBeNull();
  });
});

describe("reconstructLegs", () => {
  it("reconstruye los tramos en orden cronológico (no en orden de reversa)", () => {
    const chain = buildSyntheticChain();
    const legs = reconstructLegs(chain);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({
      mode: "ride",
      fromStopId: "A",
      toStopId: "B",
      tripId: "TRIP_1",
      fromNodeType: "gtfs_stop",
      toNodeType: "gtfs_stop",
    });
    expect(legs[1]).toMatchObject({
      mode: "walk",
      fromStopId: "B",
      toStopId: "C",
      fromNodeType: "gtfs_stop",
      toNodeType: "gtfs_stop",
      distanceMeters: 117,
    });
  });

  it("un label sin parent produce una lista vacía de tramos", () => {
    const root = buildSyntheticChain();
    while (root.parent) break; // no-op, solo documentando la intención
    const origin = findRootLabel(root);
    expect(reconstructLegs(origin)).toEqual([]);
  });
});

describe("buildItinerary", () => {
  it("arma un itinerario puerta a puerta con caminata de acceso inicial y final", () => {
    const finalLabel = buildSyntheticChain();
    const weights = defaultCostWeights();
    const destinationStop: CandidateStop = {
      stopId: "C",
      stopName: "Parada C",
      lat: 19.43,
      lon: -99.13,
      distanceMeters: 80,
    };

    const itinerary = buildItinerary({ finalLabel, destinationStop, weights });

    expect(itinerary.legs[0]).toMatchObject({ mode: "walk_access", fromStopId: null });
    expect(itinerary.legs.at(-1)).toMatchObject({ mode: "walk_access", toStopId: null });
    expect(itinerary.departSecs).toBe(28800);
    expect(itinerary.arriveSecs).toBeGreaterThan(itinerary.departSecs);
    expect(itinerary.durationSecs).toBe(itinerary.arriveSecs - itinerary.departSecs);
    expect(itinerary.transfers).toBe(finalLabel.transfers);
    expect(itinerary.costPesos).toBe(finalLabel.costPesos);
    // Caminata total = acceso inicial + caminata interna acumulada + acceso final.
    expect(itinerary.walkSecs).toBeGreaterThan(finalLabel.walkSecs);
  });
});
