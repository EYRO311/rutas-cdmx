/**
 * Entrypoint local (long-running), para desarrollo: `npm run dev:api`.
 * En producción NO se usa este archivo -- Vercel invoca `api/index.ts`
 * como función serverless (ver ese archivo y docs/handoff/05-api.md).
 */
import { buildApp } from "./app.js";

const PORT = Number(process.env["PORT"] ?? 3000);
const HOST = process.env["HOST"] ?? "0.0.0.0";

async function main(): Promise<void> {
  const app = await buildApp();
  const address = await app.listen({ port: PORT, host: HOST });
  app.log.info(`rutas-cdmx API escuchando en ${address} (docs en ${address}/docs)`);
}

main().catch((err) => {
  console.error("[server] no se pudo arrancar:", err);
  process.exitCode = 1;
});
