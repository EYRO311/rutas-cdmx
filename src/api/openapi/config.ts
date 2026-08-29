import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

/**
 * OpenAPI 3.1 generado desde los schemas Zod (fastify-type-provider-zod +
 * @fastify/swagger) -- .claude/agents/api-http.md pide explícitamente "no
 * escrito a mano". `scripts/generate-openapi.ts` vuelca este documento a
 * `generated/openapi.json` para poder versionarlo/validarlo fuera de un
 * servidor corriendo.
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "rutas-cdmx API",
        description:
          "Ruteo multimodal para CDMX (Metro, Metrobús, Ecobici, caminata, auto). Auth por API key (header X-API-Key).",
        version: "0.1.0",
      },
      servers: [
        { url: "http://localhost:3000", description: "Local" },
        { url: "https://rutas-cdmx.vercel.app", description: "Producción (Vercel, placeholder hasta el deploy real)" },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: "apiKey",
            name: "X-API-Key",
            in: "header",
          },
        },
      },
      security: [{ apiKey: [] }],
      tags: [
        { name: "routes", description: "Cálculo de rutas multimodales." },
        { name: "stops", description: "Búsqueda de paradas." },
        { name: "trips", description: "Registro de viajes reales (calibración)." },
        { name: "modes", description: "Configuración de modos del usuario." },
        { name: "health", description: "Monitoreo." },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });
}
