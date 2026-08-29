/**
 * Pool de Postgres propio del servidor MCP, SOLO de lectura, SOLO para lo
 * que no tiene ningún endpoint HTTP hoy: `saved_places` (resolver "casa"/
 * "ESCOM" a coordenadas) y `ecobici_stations`/`ecobici_snapshots`
 * (`estado_ecobici`). Ver docs/handoff/06-mcp.md, sección "Decisiones",
 * para el porqué -- en corto: agregar esos endpoints a `src/api/` está
 * fuera del alcance de este agente (no se toca esa carpeta), así que la
 * alternativa a leer Postgres directo hubiera sido no ofrecer la
 * herramienta.
 *
 * Mismo patrón de pool chico pensado para serverless que
 * `src/api/db/prisma.ts` (CLAUDE.md decisión #7: nada de estado de
 * aplicación entre invocaciones, pero el pool de conexiones de Postgres sí
 * se reutiliza dentro de invocaciones "warm" del mismo proceso). Pool
 * propio y no `getPgPool()` de `src/api/db/prisma.ts` a propósito: importar
 * ese módulo arrastraría el cliente Prisma completo de `src/api/` a este
 * servidor solo para dos SELECTs de solo lectura -- innecesario y acopla
 * el proceso MCP a la inicialización de Prisma de otro agente.
 */
import pg from "pg";
import { loadConfig } from "./config.js";

let pool: pg.Pool | undefined;

export function getMcpPgPool(): pg.Pool {
  if (!pool) {
    const cfg = loadConfig();
    if (!cfg.databaseUrl) {
      throw new Error(
        "DATABASE_URL no está definida -- necesaria para saved_places/ecobici. Revisa .env o las variables de entorno del deploy."
      );
    }
    pool = new pg.Pool({
      connectionString: cfg.databaseUrl,
      max: Number(process.env["PGPOOL_MAX"] ?? 3),
    });
  }
  return pool;
}

export async function closeMcpPgPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
