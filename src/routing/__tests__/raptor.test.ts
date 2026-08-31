import { describe, it, expect, afterAll } from "vitest";
import { raptor } from "../raptor.ts";
import { defaultCostWeights } from "../cost.ts";
import { makeNeighborFetcher } from "../graph-client.ts";
import { resolveAccessStops, resolveSearchUniverse, buildOriginLabels, haversineMeters } from "../window.ts";
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

// Misma red que dijkstra.test.ts: A -(walk 280m)-> C -(ride T3)-> D (0 transbordos,
// llega 1450); A -(ride T1)-> B -(ride T2)-> D (1 transbordo, llega 1300).
// La ruta vía C se resuelve en la RONDA 1 (el walk inicial no consume ronda,
// ver comentario de módulo en raptor.ts); la ruta vía B necesita RONDA 2
// (dos rides = un transbordo = una ronda más). Esto hace de esta red un
// caso de prueba directo de "una ronda = un transbordo más".
const EDGES = [
  { from: "A", edge_type: "walk" as const, to_node_id: "C", distance_meters: 280 },
  { from: "A", edge_type: "ride" as const, to_node_id: "B", trip_id: "T1", depart_secs: 1000, arrive_secs: 1100 },
  { from: "B", edge_type: "ride" as const, to_node_id: "D", trip_id: "T2", depart_secs: 1150, arrive_secs: 1300 },
  { from: "C", edge_type: "ride" as const, to_node_id: "D", trip_id: "T3", depart_secs: 1300, arrive_secs: 1450 },
];

describe("raptor — grafo sintético, semántica de rondas", () => {
  it("con maxRounds=1 solo alcanza D por la ruta sin transbordo (vía C)", async () => {
    const fetchNeighbors = makeSyntheticFetcher(EDGES);
    const weights = defaultCostWeights();

    const { bags, roundsUsed } = await raptor({
      fetchNeighbors,
      origins: [ORIGIN_LABEL],
      allowedStopIds: new Set(["A", "B", "C", "D"]),
      horizonEndSecs: 10_000,
      weights,
      maxRounds: 1,
    });

    const bagD = bags.get("D");
    expect(bagD!.size).toBe(1);
    expect(bagD!.all[0]).toMatchObject({ arrivalSecs: 1450, transfers: 0 });
    expect(roundsUsed).toBe(1);
  });

  it("con maxRounds=2 alcanza D por ambas rutas Pareto-óptimas", async () => {
    const fetchNeighbors = makeSyntheticFetcher(EDGES);
    const weights = defaultCostWeights();

    const { bags, roundsUsed } = await raptor({
      fetchNeighbors,
      origins: [ORIGIN_LABEL],
      allowedStopIds: new Set(["A", "B", "C", "D"]),
      horizonEndSecs: 10_000,
      weights,
      maxRounds: 2,
    });

    const bagD = bags.get("D");
    expect(bagD!.size).toBe(2);
    const byTransfers = new Map(bagD!.all.map((l) => [l.transfers, l.arrivalSecs]));
    expect(byTransfers.get(0)).toBe(1450);
    expect(byTransfers.get(1)).toBe(1300);
    expect(roundsUsed).toBe(2);
  });

  it("el tope de rondas pedido nunca excede WINDOW.MAX_ROUNDS aunque se pida más", async () => {
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
    const weights = { ...defaultCostWeights(), maxTransfers: 6 }; // no dejar que el peso sea el límite real bajo prueba

    const origin: Label = { ...ORIGIN_LABEL, stopId: "S0" };
    const allowed = new Set(Array.from({ length: 9 }, (_, i) => `S${i}`));

    const { bags, roundsUsed } = await raptor({
      fetchNeighbors,
      origins: [origin],
      allowedStopIds: allowed,
      horizonEndSecs: 10_000,
      weights,
      maxRounds: 100, // pedido explícitamente por encima del tope duro
    });

    expect(roundsUsed).toBeLessThanOrEqual(WINDOW.MAX_ROUNDS);
    // Con tope de 6 rondas y cada ride siendo un transbordo nuevo, S6 es alcanzable, S8 no.
    expect(bags.has("S6")).toBe(true);
    expect(bags.has("S8")).toBe(false);
  });

  it("maxNodeExpansions (agregado 2026-08-30, tier de distancia larga) reemplaza a WINDOW.MAX_NODE_EXPANSIONS cuando se pasa explícitamente", async () => {
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
    const weights = { ...defaultCostWeights(), maxTransfers: 6 };
    const origin: Label = { ...ORIGIN_LABEL, stopId: "S0" };
    const allowed = new Set(Array.from({ length: 9 }, (_, i) => `S${i}`));

    const limited = await raptor({
      fetchNeighbors,
      origins: [origin],
      allowedStopIds: allowed,
      horizonEndSecs: 10_000,
      weights,
      maxRounds: 100,
      maxNodeExpansions: 1,
    });
    expect(limited.truncatedByExpansionCap).toBe(true);
    expect(limited.expandedNodeCount).toBeLessThanOrEqual(1);

    // Sin pasar el campo, cae al default de WINDOW -- comportamiento
    // idéntico al de antes de este cambio.
    const unlimited = await raptor({
      fetchNeighbors,
      origins: [origin],
      allowedStopIds: allowed,
      horizonEndSecs: 10_000,
      weights,
      maxRounds: 100,
    });
    expect(unlimited.truncatedByExpansionCap).toBe(false);
  });
});

// Agregado 2026-08-22 (entregable de tramos en Ecobici): cadena
// walk(gtfs_stop->ecobici) -> bike(ecobici->ecobici) -> walk(ecobici->gtfs_stop)
// SIN ningún ride de por medio. Ver el comentario de módulo de raptor.ts
// ("Hallazgo real del entregable de bici") — sin el carryover explícito de
// labels en un nodo Ecobici, esta cadena nunca se completaría porque
// scanTripsChained (lo único que "continúa" la frontera a la ronda
// siguiente) solo relaja aristas `ride`, y una estación Ecobici nunca tiene
// ninguna.
const ECOBICI_CHAIN_EDGES = [
  { from: "A", edge_type: "walk" as const, to_node_type: "ecobici_station" as const, to_node_id: "E1", distance_meters: 200 },
  {
    from: "E1",
    edge_type: "bike" as const,
    to_node_type: "ecobici_station" as const,
    to_node_id: "E2",
    distance_meters: 1500,
    duration_secs: 300,
  },
  { from: "E2", edge_type: "walk" as const, to_node_type: "gtfs_stop" as const, to_node_id: "B", distance_meters: 150 },
];

describe("raptor — cadena Ecobici sin ride de por medio (carryover de frontera)", () => {
  it("encadena walk -> bike -> walk a través de DOS rondas aunque ninguna arista sea 'ride'", async () => {
    const fetchNeighbors = makeSyntheticFetcher(ECOBICI_CHAIN_EDGES);
    const weights = defaultCostWeights();

    const { bags, roundsUsed } = await raptor({
      fetchNeighbors,
      origins: [ORIGIN_LABEL], // A, arrivalSecs 1000
      allowedStopIds: new Set(["A", "E1", "E2", "B"]),
      horizonEndSecs: 10_000,
      weights,
    });

    const bagB = bags.get("B");
    expect(bagB).toBeDefined();
    expect(bagB!.size).toBeGreaterThan(0);

    const label = bagB!.all[0]!;
    // walk 200m (~143s a 1.4 m/s) + bike 300s (YA calculado, no derivado) + walk 150m (~107s).
    expect(label.arrivalSecs).toBe(1000 + 143 + 300 + 107);
    expect(label.transfers).toBe(0); // ni walk ni bike cuentan como transbordo.
    expect(label.nodeType).toBe("gtfs_stop");
    expect(roundsUsed).toBeGreaterThanOrEqual(2); // el bike-hop necesitó su propia ronda de carryover.
  });
});

describe("raptor — Postgres real", () => {
  const pool = openTestPool();
  afterAll(async () => {
    await pool.end();
  });

  it("encuentra al menos un label Pareto-óptimo cerca del Zócalo saliendo desde El Ángel un lunes real de servicio", async () => {
    const origin = { lon: -99.1677, lat: 19.427 }; // El Ángel
    const destination = { lon: -99.1332, lat: 19.4326 }; // Zócalo
    const departSecs = 8 * 3600;
    const weights = defaultCostWeights();

    const [universe, accessStops, destinationAccessStops] = await Promise.all([
      resolveSearchUniverse(pool, origin, destination, WINDOW.SEARCH_RADIUS_METERS_DEFAULT),
      resolveAccessStops(pool, origin),
      resolveAccessStops(pool, destination),
    ]);

    const origins = buildOriginLabels(accessStops, departSecs, weights);
    const fetchNeighbors = makeNeighborFetcher(pool, TEST_SERVICE_DATE);

    // targetStopIds + goalBiasFn: mismos parámetros que usa index.ts#planRoute
    // en producción (ver comentario de módulo en raptor.ts) — sin ellos,
    // esta función expande "mapear todo lo alcanzable" y, en una zona tan
    // densa como el centro de CDMX (~3,000 paradas candidatas en el
    // universo de búsqueda), puede no llegar a alcanzar una parada
    // ESPECÍFICA dentro del presupuesto de latencia antes de que los topes
    // de expansión/tiempo corten la búsqueda. Pasar el destino conocido de
    // antemano es el caso de uso real que este motor está diseñado para
    // resolver rápido.
    const targetStopIds = new Set(destinationAccessStops.map((s) => s.stopId));
    const stopCoords = new Map(
      [...universe.originCandidates, ...universe.destinationCandidates].map((c) => [c.stopId, c])
    );
    // Ver index.ts para el mismo patrón en producción: un stopId sin
    // coordenadas conocidas (nunca debería pasar aquí, targetStopIds/
    // universe cubren todo lo relevante) usa un piso pesimista, no 0.
    const unknownStopBiasSecs = WINDOW.SEARCH_RADIUS_METERS_DEFAULT / WINDOW.HEURISTIC_SPEED_MPS;
    const goalBiasFn = (stopId: string) => {
      const c = stopCoords.get(stopId);
      return c ? haversineMeters(c, destination) / WINDOW.HEURISTIC_SPEED_MPS : unknownStopBiasSecs;
    };

    const { bags, roundsUsed, dbQueryCount } = await raptor({
      fetchNeighbors,
      origins,
      allowedStopIds: universe.allowedStopIds,
      horizonEndSecs: departSecs + WINDOW.TIME_HORIZON_SECS_DEFAULT,
      weights,
      targetStopIds,
      goalBiasFn,
      // Agregado 2026-08-22: mismo valor que usa index.ts#planRoute para el
      // motor raptor — ver raptor.ts#maxWalkToEcobiciEdges para la
      // evidencia real de por qué RAPTOR (a diferencia de Dijkstra) no
      // tolera el fan-out de Ecobici dentro del presupuesto de latencia.
      // Este test verifica la capacidad base de RAPTOR de encontrar El
      // Ángel -> Zócalo, no su soporte de Ecobici (eso lo cubre el test
      // sintético "cadena Ecobici sin ride de por medio" más arriba).
      maxWalkToEcobiciEdges: 0,
    });

    expect(dbQueryCount).toBeGreaterThan(0);
    expect(roundsUsed).toBeGreaterThanOrEqual(1);

    // Al menos UNA de las paradas de acceso al destino (no necesariamente
    // una en particular) debe quedar alcanzada dentro de 90 min desde El
    // Ángel (son ~3.6km en línea recta, con Metrobús/Metro reales corriendo
    // un lunes de servicio).
    const reachedTarget = destinationAccessStops.find((s) => (bags.get(s.stopId)?.size ?? 0) > 0);
    expect(reachedTarget).toBeDefined();
    const zocaloBag = bags.get(reachedTarget!.stopId);
    expect(zocaloBag).toBeDefined();
    expect(zocaloBag!.size).toBeGreaterThan(0);
    for (const label of zocaloBag!.all) {
      expect(label.arrivalSecs).toBeGreaterThan(departSecs);
      expect(label.transfers).toBeLessThanOrEqual(weights.maxTransfers);
    }
  }, 20_000);
});
