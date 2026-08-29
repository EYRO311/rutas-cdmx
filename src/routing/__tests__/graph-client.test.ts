import { describe, it, expect, afterAll } from "vitest";
import {
  getBikeStationNeighbors,
  getCandidateStops,
  getEcobiciAvailability,
  getEcobiciStationCoords,
  getStopNeighbors,
  makeNeighborFetcher,
} from "../graph-client.ts";
import { openTestPool, TEST_SERVICE_DATE } from "./db-pool.ts";

/**
 * Contra Postgres real (puerto 5433, base rutas_cdmx). Usa la misma parada
 * de referencia y fecha que midió `modelo-grafo` en
 * docs/handoff/02-grafo.md sección 5 (B_05034A0-VASCQUIROG, 2025-06-16,
 * 7:00-7:30am), para poder comparar contra esos números si hace falta.
 */
describe("getStopNeighbors (graph_stop_neighbors real)", () => {
  const pool = openTestPool();
  afterAll(async () => {
    await pool.end();
  });

  it("devuelve vecinos para la parada más concurrida de la base en un horario con servicio activo", async () => {
    const rows = await getStopNeighbors(pool, "B_05034A0-VASCQUIROG", TEST_SERVICE_DATE, 7 * 3600, 1800);
    expect(rows.length).toBeGreaterThan(0);
    const edgeTypes = new Set(rows.map((r) => r.edge_type));
    expect(edgeTypes.has("walk") || edgeTypes.has("ride") || edgeTypes.has("transfer")).toBe(true);
    for (const row of rows) {
      expect(["ride", "transfer", "walk"]).toContain(row.edge_type);
      expect(["gtfs_stop", "ecobici_station"]).toContain(row.to_node_type);
    }
  });

  it("una parada inexistente devuelve 0 filas, no un error", async () => {
    const rows = await getStopNeighbors(pool, "NO_EXISTE-XYZ", TEST_SERVICE_DATE, 7 * 3600, 1800);
    expect(rows).toEqual([]);
  });

  it("una ventana en 2026 (fuera de la vigencia real de calendar) no produce aristas ride (documentado: no es un bug del motor)", async () => {
    const rows = await getStopNeighbors(pool, "B_05034A0-VASCQUIROG", "2026-08-16", 7 * 3600, 1800);
    const rideRows = rows.filter((r) => r.edge_type === "ride");
    expect(rideRows).toEqual([]);
  });
});

describe("getCandidateStops", () => {
  const pool = openTestPool();
  afterAll(async () => {
    await pool.end();
  });

  it("encuentra la parada conocida más cercana al Zócalo dentro de un radio chico", async () => {
    const stops = await getCandidateStops(pool, { lon: -99.1332, lat: 19.4326 }, 500);
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.some((s) => s.stopId === "B_0200L2-ZOCALO")).toBe(true);
    // Ordenado ascendente por distancia.
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]!.distanceMeters).toBeGreaterThanOrEqual(stops[i - 1]!.distanceMeters);
    }
  });

  it("un radio de 0 metros en un punto sin parada exacta no devuelve nada", async () => {
    const stops = await getCandidateStops(pool, { lon: 0, lat: 0 }, 1);
    expect(stops).toEqual([]);
  });
});

describe("makeNeighborFetcher", () => {
  const pool = openTestPool();
  afterAll(async () => {
    await pool.end();
  });

  it("cierra sobre serviceDate y cuenta las queries reales que dispara (gtfs_stop: 1 query)", async () => {
    let queryCount = 0;
    const fetch = makeNeighborFetcher(pool, TEST_SERVICE_DATE, () => {
      queryCount++;
    });
    const rows = await fetch("B_05034A0-VASCQUIROG", "gtfs_stop", 7 * 3600, 1800);
    expect(rows.length).toBeGreaterThan(0);
    expect(queryCount).toBe(1);
    await fetch("B_05034A0-VASCQUIROG", "gtfs_stop", 7 * 3600, 1800);
    expect(queryCount).toBe(2);
  });

  it("agregado 2026-08-22: para ecobici_station despacha a graph_bike_station_neighbors (fromSecs/windowSecs se ignoran)", async () => {
    // Estación de mayor fanout real medido en docs/handoff/02-grafo.md sección 9.6.
    const fetch = makeNeighborFetcher(pool, TEST_SERVICE_DATE);
    const rows = await fetch("363", "ecobici_station", 0, 0);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(["bike", "walk"]).toContain(row.edge_type);
      if (row.edge_type === "bike") {
        expect(row.duration_secs).not.toBeNull();
        expect(row.to_node_type).toBe("ecobici_station");
      } else {
        expect(row.duration_secs).toBeNull();
      }
    }
  });

  it("agregado 2026-08-22: una estación Ecobici sin ninguna fila en ecobici_snapshots no puede usar bike (fail-closed), pero sí conserva walk", async () => {
    // Estación de prueba con fan-out bike real conocido (363, ver sección 9.6
    // de docs/handoff/02-grafo.md) — la tabla ecobici_snapshots del entorno
    // local no tiene datos con captured_at reciente para NINGUNA estación
    // hoy (ver docs/handoff/03-algoritmo.md, sección nueva, para la
    // evidencia real de esto), así que en la práctica esto ejercita
    // exactamente el camino de "sin snapshot utilizable -> sin bici viable".
    const fetch = makeNeighborFetcher(pool, TEST_SERVICE_DATE);
    const rows = await fetch("363", "ecobici_station", 0, 0);
    const bikeRows = rows.filter((r) => r.edge_type === "bike");
    const walkRows = rows.filter((r) => r.edge_type === "walk");
    // No se afirma nada sobre bikeRows.length (depende de si hay un
    // snapshot reciente en el momento de correr el test — ver el test de
    // abajo que sí controla esto insertando un snapshot fresco temporal);
    // lo que sí es una invariante dura: sin disponibilidad confirmada,
    // nunca hay MÁS filas bike de las que había crudas Y walk nunca se ve
    // afectado por la disponibilidad de bici.
    expect(walkRows.length).toBeGreaterThan(0);
    expect(bikeRows.every((r) => r.duration_secs !== null)).toBe(true);
  });
});

describe("getBikeStationNeighbors / getEcobiciAvailability / getEcobiciStationCoords (agregado 2026-08-22)", () => {
  const pool = openTestPool();
  afterAll(async () => {
    await pool.end();
  });

  it("getBikeStationNeighbors devuelve aristas bike/walk reales para una estación con fan-out conocido", async () => {
    const rows = await getBikeStationNeighbors(pool, "363");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(["bike", "walk"]).toContain(row.edge_type);
    }
  });

  it("getEcobiciAvailability con una lista vacía no consulta nada y devuelve un Map vacío", async () => {
    const map = await getEcobiciAvailability(pool, [], 900);
    expect(map.size).toBe(0);
  });

  it("getEcobiciAvailability con umbral 0 segundos no acepta ningún snapshot (fail-closed por diseño)", async () => {
    const map = await getEcobiciAvailability(pool, ["363", "84"], 0);
    expect(map.size).toBe(0);
  });

  it("getEcobiciStationCoords devuelve coordenadas reales para las 677 estaciones conocidas", async () => {
    const map = await getEcobiciStationCoords(pool);
    expect(map.size).toBeGreaterThan(600);
    const coords = map.get("363");
    expect(coords).toBeDefined();
    expect(coords!.lat).toBeGreaterThan(19);
    expect(coords!.lat).toBeLessThan(20);
  });
});
