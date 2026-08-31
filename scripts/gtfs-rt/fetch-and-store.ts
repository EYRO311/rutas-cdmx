/**
 * Descarga el feed GTFS-RT de Metrobús, lo decodifica con parse.ts y guarda
 * el resultado en metrobus_vehicle_positions / metrobus_trip_updates
 * (además del payload crudo en _raw).
 *
 * DESBLOQUEADO 2026-08-31 (ver docs/handoff/01-datos.md sección 8): el correo
 * de sinopticoplus.com trajo credenciales para el login `partnerValidation`
 * de la API real (proveedor: Sonda S.A.), documentado en
 * `manual_integracion_gtfs.pdf`. Ese login (implementado en `auth.ts`)
 * regresa una URL S3 presignada para el feed GTFS-RT (`.proto`, en realidad
 * un `FeedMessage` protobuf binario pese a la extensión) -- NO un Bearer
 * token reutilizable. Se pide una URL fresca en cada corrida (ver el
 * comentario de diseño en `auth.ts`).
 *
 * `METROBUS_GTFS_TOKEN` y `METROBUS_GTFS_RT_URL` (variables del bloqueo
 * anterior, cuando se pensaba que el registro manual del portal iba a dar un
 * Bearer token de larga duración) ya NO se usan -- quedan documentadas aquí
 * solo por si alguien las busca en el historial de git.
 */
import "dotenv/config";
import { getPool, closePool } from "../db.ts";
import { parseGtfsRtFeed } from "./parse.ts";
import { getMetrobusFeedUrls } from "./auth.ts";

async function main(): Promise<void> {
  console.log("[gtfs-rt:metrobus] llamando a partnerValidation ...");
  const feedUrls = await getMetrobusFeedUrls();
  console.log(
    `[gtfs-rt:metrobus] URLs obtenidas. generationDateTime=${feedUrls.generationDateTime} expirationDateTime=${feedUrls.expirationDateTime}`
  );

  console.log("[gtfs-rt:metrobus] descargando feed GTFS-RT (urlRealTime) ...");
  const res = await fetch(feedUrls.urlRealTime);
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
          generationDateTime: feedUrls.generationDateTime,
          expirationDateTime: feedUrls.expirationDateTime,
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
