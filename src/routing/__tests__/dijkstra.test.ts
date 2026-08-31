import { describe, it, expect, afterAll } from "vitest";
import { dijkstraMultiCriteria } from "../dijkstra.ts";
import { defaultCostWeights } from "../cost.ts";
import { makeNeighborFetcher } from "../graph-client.ts";
import { resolveAccessStops, resolveSearchUniverse, buildOriginLabels } from "../window.ts";
import { WINDOW } from "../config.ts";
import { makeSyntheticFetcher } from "./synthetic-graph.ts";
import { openTestPool, TEST_SERVICE_DATE } from "./db-pool.ts";
import type { Label } from "../types.ts";

const ORIGIN_LABEL: Label = {
  stopId: "A",
  nodeType: "gtfs_stop",
  arrivalSecs: 1000,
  transfers: 0,
  walkSecs: 0,
  costPesos: 0,
  lastTripId: null,
  parent: null,
  viaEdge: null,
};

/**
 * Red sintética con dos caminos Pareto-incomparables de A a D:
 * - vía B: un transbordo, llega a las 1300.
 * - vía C: sin transbordo (un solo ride), llega a las 1450 (más lento).
 * Ninguno domina al otro (arrivalSecs vs transfers en sentidos opuestos).
 */
const EDGES = [
  { from: "A", edge_type: "walk" as const, to_node_id: "C", distance_meters: 280 },
  { from: "A", edge_type: "ride" as const, to_node_id: "B", trip_id: "T1", depart_secs: 1000, arrive_secs: 1100 },
  { from: "B", edge_type: "ride" as const, to_node_id: "D", trip_id: "T2", depart_secs: 1150, arrive_secs: 1300 },
  { from: "C", edge_type: "ride" as const, to_node_id: "D", trip_id: "T3", depart_secs: 1300, arrive_secs: 1450 },
];

describe("dijkstraMultiCriteria — grafo sintético", () => {
  it("conserva dos labels Pareto-óptimos en D cuando ninguno domina al otro", async () => {
    const fetchNeighbors = makeSyntheticFetcher(EDGES);
    const weights = defaultCostWeights();

    const { bags } = await dijkstraMultiCriteria({
      fetchNeighbors,
      origins: [ORIGIN_LABEL],
      allowedStopIds: new Set(["A", "B", "C", "D"]),
      horizonEndSecs: 10_000,
      weights,
    });

    const bagD = bags.get("D");
    expect(bagD).toBeDefined();
    expect(bagD!.size).toBe(2);

    const byTransfers = new Map(bagD!.all.map((l) => [l.transfers, l]));
    expect(byTransfers.get(1)?.arrivalSecs).toBe(1300);
    expect(byTransfers.get(0)?.arrivalSecs).toBe(1450);
  });

  it("un horizonte más corto que la ruta vía C la excluye, dejando solo la ruta vía B", async () => {
    const fetchNeighbors = makeSyntheticFetcher(EDGES);
    const weights = defaultCostWeights();

    const { bags } = await dijkstraMultiCriteria({
      fetchNeighbors,
      origins: [ORIGIN_LABEL],
      allowedStopIds: new Set(["A", "B", "C", "D"]),
      horizonEndSecs: 1400, // excluye el arribo de 1450 vía C
      weights,
    });

    const bagD = bags.get("D");
    expect(bagD!.size).toBe(1);
    expect(bagD!.all[0]!.arrivalSecs).toBe(1300);
  });

  it("nunca produce un label con más transbordos que weights.maxTransfers", async () => {
    // Cadena de 8 transbordos forzados (más que el default de 3).
    const chainEdges = [];
    for (let i = 0; i < 8; i++) {
      chainEdges.push({
        from: `S${i}`,
        edge_type: "ride" as const,
        to_node_id: `S${i + 1}`,
        trip_id: `TRIP_${i}`, // cada tramo es un trip distinto -> cada abordaje tras el primero es un transbordo
        depart_secs: 1000 + i * 100,
        arrive_secs: 1000 + (i + 1) * 100,
      });
    }
    const fetchNeighbors = makeSyntheticFetcher(chainEdges);
    const weights = defaultCostWeights(); // maxTransfers default = 3

    const origin: Label = { ...ORIGIN_LABEL, stopId: "S0" };
    const allowed = new Set(Array.from({ length: 9 }, (_, i) => `S${i}`));

    const { bags } = await dijkstraMultiCriteria({
      fetchNeighbors,
      origins: [origin],
      allowedStopIds: allowed,
      horizonEndSecs: 10_000,
      weights,
    });

    for (const bag of bags.values()) {
      for (const label of bag.all) {
        expect(label.transfers).toBeLessThanOrEqual(weights.maxTransfers);
      }
    }
    // No debería alcanzar S8 (requeriría 7 transbordos), sí paradas más cercanas al origen.
    expect(bags.has("S8")).toBe(false);
    expect(bags.has("S1")).toBe(true);
  });

  it("maxNodeExpansions (agregado 2026-08-30, tier de distancia larga) reemplaza a WINDOW.MAX_NODE_EXPANSIONS cuando se pasa explícitamente", async () => {
    // Misma cadena de 8 saltos que la prueba anterior -- cada salto es una
    // expansión real. Con un tope explícito de 2, la búsqueda debe cortar
    // MUY antes de agotar la cadena, sin importar que
    // WINDOW.MAX_NODE_EXPANSIONS (1200) sea mucho mayor.
    const chainEdges = [];
    for (let i = 0; i < 8; i++) {
      chainEdges.push({
        from: `S${i}`,
        edge_type: "ride" as const,
        to_node_id: `S${i + 1}`,
        trip_id: `TRIP_${i}`,
        depart_secs: 1000 + i * 100,
        arrive_secs: 1000 + (i + 1) * 100,
      });
    }
    const fetchNeighbors = makeSyntheticFetcher(chainEdges);
    const weights = defaultCostWeights();
    const origin: Label = { ...ORIGIN_LABEL, stopId: "S0" };
    const allowed = new Set(Array.from({ length: 9 }, (_, i) => `S${i}`));

    const limited = await dijkstraMultiCriteria({
      fetchNeighbors,
      origins: [origin],
      allowedStopIds: allowed,
      horizonEndSecs: 10_000,
      weights,
      maxNodeExpansions: 2,
    });
    expect(limited.expandedNodeCount).toBe(2);
    expect(limited.truncatedByExpansionCap).toBe(true);
    // Agregado 2026-08-30 (sección 13): cortó por el tope de NODOS, así que
    // hitNodeCap debe ser true (lo que distingue "denso" de "lento").
    expect(limited.hitNodeCap).toBe(true);

    // Sin pasar el campo, cae al default de WINDOW -- comportamiento
    // idéntico al de antes de este cambio (la cadena completa de 8 saltos
    // cabe sobradamente dentro de 1200).
    const unlimited = await dijkstraMultiCriteria({
      fetchNeighbors,
      origins: [origin],
      allowedStopIds: allowed,
      horizonEndSecs: 10_000,
      weights,
    });
    expect(unlimited.truncatedByExpansionCap).toBe(false);
    expect(unlimited.expandedNodeCount).toBeLessThan(WINDOW.MAX_NODE_EXPANSIONS);
    // Convergió naturalmente (agotó la cola), no tocó ningún tope: hitNodeCap false.
    expect(unlimited.hitNodeCap).toBe(false);
  });

  it("hitNodeCap distingue corte por TIEMPO (deadline) de corte por NODOS (agregado 2026-08-30, sección 13)", async () => {
    // Misma cadena; deadlineAt en el pasado fuerza un corte por TIEMPO en el
    // primer chequeo del bucle, ANTES de agotar el tope de nodos. En ese caso
    // truncatedByExpansionCap es true (se cortó antes de vaciar la cola) pero
    // hitNodeCap debe ser FALSE: el corte fue por reloj, no por densidad. Es
    // exactamente la distinción que index.ts documenta como observabilidad
    // (el fallback denso dispara con truncatedByExpansionCap, no con hitNodeCap
    // — ver el comentario largo en index.ts).
    const chainEdges = [];
    for (let i = 0; i < 8; i++) {
      chainEdges.push({
        from: `S${i}`,
        edge_type: "ride" as const,
        to_node_id: `S${i + 1}`,
        trip_id: `TRIP_${i}`,
        depart_secs: 1000 + i * 100,
        arrive_secs: 1000 + (i + 1) * 100,
      });
    }
    const fetchNeighbors = makeSyntheticFetcher(chainEdges);
    const weights = defaultCostWeights();
    const origin: Label = { ...ORIGIN_LABEL, stopId: "S0" };
    const allowed = new Set(Array.from({ length: 9 }, (_, i) => `S${i}`));

    const timedOut = await dijkstraMultiCriteria({
      fetchNeighbors,
      origins: [origin],
      allowedStopIds: allowed,
      horizonEndSecs: 10_000,
      weights,
      deadlineAt: performance.now() - 1, // ya vencido
    });
    expect(timedOut.truncatedByExpansionCap).toBe(true);
    expect(timedOut.hitNodeCap).toBe(false);
    expect(timedOut.expandedNodeCount).toBeLessThan(WINDOW.MAX_NODE_EXPANSIONS);
  });
});

describe("dijkstraMultiCriteria — Postgres real", () => {
  const pool = openTestPool();
  afterAll(async () => {
    await pool.end();
  });

  it("encuentra al menos un label Pareto-óptimo cerca del Zócalo saliendo desde El Ángel un lunes real de servicio", async () => {
    const origin = { lon: -99.1677, lat: 19.427 }; // El Ángel
    const destination = { lon: -99.1332, lat: 19.4326 }; // Zócalo
    const departSecs = 8 * 3600;
    const weights = defaultCostWeights();

    const [universe, accessStops] = await Promise.all([
      resolveSearchUniverse(pool, origin, destination, WINDOW.SEARCH_RADIUS_METERS_DEFAULT),
      resolveAccessStops(pool, origin),
    ]);
    expect(accessStops.length).toBeGreaterThan(0);

    const origins = buildOriginLabels(accessStops, departSecs, weights);
    const fetchNeighbors = makeNeighborFetcher(pool, TEST_SERVICE_DATE);

    const { bags, expandedNodeCount, dbQueryCount } = await dijkstraMultiCriteria({
      fetchNeighbors,
      origins,
      allowedStopIds: universe.allowedStopIds,
      horizonEndSecs: departSecs + WINDOW.TIME_HORIZON_SECS_DEFAULT,
      weights,
    });

    expect(expandedNodeCount).toBeGreaterThan(0);
    expect(dbQueryCount).toBeGreaterThan(0);

    // Al menos alguna parada dentro del universo de búsqueda quedó alcanzada.
    let anyReached = false;
    for (const bag of bags.values()) {
      if (bag.size > 0) {
        anyReached = true;
        for (const label of bag.all) {
          expect(label.arrivalSecs).toBeGreaterThanOrEqual(departSecs);
          expect(label.transfers).toBeLessThanOrEqual(weights.maxTransfers);
        }
      }
    }
    expect(anyReached).toBe(true);
  }, 20_000);
});
