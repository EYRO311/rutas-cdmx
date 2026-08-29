/**
 * Helper de test: abre un Pool de `pg` propio (independiente del singleton
 * de scripts/db.ts) para que cada archivo de test que necesite Postgres
 * real pueda abrir/cerrar el suyo sin interferir con otros archivos que
 * vitest pueda correr en paralelo. Misma DATABASE_URL que usa el resto del
 * proyecto (Postgres local, puerto 5433, base rutas_cdmx — ver CLAUDE.md).
 */
import "dotenv/config";
import { Pool } from "pg";

export function openTestPool(): Pool {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL no está definida. Revisa .env en la raíz del repo.");
  }
  return new Pool({ connectionString, max: 5 });
}

/**
 * Fecha de servicio usada en todos los tests contra datos reales: dentro
 * del rango de vigencia real de `calendar` (2024-12-01 a 2025-12-31 para la
 * mayoría de servicios — ver docs/handoff/02-grafo.md sección 5). La fecha
 * de HOY (ver CLAUDE.md, entorno de ejecución) cae fuera de ese rango para
 * casi todos los servicios y daría grafos vacíos por falta de servicio
 * activo, no por un bug del motor — por eso los tests fijan una fecha real
 * de vigencia en vez de usar "hoy". 2025-06-16 es lunes, confirmado con
 * `SELECT count(*) FROM active_service_ids('2025-06-16')` -> 6 servicios
 * activos al momento de escribir estos tests.
 */
export const TEST_SERVICE_DATE = "2025-06-16";
