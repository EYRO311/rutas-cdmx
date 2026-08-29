import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getPrisma } from "../db/prisma.js";
import { healthResponseSchema } from "../schemas/health.js";
import { publicErrorResponses } from "../schemas/envelope.js";
import { sendOk } from "../lib/reply.js";

const API_VERSION = "0.1.0";
const processStartedAt = Date.now();

/**
 * GET /health -- pública (no requiere API key, ver src/api/plugins/auth.ts).
 * Hace un `SELECT 1` real contra Postgres: un health check que no toca la
 * DB no dice nada útil quien depende de ella para todo lo demás.
 */
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: "GET",
    url: "/health",
    schema: {
      tags: ["health"],
      security: [],
      response: { 200: healthResponseSchema, ...publicErrorResponses },
    },
    handler: async (req, reply) => {
      let db: "ok" | "error" = "ok";
      try {
        await getPrisma().$queryRaw`SELECT 1;`;
      } catch (err) {
        db = "error";
        req.log.error({ err }, "health check: Postgres no responde");
      }

      return sendOk(reply, req, {
        status: db === "ok" ? "ok" : "degraded",
        db,
        uptime_s: Math.round((Date.now() - processStartedAt) / 1000),
        version: API_VERSION,
      });
    },
  });
};
