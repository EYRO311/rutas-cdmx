/**
 * Descarga el feed GTFS-RT de Metrobús, lo decodifica con parse.ts y guarda
 * el resultado en metrobus_vehicle_positions / metrobus_trip_updates
 * (además del payload crudo en _raw).
 *
 * BLOQUEADO: requiere METROBUS_GTFS_TOKEN, que sale de registrarse en
 * https://metrobus-gtfs.sinopticoplus.com (registro manual, no se puede
 * automatizar desde este agente). .env tiene la variable declarada pero
 * vacía. Mientras no haya token, este script se detiene con exit code 1 y
 * un mensaje explícito en vez de fallar con un error de red críptico o
 * simular una respuesta.
 *
 * La URL exacta del endpoint del feed (vehicle positions / trip updates)
 * tampoco está confirmada todavía — solo se conoce el dominio de registro.
 * Hay que confirmarla al completar el registro y ajustar METROBUS_RT_URL
 * abajo.
 */
import "dotenv/config";
import { getPool, closePool } from "../db.ts";
import { parseGtfsRtFeed } from "./parse.ts";

const METROBUS_RT_URL =
  process.env["METROBUS_GTFS_RT_URL"] ??
  "https://metrobus-gtfs.sinopticoplus.com/gtfs-rt/VehiclePositions.pb";

async function main(): Promise<void> {
  const token = process.env["METROBUS_GTFS_TOKEN"];
  if (!token) {
    console.error(
      "[gtfs-rt:metrobus] BLOQUEADO: METROBUS_GTFS_TOKEN no está definido en .env. " +
        "Falta completar el registro en metrobus-gtfs.sinopticoplus.com (bloqueo conocido, ver PLAN.md). " +
        "El parser (scripts/gtfs-rt/parse.ts) está escrito y probado con datos sintéticos " +
        "(tests/gtfs-rt-parse.test.ts) pero nunca se corrió contra el feed real."
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[gtfs-rt:metrobus] descargando ${METROBUS_RT_URL} ...`);
  const res = await fetch(METROBUS_RT_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `Feed de Metrobús respondió ${res.status} ${res.statusText}`
    );
  }
  const buffer = new Uint8Array(await res.arrayBuffer());
  const parsed = await parseGtfsRtFeed(buffer);

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO _raw (source, file_name, row_data) VALUES ($1, $2, $3);",
      [
        "metrobus-gtfs-rt",
        "feed.pb",
        JSON.stringify({
          headerTimestamp: parsed.headerTimestamp,
          vehicleCount: parsed.vehiclePositions.length,
          tripUpdateCount: parsed.tripUpdates.length,
        }),
      ]
    );

    for (const vp of parsed.vehiclePositions) {
      await client.query(
        `INSERT INTO metrobus_vehicle_positions
          (vehicle_id, trip_id, route_id, lat, lon, bearing, speed, current_stop_sequence, vehicle_timestamp, geom)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, ST_SetSRID(ST_MakePoint($5,$4),4326));`,
        [
          vp.vehicleId,
          vp.tripId,
          vp.routeId,
          vp.lat,
          vp.lon,
          vp.bearing,
          vp.speed,
          vp.currentStopSequence,
          vp.timestamp,
        ]
      );
    }

    for (const tu of parsed.tripUpdates) {
      await client.query(
        `INSERT INTO metrobus_trip_updates
          (trip_id, route_id, stop_id, stop_sequence, arrival_delay_secs, arrival_time,
           departure_delay_secs, departure_time, schedule_relationship)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9);`,
        [
          tu.tripId,
          tu.routeId,
          tu.stopId,
          tu.stopSequence,
          tu.arrivalDelaySecs,
          tu.arrivalTime,
          tu.departureDelaySecs,
          tu.departureTime,
          tu.scheduleRelationship,
        ]
      );
    }

    await client.query("COMMIT");
    console.log(
      `[gtfs-rt:metrobus] guardado: ${parsed.vehiclePositions.length} posiciones, ${parsed.tripUpdates.length} trip updates.`
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
    console.error("[gtfs-rt:metrobus] ERROR:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
