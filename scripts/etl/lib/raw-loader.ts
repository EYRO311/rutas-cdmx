import type { PoolClient } from "pg";
import { chunkArray } from "./batch.ts";

/**
 * Guarda cada fila cruda (ya parseada a objeto, antes de cualquier
 * normalización o cast de tipos) en la tabla _raw. Reemplaza por completo
 * lo que hubiera para (source, file_name) — así una corrida repetida no
 * acumula filas crudas duplicadas.
 */
export async function loadRaw(
  client: PoolClient,
  source: string,
  fileName: string,
  records: Record<string, string>[]
): Promise<number> {
  await client.query("DELETE FROM _raw WHERE source = $1 AND file_name = $2;", [
    source,
    fileName,
  ]);

  let total = 0;
  for (const batch of chunkArray(records, 500)) {
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    batch.forEach((record, idx) => {
      valuesSql.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(source, fileName, total + idx + 1, JSON.stringify(record));
    });
    await client.query(
      `INSERT INTO _raw (source, file_name, row_number, row_data) VALUES ${valuesSql.join(", ")};`,
      params
    );
    total += batch.length;
  }
  return total;
}
