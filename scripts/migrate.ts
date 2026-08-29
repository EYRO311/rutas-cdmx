/**
 * Runner de migraciones minimalista: aplica los .sql de /migrations en orden
 * alfabético, una sola vez cada uno, dentro de una transacción, registrando
 * lo aplicado en la tabla _migrations. Sin dependencia de `prisma migrate`
 * (que en Postgres requiere una shadow database y privilegios de CREATEDB
 * que no queremos asumir que existen en el Postgres local ni en el pooler
 * de Supabase en producción).
 *
 * Idempotente: correrlo dos veces seguidas no vuelve a aplicar nada la
 * segunda vez y termina con exit code 0.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPool, closePool } from "./db.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

async function ensureMigrationsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function runMigrations(): Promise<{ applied: number; total: number }> {
  const pool = getPool();
  await ensureMigrationsTable();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows: appliedRows } = await pool.query<{ name: string }>(
    "SELECT name FROM _migrations;"
  );
  const applied = new Set(appliedRows.map((r) => r.name));

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] ya aplicada, se salta: ${file}`);
      continue;
    }
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1);", [
        file,
      ]);
      await client.query("COMMIT");
      console.log(`[migrate] aplicada: ${file}`);
      appliedCount++;
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Falló la migración ${file}: ${(err as Error).message}`, {
        cause: err,
      });
    } finally {
      client.release();
    }
  }

  console.log(
    `[migrate] listo. ${appliedCount} migración(es) nueva(s), ${files.length} en total.`
  );
  return { applied: appliedCount, total: files.length };
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  runMigrations()
    .catch((err) => {
      console.error("[migrate] ERROR:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
