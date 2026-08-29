import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { routerEngine } from "../engine/index.js";
import type { EngineRouteOption, EngineStopRef, RouteQuery } from "../engine/router-engine.js";
import { routesRequestSchema, routesResponseSchema } from "../schemas/routes.js";
import { authedErrorResponses, errorEnvelope } from "../schemas/envelope.js";
import { sendOk } from "../lib/reply.js";
import { EngineUnavailableError } from "../lib/errors.js";

/**
 * POST /v1/routes -- el endpoint núcleo. Traduce el request HTTP al
 * contrato `RouteQuery` (src/api/engine/router-engine.ts) y llama a
 * `routerEngine`, que hoy es `StubRouterEngine` (src/api/engine/index.ts).
 * Esta capa NO calcula rutas -- eso es exclusivamente responsabilidad de
 * `algoritmo-ruteo` (Fase 3). Ver docs/handoff/05-api.md para el contrato
 * completo de conexión.
 */
export const routesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: "POST",
    url: "/routes",
    schema: {
      tags: ["routes"],
      body: routesRequestSchema,
      response: { 200: routesResponseSchema, ...authedErrorResponses, 503: errorEnvelope() },
    },
    handler: async (req, reply) => {
      const b = req.body;

      const isArriveBy = Boolean(b.arrival_at);
      const departureAt = b.departure_at ? new Date(b.departure_at) : new Date();
      const arrivalAt = b.arrival_at ? new Date(b.arrival_at) : null;

      const query: RouteQuery = {
        origin: b.origin,
        destination: b.destination,
        departureAt,
        arrivalAt,
        isArriveBy,
        allowedModes: b.allowed_modes ?? null,
        maxResults: b.max_results,
        userId: b.user_id ?? null,
      };

      let engineResult: { options: EngineRouteOption[]; meta: Record<string, unknown> };
      try {
        engineResult = await routerEngine.computeRoutes(query);
      } catch (err) {
        throw new EngineUnavailableError("El motor de ruteo lanzó un error al procesar la consulta.", {
          cause: err instanceof Error ? err.message : String(err),
        });
      }

      // Ni el stub ni el motor real (algoritmo-ruteo) resuelven "llegar antes
      // de X" -- ver src/api/engine/router-engine.ts. Se documenta en la
      // respuesta en vez de fingir que se honró.
      const warnings: string[] = [];
      if (isArriveBy) {
        warnings.push(
          "arrival_at fue ignorado: el motor de ruteo no implementa búsqueda 'llegar antes de X' todavía. Se calculó saliendo en departure_at (o ahora, si no se mandó ninguno)."
        );
      }

      return sendOk(
        reply,
        req,
        { routes: engineResult.options.map(toRouteOptionDto) },
        {
          meta: {
            engine: {
              name: routerEngine.name,
              version: routerEngine.version,
              is_stub: routerEngine.isStub,
              ...engineResult.meta,
            },
            ...(warnings.length > 0 ? { warnings } : {}),
          },
        }
      );
    },
  });
};

function toRouteOptionDto(option: EngineRouteOption) {
  return {
    id: option.id,
    summary: {
      duration_s: option.summary.durationS,
      cost_mxn: option.summary.costMxn,
      confidence: option.summary.confidence,
      transfers: option.summary.transfers,
      distance_m: option.summary.distanceM ?? null,
    },
    legs: option.legs.map((leg) => ({
      mode: leg.mode,
      duration_s: leg.durationS,
      cost_mxn: leg.costMxn,
      confidence: leg.confidence,
      from: toStopRefDto(leg.from),
      to: toStopRefDto(leg.to),
      route_id: leg.routeId ?? null,
      trip_id: leg.tripId ?? null,
      departure_at: leg.departureAt ? leg.departureAt.toISOString() : null,
      arrival_at: leg.arrivalAt ? leg.arrivalAt.toISOString() : null,
      polyline: leg.polyline ?? null,
    })),
  };
}

function toStopRefDto(ref: EngineStopRef) {
  return {
    stop_id: ref.stopId,
    name: ref.name,
    lat: ref.lat,
    lon: ref.lon,
  };
}
