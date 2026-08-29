/**
 * Precómputo de walk_edges: aristas de caminata entre "puntos de acceso" al
 * grafo (paradas GTFS y estaciones Ecobici) a radio 400m.
 *
 * Decisión de modelo-grafo sobre distancia: se usa distancia geodésica en
 * línea recta (ST_Distance sobre geography) multiplicada por un factor de
 * circuidad (WALK_CIRCUITY_FACTOR = 1.3, valor típico citado en literatura
 * de redes peatonales urbanas para aproximar el exceso de recorrido real
 * sobre la línea recta) en vez de routing real sobre la red de OSM cargada
 * en osm_nodes/osm_ways.
 *
 * Por qué no routing real: se cargaron 55,881 ways / 274,132 nodes de OSM
 * (ver scripts/osm/load-to-postgres.ts), pero no hay pgRouting disponible
 * en la imagen postgis/postgis usada localmente, y construir un Dijkstra
 * propio con snapping para ~89k pares candidatos es una pieza de ingeniería
 * más grande que el entregable de esta fase ("precómputo de caminatas ...
 * a tabla walk_edges", no "motor de ruteo peatonal"). Se documenta como
 * limitación explícita en docs/handoff/02-grafo.md — is_network_distance
 * queda en false para todas las filas que este script inserta.
 *
 * Idempotente: ON CONFLICT sobre el índice único
 * (from_node_type, from_node_id, to_node_type, to_node_id) hace upsert.
 */
import "dotenv/config";
import { getPool, closePool } from "../db.ts";

const RADIUS_METERS = 400;
const WALK_CIRCUITY_FACTOR = 1.3;

async function main(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // stop <-> stop (ambos sentidos)
    const stopStop = await client.query(
      `INSERT INTO walk_edges (from_node_type, from_node_id, to_node_type, to_node_id, distance_meters, is_network_distance, geom)
       SELECT 'gtfs_stop', a.stop_id, 'gtfs_stop', b.stop_id,
              ST_Distance(a.geom::geography, b.geom::geography) * $1,
              false,
              ST_MakeLine(a.geom, b.geom)
       FROM stops a
       JOIN stops b ON a.stop_id <> b.stop_id
       WHERE ST_DWithin(a.geom::geography, b.geom::geography, $2)
       ON CONFLICT (from_node_type, from_node_id, to_node_type, to_node_id)
       DO UPDATE SET distance_meters = EXCLUDED.distance_meters, geom = EXCLUDED.geom, computed_at = now();`,
      [WALK_CIRCUITY_FACTOR, RADIUS_METERS]
    );

    // stop <-> ecobici_station (ambos sentidos)
    const stopEco = await client.query(
      `INSERT INTO walk_edges (from_node_type, from_node_id, to_node_type, to_node_id, distance_meters, is_network_distance, geom)
       SELECT 'gtfs_stop', s.stop_id, 'ecobici_station', e.station_id,
              ST_Distance(s.geom::geography, e.geom::geography) * $1,
              false,
              ST_MakeLine(s.geom, e.geom)
       FROM stops s
       JOIN ecobici_stations e ON e.geom IS NOT NULL
       WHERE ST_DWithin(s.geom::geography, e.geom::geography, $2)
       ON CONFLICT (from_node_type, from_node_id, to_node_type, to_node_id)
       DO UPDATE SET distance_meters = EXCLUDED.distance_meters, geom = EXCLUDED.geom, computed_at = now()
       ;`,
      [WALK_CIRCUITY_FACTOR, RADIUS_METERS]
    );

    const ecoStop = await client.query(
      `INSERT INTO walk_edges (from_node_type, from_node_id, to_node_type, to_node_id, distance_meters, is_network_distance, geom)
       SELECT 'ecobici_station', e.station_id, 'gtfs_stop', s.stop_id,
              ST_Distance(s.geom::geography, e.geom::geography) * $1,
              false,
              ST_MakeLine(e.geom, s.geom)
       FROM stops s
       JOIN ecobici_stations e ON e.geom IS NOT NULL
       WHERE ST_DWithin(s.geom::geography, e.geom::geography, $2)
       ON CONFLICT (from_node_type, from_node_id, to_node_type, to_node_id)
       DO UPDATE SET distance_meters = EXCLUDED.distance_meters, geom = EXCLUDED.geom, computed_at = now()
       ;`,
      [WALK_CIRCUITY_FACTOR, RADIUS_METERS]
    );

    // ecobici_station <-> ecobici_station (ambos sentidos)
    const ecoEco = await client.query(
      `INSERT INTO walk_edges (from_node_type, from_node_id, to_node_type, to_node_id, distance_meters, is_network_distance, geom)
       SELECT 'ecobici_station', a.station_id, 'ecobici_station', b.station_id,
              ST_Distance(a.geom::geography, b.geom::geography) * $1,
              false,
              ST_MakeLine(a.geom, b.geom)
       FROM ecobici_stations a
       JOIN ecobici_stations b ON a.station_id <> b.station_id AND b.geom IS NOT NULL
       WHERE a.geom IS NOT NULL AND ST_DWithin(a.geom::geography, b.geom::geography, $2)
       ON CONFLICT (from_node_type, from_node_id, to_node_type, to_node_id)
       DO UPDATE SET distance_meters = EXCLUDED.distance_meters, geom = EXCLUDED.geom, computed_at = now();`,
      [WALK_CIRCUITY_FACTOR, RADIUS_METERS]
    );

    await client.query("COMMIT");

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM walk_edges;");
    console.log(
      `[graph:walk-edges] listo. stop<->stop=${stopStop.rowCount}, stop->ecobici=${stopEco.rowCount}, ecobici->stop=${ecoStop.rowCount}, ecobici<->ecobici=${ecoEco.rowCount}. Total en walk_edges=${rows[0].n}.`
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error("[graph:walk-edges] ERROR:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
