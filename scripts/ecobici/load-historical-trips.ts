/**
 * Carga del histórico REAL de viajes completados de Ecobici a
 * ecobici_trips_historical. Entregable agregado (2026-08-22) — necesario
 * para que modelo-grafo calcule una velocidad de bici real en vez de una
 * constante inventada (ver CLAUDE.md, decisión de arquitectura #8).
 *
 * Fuente confirmada a mano (WebFetch + curl -I, no asumida): el CSV mensual
 * de "datos abiertos" publicado por Ecobici en su propio sitio, ejemplo:
 *   https://ecobici.cdmx.gob.mx/wp-content/uploads/2026/08/public_data_web_2026-07.csv
 * Content-Type: text/csv, 96,069,105 bytes, Last-Modified 2026-08-03.
 * Columnas confirmadas leyendo el header real:
 *   Genero_Usuario, Edad_Usuario, Bici, Ciclo_Estacion_Retiro, Fecha_Retiro,
 *   Hora_Retiro, Ciclo_EstacionArribo, Fecha_Arribo, Hora_Arribo
 * NO es el mismo feed que gbfs.mex.lyftbikes.com (ese es disponibilidad en
 * vivo, sin duración de viaje) — son fuentes distintas, no confundir.
 *
 * Por qué solo un mes (julio 2026, el más reciente completo al momento de
 * la carga): el archivo de un solo mes ya trae 1,493,484 filas de viaje.
 * Es una muestra reciente (coincide con la red de 677 estaciones vigente
 * capturada en ecobici_stations) y suficientemente grande para una
 * estadística estable de velocidad; cargar años de histórico multiplicaría
 * el problema de estaciones dadas de baja/renombradas (ver normalización
 * abajo) sin mejorar la precisión del escalar que necesita modelo-grafo.
 * Documentado explícitamente en docs/handoff/01-datos.md, no es un secreto.
 *
 * Desviación documentada de la regla dura "todo dato crudo va a _raw antes
 * de normalizar": para los otros feeds (GTFS, GBFS) _raw es una tabla JSONB
 * fila-por-fila porque son miles de filas. Acá son ~1.5M filas por mes —
 * meterlas en _raw como JSONB duplicaría el tamaño de la base sin ganancia
 * real (mismo precedente que el extracto de OSM: dato crudo se conserva
 * como archivo en data/raw/, NO se llena _raw fila por fila). Lo que SÍ se
 * guarda en _raw es una sola fila de metadata de la descarga (url, tamaño,
 * conteo de filas, sha256) para trazabilidad.
 *
 * Normalización de station_id: la fuente trae códigos "sucios":
 *   - con cero a la izquierda ("085") -> se le quita el cero para calzar
 *     con ecobici_stations.station_id (verificado: la tabla NO usa ceros
 *     a la izquierda, "85" existe, "085" no).
 *   - compuestos ("266-267", dos cicloestaciones físicamente pareadas)
 *     -> no se puede resolver a una sola estación, se deja NULL.
 *   - literal "Temporal 1/2/3" (estaciones móviles/temporales) -> NULL.
 *   - numéricos válidos pero que ya no existen en el snapshot vigente de
 *     ecobici_stations (estaciones dadas de baja/renumeradas) -> NULL.
 * En todos los casos el valor crudo se conserva en *_station_raw. Nunca se
 * inventa un station_id que no está confirmado.
 *
 * Idempotente por source_file: reinsertar el mismo mes borra las filas
 * previas de ese source_file antes de cargar, para poder re-correrse sin
 * duplicar (mismo criterio de terminado que el resto del ETL de este
 * agente).
 */
import "dotenv/config";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPool, closePool } from "../db.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.resolve(__dirname, "..", "..", "data", "raw", "ecobici-trips");

const SOURCE_MONTH = "2026-07";
const SOURCE_FILENAME = "public_data_web_2026-07.csv";
const SOURCE_URL = `https://ecobici.cdmx.gob.mx/wp-content/uploads/2026/08/${SOURCE_FILENAME}`;

const EXPECTED_HEADER =
  "Genero_Usuario,Edad_Usuario,Bici,Ciclo_Estacion_Retiro,Fecha_Retiro,Hora_Retiro,Ciclo_EstacionArribo,Fecha_Arribo,Hora_Arribo";

const BATCH_SIZE = 20_000;

interface TripRow {
  source_file: string;
  bike_id: string | null;
  user_gender: string | null;
  user_age: number | null;
  start_station_raw: string;
  start_station_id: string | null;
  start_at: string;
  end_station_raw: string;
  end_station_id: string | null;
  end_at: string;
  duration_seconds: number;
}

async function ensureDownloaded(): Promise<string> {
  await mkdir(RAW_DIR, { recursive: true });
  const filePath = path.join(RAW_DIR, SOURCE_FILENAME);
  if (existsSync(filePath)) {
    console.log(`[ecobici:trips] ya descargado: ${filePath}, se reusa.`);
    return filePath;
  }
  console.log(`[ecobici:trips] descargando ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`Descarga falló: ${SOURCE_URL} -> ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, buf);
  console.log(`[ecobici:trips] descargado: ${buf.length} bytes -> ${filePath}`);
  return filePath;
}

/** DD/MM/YYYY + HH:MM:SS -> 'YYYY-MM-DD HH:MM:SS' (naive, hora local CDMX del dato fuente). */
function toTimestamp(dateStr: string, timeStr: string): { sql: string; utcMs: number } {
  const [d, m, y] = dateStr.split("/");
  const [hh, mi, ss] = timeStr.split(":").map((n) => Number(n));
  const sql = `${y}-${m}-${d} ${timeStr}`;
  // Date.UTC solo para poder restar dos timestamps de forma consistente,
  // sin depender de la zona horaria del proceso que corre este script.
  const utcMs = Date.UTC(Number(y), Number(m) - 1, Number(d), hh, mi, ss);
  return { sql, utcMs };
}

function normalizeStationId(raw: string, known: Set<string>): string | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null; // "266-267", "Temporal 1", etc.
  const stripped = String(Number(trimmed)); // quita ceros a la izquierda
  return known.has(stripped) ? stripped : null;
}

async function main(): Promise<void> {
  const filePath = await ensureDownloaded();
  const stats = await stat(filePath);

  const pool = getPool();

  // Set de station_id vigentes, para resolver (o no) los códigos de la fuente.
  const { rows: stationRows } = await pool.query<{ station_id: string }>(
    "SELECT station_id FROM ecobici_stations;"
  );
  const knownStationIds = new Set(stationRows.map((r) => r.station_id));
  console.log(`[ecobici:trips] ${knownStationIds.size} estaciones vigentes cargadas para normalizar.`);

  // Metadata de la descarga a _raw (una fila, no una por viaje — ver
  // comentario de cabecera sobre por qué no se usa el patrón fila-por-fila
  // acá).
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(filePath);
    s.on("data", (chunk) => hash.update(chunk));
    s.on("end", () => resolve());
    s.on("error", reject);
  });
  const sha256 = hash.digest("hex");

  const client = await pool.connect();
  let totalDataRows = 0;
  let insertedRows = 0;
  const skipReasons = { badHeader: 0, wrongFieldCount: 0 };

  try {
    await client.query("BEGIN");

    // Idempotencia: reinsertar el mismo mes reemplaza, no duplica.
    const del = await client.query(
      "DELETE FROM ecobici_trips_historical WHERE source_file = $1;",
      [SOURCE_FILENAME]
    );
    console.log(`[ecobici:trips] filas previas borradas para ${SOURCE_FILENAME}: ${del.rowCount}`);

    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    let batch: TripRow[] = [];
    let isFirstLine = true;

    const flush = async (rowsToInsert: TripRow[]): Promise<void> => {
      if (rowsToInsert.length === 0) return;
      const cols = {
        source_file: [] as string[],
        bike_id: [] as (string | null)[],
        user_gender: [] as (string | null)[],
        user_age: [] as (number | null)[],
        start_station_raw: [] as string[],
        start_station_id: [] as (string | null)[],
        start_at: [] as string[],
        end_station_raw: [] as string[],
        end_station_id: [] as (string | null)[],
        end_at: [] as string[],
        duration_seconds: [] as number[],
      };
      for (const r of rowsToInsert) {
        cols.source_file.push(r.source_file);
        cols.bike_id.push(r.bike_id);
        cols.user_gender.push(r.user_gender);
        cols.user_age.push(r.user_age);
        cols.start_station_raw.push(r.start_station_raw);
        cols.start_station_id.push(r.start_station_id);
        cols.start_at.push(r.start_at);
        cols.end_station_raw.push(r.end_station_raw);
        cols.end_station_id.push(r.end_station_id);
        cols.end_at.push(r.end_at);
        cols.duration_seconds.push(r.duration_seconds);
      }
      await client.query(
        `INSERT INTO ecobici_trips_historical
          (source_file, bike_id, user_gender, user_age, start_station_raw,
           start_station_id, start_at, end_station_raw, end_station_id,
           end_at, duration_seconds)
         SELECT * FROM unnest(
           $1::text[], $2::text[], $3::text[], $4::smallint[], $5::text[],
           $6::text[], $7::timestamp[], $8::text[], $9::text[],
           $10::timestamp[], $11::int[]
         );`,
        [
          cols.source_file,
          cols.bike_id,
          cols.user_gender,
          cols.user_age,
          cols.start_station_raw,
          cols.start_station_id,
          cols.start_at,
          cols.end_station_raw,
          cols.end_station_id,
          cols.end_at,
          cols.duration_seconds,
        ]
      );
      insertedRows += rowsToInsert.length;
    };

    for await (const line of rl) {
      if (isFirstLine) {
        isFirstLine = false;
        if (line.trim() !== EXPECTED_HEADER) {
          skipReasons.badHeader++;
          throw new Error(
            `Header inesperado en ${SOURCE_FILENAME}. Esperado:\n${EXPECTED_HEADER}\nObtenido:\n${line}`
          );
        }
        continue;
      }
      if (line.length === 0) continue;
      const fields = line.split(",");
      if (fields.length !== 9) {
        skipReasons.wrongFieldCount++;
        continue; // no se pudo parsear esta fila; se cuenta y se documenta
      }
      totalDataRows++;
      const [
        genero,
        edadStr,
        bici,
        estRetiro,
        fechaRetiro,
        horaRetiro,
        estArribo,
        fechaArribo,
        horaArribo,
      ] = fields;

      const start = toTimestamp(fechaRetiro, horaRetiro);
      const end = toTimestamp(fechaArribo, horaArribo);
      const durationSeconds = Math.round((end.utcMs - start.utcMs) / 1000);

      const age = edadStr === "" ? null : Number(edadStr);

      batch.push({
        source_file: SOURCE_FILENAME,
        bike_id: bici || null,
        user_gender: genero || null,
        user_age: age === null || Number.isNaN(age) ? null : Math.round(age),
        start_station_raw: estRetiro,
        start_station_id: normalizeStationId(estRetiro, knownStationIds),
        start_at: start.sql,
        end_station_raw: estArribo,
        end_station_id: normalizeStationId(estArribo, knownStationIds),
        end_at: end.sql,
        duration_seconds: durationSeconds,
      });

      if (batch.length >= BATCH_SIZE) {
        await flush(batch);
        console.log(`[ecobici:trips] insertadas ${insertedRows} filas...`);
        batch = [];
      }
    }
    await flush(batch);

    await client.query(
      `INSERT INTO _raw (source, file_name, row_data)
       VALUES ($1, $2, $3);`,
      [
        "ecobici-trips-historical",
        SOURCE_FILENAME,
        JSON.stringify({
          url: SOURCE_URL,
          byte_size: stats.size,
          sha256,
          total_data_rows_in_csv: totalDataRows,
          rows_inserted: insertedRows,
          rows_skipped_bad_field_count: skipReasons.wrongFieldCount,
          downloaded_at: new Date().toISOString(),
        }),
      ]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(
    `[ecobici:trips] listo. CSV: ${totalDataRows} filas de datos, insertadas: ${insertedRows}, ` +
      `descartadas por formato: ${skipReasons.wrongFieldCount}.`
  );
}

main()
  .catch((err) => {
    console.error("[ecobici:trips] ERROR:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
