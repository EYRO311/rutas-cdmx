import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPrisma } from "../db/prisma.js";
import { hashApiKey } from "../lib/api-key.js";
import { UnauthorizedError } from "../lib/errors.js";

/** Rutas que no requieren API key: monitoreo y la documentación misma. */
const PUBLIC_PATH_PREFIXES = ["/health", "/docs", "/openapi.json"];

declare module "fastify" {
  interface FastifyRequest {
    /** user_id dueño de la API key usada, si la key tiene uno (puede ser null: keys "de servicio"). Poblado por el hook de auth. */
    apiKeyUserId: string | null;
  }
}

function isPublicPath(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return PUBLIC_PATH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

function extractApiKey(req: FastifyRequest): string | null {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.length > 0) return header;
  if (Array.isArray(header) && header[0]) return header[0];

  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  return null;
}

/**
 * Auth por API key (.claude/agents/api-http.md, regla dura: "desde el día
 * uno"). Header `X-API-Key: <key>` (o `Authorization: Bearer <key>`).
 *
 * Valida contra `api_keys.key_hash` (migración 0013) vía `$queryRaw` --
 * esa tabla no tiene modelo Prisma a propósito (ver comentario en la
 * migración). Un lookup indexado por hash en Postgres agrega unos pocos
 * ms al request; se documenta como parte consciente del presupuesto de
 * latencia (CLAUDE.md decisión #7, p95 < 3s) en docs/handoff/05-api.md --
 * no hay estado en memoria de proceso que lo reemplace porque serverless
 * no lo garantiza entre invocaciones (misma decisión #7).
 *
 * `last_used_at` se actualiza best-effort (no bloquea ni falla el
 * request si el UPDATE tarda o falla).
 */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (req) => {
    if (isPublicPath(req.url)) return;

    const key = extractApiKey(req);
    if (!key) {
      throw new UnauthorizedError("Falta la API key. Mándala en el header X-API-Key.");
    }

    const keyHash = hashApiKey(key);
    const prisma = getPrisma();
    const rows = await prisma.$queryRaw<Array<{ id: bigint; user_id: string | null }>>`
      SELECT id, user_id FROM api_keys
      WHERE key_hash = ${keyHash} AND is_active = true
      LIMIT 1;
    `;
    const row = rows[0];
    if (!row) {
      throw new UnauthorizedError("API key inválida o revocada.");
    }

    req.apiKeyUserId = row.user_id;

    prisma.$executeRaw`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id};`.catch((err) => {
      req.log.warn({ err }, "no se pudo actualizar api_keys.last_used_at (no bloqueante)");
    });
  });
}
