/**
 * Snapshot de disponibilidad de Ecobici (GBFS). Pensado para correr como
 * job de cron en GitHub Actions cada 5 min (deliverable 3 del agente
 * datos-gtfs) — NO es un worker persistente ni hace polling: se conecta,
 * descarga station_information + station_status una vez, escribe en
 * Postgres, y termina. Idempotente en el sentido de que puede correrse las
 * veces que haga falta sin corromper nada, pero NO es "sin efectos" al
 * repetirse: cada corrida agrega una fila nueva por estación en
 * ecobici_snapshots, a propósito — es una serie de tiempo para patrones
 * predictivos de disponibilidad, no un estado a reconciliar.
 *
 * station_information (datos casi estáticos: nombre, ubicación, capacidad)
 * SÍ se upsertea en ecobici_stations por station_id, para no acumular
 * basura de metadata repetida en cada corrida.
 */
import "dotenv/config";
import { getPool, closePool } from "../db.ts";

const GBFS_BASE = "https://gbfs.mex.lyftbikes.com/gbfs/es";

interface StationInfo {
  station_id: string;
  name?: string;
  lat?: number;
  lon?: number;
  capacity?: number;
}

interface StationStatus {
  station_id: string;
  num_bikes_available?: number;
  num_docks_available?: number;
  is_renting?: number;
  is_returning?: number;
  last_reported?: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GBFS ${url} respondió ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function main(): Promise<void> {
  console.log("[ecobici:snapshot] descargando station_information + station_status ...");

  const [infoRes, statusRes] = await Promise.all([
    fetchJson<{ data: { stations: StationInfo[] } }>(
      `${GBFS_BASE}/station_information.json`
    ),
    fetchJson<{ data: { stations: StationStatus[] } }>(
      `${GBFS_BASE}/station_status.json`
    ),
  ]);

  const stations = infoRes.data.stations;
  const statuses = statusRes.data.stations;

  if (stations.length === 0 || statuses.length === 0) {
    throw new Error(
      `GBFS devolvió 0 estaciones (information=${stations.length}, status=${statuses.length}). No se escribe nada.`
    );
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      "INSERT INTO _raw (source, file_name, row_data) VALUES ($1,$2,$3), ($1,$4,$5);",
      [
        "ecobici-gbfs",
        "station_information.json",
        JSON.stringify(infoRes),
        "station_status.json",
        JSON.stringify(statusRes),
      ]
    );

    for (const s of stations) {
      await client.query(
        `INSERT INTO ecobici_stations (station_id, name, lat, lon, capacity, geom, updated_at)
         VALUES ($1,$2,$3,$4,$5, ST_SetSRID(ST_MakePoint($4,$3),4326), now())
         ON CONFLICT (station_id) DO UPDATE SET
           name = EXCLUDED.name, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
           capacity = EXCLUDED.capacity, geom = EXCLUDED.geom, updated_at = now();`,
        [s.station_id, s.name ?? null, s.lat ?? null, s.lon ?? null, s.capacity ?? null]
      );
    }

    let snapshotRows = 0;
    for (const s of statuses) {
      const lastReported = s.last_reported ? new Date(s.last_reported * 1000) : null;
      await client.query(
        `INSERT INTO ecobici_snapshots
          (station_id, num_bikes_available, num_docks_available, is_renting, is_returning, last_reported)
         VALUES ($1,$2,$3,$4,$5,$6);`,
        [
          s.station_id,
          s.num_bikes_available ?? null,
          s.num_docks_available ?? null,
          s.is_renting === undefined ? null : Boolean(s.is_renting),
          s.is_returning === undefined ? null : Boolean(s.is_returning),
          lastReported,
        ]
      );
      snapshotRows++;
    }

    await client.query("COMMIT");
    console.log(
      `[ecobici:snapshot] listo: ${stations.length} estaciones upserteadas, ${snapshotRows} filas de snapshot insertadas.`
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
    console.error("[ecobici:snapshot] ERROR:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
