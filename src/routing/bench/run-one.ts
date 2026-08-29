/**
 * Ejecuta UN solo `planRoute` de punta a punta y sale. Diseñado para
 * correrse como proceso nuevo por invocación (`npx tsx
 * src/routing/bench/run-one.ts ...`), no como función importada dentro de
 * un proceso largo — así cada corrida paga el costo de arrancar el
 * proceso, transpilar el módulo y abrir una conexión nueva a Postgres,
 * igual que pagaría una invocación serverless real en frío (Vercel no
 * garantiza reusar el proceso ni el pool de conexiones entre invocaciones
 * — CLAUDE.md decisión #7). No es una simulación perfecta de un cold start
 * de Vercel (no hay init de Lambda, no hay red hacia Supabase en
 * producción, aquí es Postgres local) — es lo más cercano a "frío" que se
 * puede medir honestamente en este entorno, y se documenta así en
 * docs/handoff/03-algoritmo.md.
 *
 * Uso: tsx src/routing/bench/run-one.ts <lon1> <lat1> <lon2> <lat2> <serviceDate> <departSecs> [engine]
 * Imprime una sola línea JSON a stdout: { wallMs, confidence, itineraries, ...meta }
 */
const processStartedAt = performance.now();

import "dotenv/config";
import { Pool } from "pg";
import { planRoute } from "../index.ts";

async function main(): Promise<void> {
  const [lon1, lat1, lon2, lat2, serviceDate, departSecsStr, engineArg] = process.argv.slice(2);
  const engine = engineArg === "raptor" ? "raptor" : "dijkstra";

  const pool = new Pool({ connectionString: process.env["DATABASE_URL"], max: 2 });

  const result = await planRoute(
    pool,
    {
      origin: { lon: Number(lon1), lat: Number(lat1) },
      destination: { lon: Number(lon2), lat: Number(lat2) },
      serviceDate: serviceDate!,
      departSecs: Number(departSecsStr),
    },
    engine
  );

  const wallMs = performance.now() - processStartedAt;

  console.log(
    JSON.stringify({
      wallMs: Math.round(wallMs * 100) / 100,
      confidence: result.confidence,
      itineraries: result.itineraries.length,
      ...result.meta,
    })
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
