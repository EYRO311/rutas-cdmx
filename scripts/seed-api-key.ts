/**
 * Genera una API key nueva para la capa HTTP y la inserta (hasheada) en
 * `api_keys` (migración 0013). El valor en claro se imprime UNA sola vez
 * por stdout -- no se puede recuperar después, solo revocar y generar otra.
 *
 * Uso:
 *   npx tsx scripts/seed-api-key.ts [label] [user_id]
 *
 * Ejemplo:
 *   npx tsx scripts/seed-api-key.ts "beta-cli" "emiliano"
 */
import { randomBytes } from "node:crypto";
import { hashApiKey } from "../src/api/lib/api-key.ts";
import { closePool, getPool } from "./db.ts";

function generatePlaintextKey(): string {
  // Prefijo "rk_" (rutas key) para que sea reconocible a simple vista en
  // logs/config, igual que hacen stripe/github con sus prefijos de key.
  return `rk_${randomBytes(24).toString("base64url")}`;
}

async function main(): Promise<void> {
  const label = process.argv[2] ?? "beta-cli";
  const userId = process.argv[3] ?? null;

  const plaintext = generatePlaintextKey();
  const keyHash = hashApiKey(plaintext);

  const pool = getPool();
  const { rows } = await pool.query<{ id: string; created_at: string }>(
    `INSERT INTO api_keys (key_hash, label, user_id)
     VALUES ($1, $2, $3)
     RETURNING id, created_at;`,
    [keyHash, label, userId]
  );
  const row = rows[0];
  if (!row) {
    throw new Error("INSERT no devolvió fila (no debería pasar).");
  }

  console.log("[seed-api-key] Key creada. Cópiala ahora -- no se guarda en claro en ningún lado:");
  console.log("");
  console.log(`  ${plaintext}`);
  console.log("");
  console.log(`  id: ${row.id}`);
  console.log(`  label: ${label}`);
  console.log(`  user_id: ${userId ?? "(ninguno -- key de servicio)"}`);
  console.log(`  created_at: ${row.created_at}`);
  console.log("");
  console.log("  Úsala en requests con el header:  X-API-Key: <la key de arriba>");
}

main()
  .catch((err) => {
    console.error("[seed-api-key] ERROR:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
