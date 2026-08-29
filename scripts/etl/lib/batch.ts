import type { PoolClient } from "pg";

export function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * UPSERT genérico por lotes para tablas sin columnas de geometría.
 * `rows` son arrays posicionales que corresponden 1 a 1 con `columns`.
 * Usa ON CONFLICT (conflictColumns) DO UPDATE para que re-correr el ETL
 * actualice filas existentes en vez de duplicarlas o requerir un DELETE
 * previo (un DELETE rompería las FK de stop_overrides/transfer_overrides
 * hacia stops en cuanto esas tablas tengan datos).
 */
export async function upsertBatch(
  client: PoolClient,
  table: string,
  columns: string[],
  conflictColumns: string[],
  rows: unknown[][],
  chunkSize = 500
): Promise<number> {
  if (rows.length === 0) return 0;

  const updateCols = columns.filter((c) => !conflictColumns.includes(c));
  const updateSet =
    updateCols.length > 0
      ? updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(", ")
      : undefined;

  let total = 0;
  for (const batch of chunkArray(rows, chunkSize)) {
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const row of batch) {
      const placeholders = row.map(() => `$${p++}`);
      valuesSql.push(`(${placeholders.join(", ")})`);
      params.push(...row);
    }
    const conflictSql = updateSet
      ? `ON CONFLICT (${conflictColumns.join(", ")}) DO UPDATE SET ${updateSet}`
      : `ON CONFLICT (${conflictColumns.join(", ")}) DO NOTHING`;
    const sql = `
      INSERT INTO ${table} (${columns.join(", ")})
      VALUES ${valuesSql.join(", ")}
      ${conflictSql};
    `;
    await client.query(sql, params);
    total += batch.length;
  }
  return total;
}
