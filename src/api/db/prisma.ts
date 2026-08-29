/**
 * Cliente Prisma compartido para la capa HTTP.
 *
 * Prisma 7 requiere un adapter explícito en runtime (ver
 * .agents/skills/prisma-postgres-setup/references/prisma7-client.md):
 * `new PrismaClient()` sin argumentos truena, y `datasourceUrl` ya no
 * existe como opción. Se construye un `pg.Pool` propio + `PrismaPg`.
 *
 * Tamaño del pool pensado para serverless (Vercel + pooler de Supabase en
 * producción, CLAUDE.md decisión #6/#7): cada invocación de función puede
 * correr en paralelo con otras, así que el pool por-instancia tiene que
 * ser chico -- el límite real de conexiones lo pone el pooler de Supabase
 * (pgbouncer), no este proceso. `PGPOOL_MAX` es configurable por variable
 * de entorno; el default (3) es conservador para local (puerto 5433, sin
 * pooler) y para producción contra pgbouncer.
 *
 * El singleton se reutiliza entre invocaciones "warm" del mismo proceso
 * (cold start crea uno nuevo, warm start reusa este módulo ya evaluado --
 * comportamiento estándar de Node/Vercel con módulos ES).
 *
 * Tablas con columnas `geometry` (stops, walk_edges, trip_history, ...) NO
 * se pueden leer/escribir con los métodos tipados de Prisma (llegan como
 * `Unsupported("geometry")` -- ver docs/handoff/02-grafo.md sección 1).
 * Cualquier query que toque esas columnas usa `$queryRaw`/`$executeRaw`.
 * La tabla `api_keys` (migración 0014, propia de esta fase) tampoco tiene
 * modelo Prisma a propósito -- ver el comentario en esa migración -- así
 * que también se consulta con `$queryRaw`/`$executeRaw`.
 *
 * `getPgPool()` expone el mismo `pg.Pool` subyacente para quien necesite
 * un `Pool` crudo en vez del cliente Prisma -- el caso real es
 * `src/api/engine/real-router-engine.ts`, que envuelve
 * `planRoute(pool, ...)` de `algoritmo-ruteo` (Fase 3): ese contrato pide
 * un `pg.Pool` directo, no Prisma. Reusa la MISMA conexión (mismo
 * `connectionString`, mismo `PGPOOL_MAX`) en vez de abrir un segundo pool
 * -- dos pools duplicaría el límite de conexiones que ya se pensó chico a
 * propósito para el pooler de Supabase (ver el párrafo de arriba).
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../../../generated/prisma/client.js";

let client: PrismaClient | undefined;
let pool: pg.Pool | undefined;

export function getPrisma(): PrismaClient {
  if (!client) {
    const connectionString = process.env["DATABASE_URL"];
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL no está definida. Revisa .env en la raíz del repo (o las variables de entorno de Vercel en producción)."
      );
    }
    pool = new pg.Pool({
      connectionString,
      max: Number(process.env["PGPOOL_MAX"] ?? 3),
    });
    const adapter = new PrismaPg(pool);
    client = new PrismaClient({ adapter });
  }
  return client;
}

/** El `pg.Pool` crudo detrás del cliente Prisma -- ver comentario de módulo. Lo inicializa `getPrisma()` si todavía no existe. */
export function getPgPool(): pg.Pool {
  getPrisma();
  if (!pool) {
    throw new Error("getPgPool(): el pool no se inicializó -- no debería pasar, getPrisma() siempre lo crea.");
  }
  return pool;
}

export async function closePrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
