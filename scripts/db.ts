import "dotenv/config";
import { Pool } from "pg";

let pool: Pool | undefined;

/**
 * Pool compartido de conexiones a Postgres. Usa DATABASE_URL de .env
 * (local: puerto 5433 / producción: pooler de Supabase). No se
 * instancia hasta el primer uso para que scripts que solo hacen
 * parsing (sin tocar la DB) no fallen si DATABASE_URL no está seteada.
 */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env["DATABASE_URL"];
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL no está definida. Revisa .env en la raíz del repo."
      );
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
