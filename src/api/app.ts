import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { registerAuth } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerOpenApi } from "./openapi/config.js";
import { healthRoutes } from "./routes/health.js";
import { routesRoutes } from "./routes/routes.js";
import { stopsRoutes } from "./routes/stops.js";
import { tripsRoutes } from "./routes/trips.js";
import { modesRoutes } from "./routes/modes.js";

export interface BuildAppOptions {
  logger?: FastifyBaseLogger | boolean;
}

/**
 * Factory de la app Fastify. Se usa tanto para `src/api/server.ts` (local,
 * long-running) como para `api/index.ts` (handler serverless de Vercel) y
 * para los tests (inyecta requests con `app.inject`, sin abrir un puerto
 * real -- ver tests/api/*.test.ts).
 *
 * No abre el pool de Postgres hasta el primer query real (ver
 * src/api/db/prisma.ts) -- construir la app no implica ya tener una
 * conexión abierta, relevante para cold starts en Vercel.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    genReqId: () => randomUUID(),
    ...(opts.logger !== undefined ? { logger: opts.logger } : { logger: true }),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);
  await registerOpenApi(app);
  await registerAuth(app);

  await app.register(healthRoutes);
  await app.register(routesRoutes, { prefix: "/v1" });
  await app.register(stopsRoutes, { prefix: "/v1" });
  await app.register(tripsRoutes, { prefix: "/v1" });
  await app.register(modesRoutes, { prefix: "/v1" });

  return app;
}
