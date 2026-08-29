/**
 * Handler serverless de Vercel. Vercel enruta cualquier request bajo
 * `/api/*` (o, con el rewrite de vercel.json, cualquier ruta) a esta
 * función. Reusa la misma app de `src/api/app.ts` que corre local con
 * `npm run dev:api` -- ningún endpoint se define distinto por ambiente.
 *
 * Técnica estándar para desplegar Fastify como función Node de Vercel:
 * Vercel invoca esta función con `(req, res)` compatibles con
 * `http.IncomingMessage`/`http.ServerResponse` (no un evento tipo AWS
 * Lambda) -- Fastify expone su servidor HTTP crudo en `app.server`, así
 * que basta con emitir el evento 'request' ahí mismo en vez de llamar
 * `app.listen()` (que abriría un puerto real, sin sentido en serverless).
 *
 * `buildApp()` se llama UNA vez por instancia de función (módulo evaluado
 * una vez, reusado en invocaciones "warm" -- ver comentario en
 * src/api/db/prisma.ts sobre el pool de Postgres). `app.ready()` espera a
 * que todos los plugins (swagger, auth, rutas) terminen de registrarse
 * antes de la primera request.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "../src/api/app.js";

const appPromise = buildApp({ logger: true });

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await appPromise;
  await app.ready();
  app.server.emit("request", req, res);
}
