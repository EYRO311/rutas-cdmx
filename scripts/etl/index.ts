/**
 * Entry point de `npm run etl`. Corre migraciones pendientes y después la
 * carga del GTFS estático (data/raw/cdmx-gtfs). Pensado para poder
 * re-correrse las veces que haga falta sin duplicar filas ni requerir
 * volver a descargar nada (criterio de terminado del agente datos-gtfs).
 *
 * Fuera de alcance de este script (documentado en docs/handoff/01-datos.md):
 * - snapshot de Ecobici -> scripts/ecobici/snapshot.ts (cron aparte, no es
 *   idempotente por diseño: cada corrida agrega una fila de serie de tiempo).
 * - GTFS-RT de Metrobús -> scripts/gtfs-rt/ (bloqueado por falta de token).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runMigrations } from "../migrate.ts";
import { getPool, closePool } from "../db.ts";
import { loadGtfsStatic } from "./lib/gtfs-static.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GTFS_DIR = path.resolve(__dirname, "..", "..", "data", "raw", "cdmx-gtfs");

async function main(): Promise<void> {
  console.log("[etl] aplicando migraciones pendientes...");
  await runMigrations();

  console.log(`[etl] cargando GTFS estático desde ${GTFS_DIR} ...`);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stats = await loadGtfsStatic(client, GTFS_DIR);
    await client.query("COMMIT");

    console.log("[etl] _raw cargado:");
    for (const [file, count] of Object.entries(stats.raw)) {
      console.log(`  - ${file}: ${count} filas`);
    }
    console.log("[etl] tablas normalizadas (upsert):");
    for (const [table, count] of Object.entries(stats.normalized)) {
      console.log(`  - ${table}: ${count} filas`);
    }
    if (stats.warnings.length > 0) {
      console.log(`[etl] ${stats.warnings.length} advertencia(s):`);
      for (const w of stats.warnings) console.log(`  ! ${w}`);
    } else {
      console.log("[etl] sin advertencias de parseo.");
    }
    console.log("[etl] listo.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error("[etl] ERROR:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
