/**
 * Genera `generated/openapi.json` a partir de los schemas Zod reales de
 * `src/api/` (no se escribe a mano -- .claude/agents/api-http.md). Levanta
 * la app con `buildApp()`, espera a que Fastify termine de registrar
 * todos los plugins/rutas, pide el documento a `@fastify/swagger`
 * (`app.swagger()`) y lo escribe a disco. No abre un puerto ni requiere
 * Postgres corriendo (ningún handler se ejecuta, solo se registran los
 * schemas de las rutas).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildApp } from "../src/api/app.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, "..", "generated", "openapi.json");

async function main(): Promise<void> {
  const app = await buildApp({ logger: false });
  await app.ready();

  const spec = app.swagger();

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(spec, null, 2) + "\n", "utf8");

  console.log(`[openapi:generate] escrito ${OUT_PATH}`);
  console.log(
    `[openapi:generate] ${Object.keys(spec.paths ?? {}).length} paths, openapi ${String((spec as { openapi?: string }).openapi)}`
  );

  await app.close();
}

main().catch((err) => {
  console.error("[openapi:generate] ERROR:", err);
  process.exitCode = 1;
});
