import type { PoolClient } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseCsvRecords } from "./csv.ts";
import { loadRaw } from "./raw-loader.ts";
import { chunkArray, upsertBatch } from "./batch.ts";
import { nullable, toInt, toFloat, toBool, gtfsDateToIso } from "./parse-helpers.ts";
import { gtfsTimeToSeconds } from "./gtfs-time.ts";

const SOURCE = "cdmx-gtfs";

export interface GtfsStaticStats {
  raw: Record<string, number>;
  normalized: Record<string, number>;
  warnings: string[];
}

async function readGtfsFile(
  dir: string,
  fileName: string
): Promise<Record<string, string>[]> {
  const text = await readFile(path.join(dir, fileName), "utf8");
  return parseCsvRecords(text);
}

async function upsertStops(
  client: PoolClient,
  records: Record<string, string>[],
  warnings: string[]
): Promise<number> {
  let total = 0;
  for (const batch of chunkArray(records, 500)) {
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const r of batch) {
      const lat = toFloat(r["stop_lat"]);
      const lon = toFloat(r["stop_lon"]);
      if (lat === null || lon === null) {
        warnings.push(
          `stops.txt: stop_id=${r["stop_id"]} sin stop_lat/stop_lon válidos, fila omitida`
        );
        continue;
      }
      const idIdx = p++;
      const nameIdx = p++;
      const latIdx = p++;
      const lonIdx = p++;
      const zoneIdx = p++;
      const wheelchairIdx = p++;
      valuesSql.push(
        `($${idIdx}, $${nameIdx}, $${latIdx}, $${lonIdx}, $${zoneIdx}, $${wheelchairIdx}, ST_SetSRID(ST_MakePoint($${lonIdx}, $${latIdx}), 4326))`
      );
      params.push(
        r["stop_id"],
        r["stop_name"],
        lat,
        lon,
        nullable(r["zone_id"]),
        toInt(r["wheelchair_boarding"])
      );
    }
    if (valuesSql.length === 0) continue;
    await client.query(
      `
      INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, zone_id, wheelchair_boarding, geom)
      VALUES ${valuesSql.join(", ")}
      ON CONFLICT (stop_id) DO UPDATE SET
        stop_name = EXCLUDED.stop_name,
        stop_lat = EXCLUDED.stop_lat,
        stop_lon = EXCLUDED.stop_lon,
        zone_id = EXCLUDED.zone_id,
        wheelchair_boarding = EXCLUDED.wheelchair_boarding,
        geom = EXCLUDED.geom;
      `,
      params
    );
    total += valuesSql.length;
  }
  return total;
}

async function upsertShapes(
  client: PoolClient,
  records: Record<string, string>[],
  warnings: string[]
): Promise<number> {
  let total = 0;
  for (const batch of chunkArray(records, 500)) {
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const r of batch) {
      const lat = toFloat(r["shape_pt_lat"]);
      const lon = toFloat(r["shape_pt_lon"]);
      const seq = toInt(r["shape_pt_sequence"]);
      if (lat === null || lon === null || seq === null) {
        warnings.push(
          `shapes.txt: shape_id=${r["shape_id"]} fila con lat/lon/sequence inválidos, omitida`
        );
        continue;
      }
      const idIdx = p++;
      const seqIdx = p++;
      const latIdx = p++;
      const lonIdx = p++;
      const distIdx = p++;
      valuesSql.push(
        `($${idIdx}, $${seqIdx}, $${latIdx}, $${lonIdx}, $${distIdx}, ST_SetSRID(ST_MakePoint($${lonIdx}, $${latIdx}), 4326))`
      );
      params.push(r["shape_id"], seq, lat, lon, toFloat(r["shape_dist_traveled"]));
    }
    if (valuesSql.length === 0) continue;
    await client.query(
      `
      INSERT INTO shapes (shape_id, shape_pt_sequence, shape_pt_lat, shape_pt_lon, shape_dist_traveled, geom)
      VALUES ${valuesSql.join(", ")}
      ON CONFLICT (shape_id, shape_pt_sequence) DO UPDATE SET
        shape_pt_lat = EXCLUDED.shape_pt_lat,
        shape_pt_lon = EXCLUDED.shape_pt_lon,
        shape_dist_traveled = EXCLUDED.shape_dist_traveled,
        geom = EXCLUDED.geom;
      `,
      params
    );
    total += valuesSql.length;
  }
  return total;
}

/**
 * Carga completa del GTFS estático consolidado de datos.cdmx.gob.mx
 * (data/raw/cdmx-gtfs). Todo corre en UNA transacción: o se carga completo
 * o no se toca nada. UPSERT en todas las tablas (nunca DELETE + INSERT)
 * para que re-correr el ETL no rompa las FK de stop_overrides /
 * transfer_overrides una vez que esas tablas tengan filas, y para que sea
 * seguro correrlo dos veces seguidas.
 */
export async function loadGtfsStatic(
  client: PoolClient,
  gtfsDir: string
): Promise<GtfsStaticStats> {
  const warnings: string[] = [];
  const raw: Record<string, number> = {};
  const normalized: Record<string, number> = {};

  const files = {
    agency: await readGtfsFile(gtfsDir, "agency.txt"),
    routes: await readGtfsFile(gtfsDir, "routes.txt"),
    trips: await readGtfsFile(gtfsDir, "trips.txt"),
    calendar: await readGtfsFile(gtfsDir, "calendar.txt"),
    stops: await readGtfsFile(gtfsDir, "stops.txt"),
    shapes: await readGtfsFile(gtfsDir, "shapes.txt"),
    stop_times: await readGtfsFile(gtfsDir, "stop_times.txt"),
    frequencies: await readGtfsFile(gtfsDir, "frequencies.txt"),
  };

  // --- Etapa raw: se conserva cada fila cruda tal cual vino, antes de
  // cualquier normalización (regla dura del agente datos-gtfs). ---
  for (const [name, records] of Object.entries(files)) {
    raw[`${name}.txt`] = await loadRaw(client, SOURCE, `${name}.txt`, records);
  }

  // --- Etapa normalizada, en orden de dependencias FK. ---
  normalized["agency"] = await upsertBatch(
    client,
    "agency",
    ["agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang"],
    ["agency_id"],
    files.agency.map((r) => [
      r["agency_id"],
      r["agency_name"],
      nullable(r["agency_url"]),
      nullable(r["agency_timezone"]),
      nullable(r["agency_lang"]),
    ])
  );

  normalized["calendar"] = await upsertBatch(
    client,
    "calendar",
    [
      "service_id",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
      "start_date",
      "end_date",
    ],
    ["service_id"],
    files.calendar.map((r) => [
      r["service_id"],
      toBool(r["monday"]),
      toBool(r["tuesday"]),
      toBool(r["wednesday"]),
      toBool(r["thursday"]),
      toBool(r["friday"]),
      toBool(r["saturday"]),
      toBool(r["sunday"]),
      gtfsDateToIso(r["start_date"]),
      gtfsDateToIso(r["end_date"]),
    ])
  );

  normalized["routes"] = await upsertBatch(
    client,
    "routes",
    [
      "route_id",
      "agency_id",
      "route_short_name",
      "route_long_name",
      "route_type",
      "route_color",
      "route_text_color",
    ],
    ["route_id"],
    files.routes.map((r) => [
      r["route_id"],
      nullable(r["agency_id"]),
      nullable(r["route_short_name"]),
      nullable(r["route_long_name"]),
      toInt(r["route_type"]),
      nullable(r["route_color"]),
      nullable(r["route_text_color"]),
    ])
  );

  normalized["stops"] = await upsertStops(client, files.stops, warnings);
  normalized["shapes"] = await upsertShapes(client, files.shapes, warnings);

  normalized["trips"] = await upsertBatch(
    client,
    "trips",
    [
      "trip_id",
      "route_id",
      "service_id",
      "shape_id",
      "trip_headsign",
      "trip_short_name",
      "direction_id",
    ],
    ["trip_id"],
    files.trips.map((r) => [
      r["trip_id"],
      r["route_id"],
      r["service_id"],
      nullable(r["shape_id"]),
      nullable(r["trip_headsign"]),
      nullable(r["trip_short_name"]),
      toInt(r["direction_id"]),
    ])
  );

  normalized["stop_times"] = await upsertBatch(
    client,
    "stop_times",
    [
      "trip_id",
      "stop_sequence",
      "stop_id",
      "arrival_time",
      "arrival_time_secs",
      "departure_time",
      "departure_time_secs",
      "timepoint",
    ],
    ["trip_id", "stop_sequence"],
    files.stop_times.map((r) => [
      r["trip_id"],
      toInt(r["stop_sequence"]),
      r["stop_id"],
      nullable(r["arrival_time"]),
      gtfsTimeToSeconds(r["arrival_time"]),
      nullable(r["departure_time"]),
      gtfsTimeToSeconds(r["departure_time"]),
      toInt(r["timepoint"]),
    ])
  );

  normalized["frequencies"] = await upsertBatch(
    client,
    "frequencies",
    [
      "trip_id",
      "start_time",
      "start_time_secs",
      "end_time",
      "end_time_secs",
      "headway_secs",
      "exact_times",
    ],
    ["trip_id", "start_time"],
    files.frequencies.map((r) => [
      r["trip_id"],
      r["start_time"],
      gtfsTimeToSeconds(r["start_time"]),
      r["end_time"],
      gtfsTimeToSeconds(r["end_time"]),
      toInt(r["headway_secs"]),
      toInt(r["exact_times"]),
    ])
  );

  if (files.stops.length === 0) warnings.push("stops.txt: 0 filas leídas");

  return { raw, normalized, warnings };
}
