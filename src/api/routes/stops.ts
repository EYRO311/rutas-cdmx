import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getPrisma } from "../db/prisma.js";
import { stopsNearQuerySchema, stopsNearResponseSchema } from "../schemas/stops.js";
import { authedErrorResponses } from "../schemas/envelope.js";
import { sendOk } from "../lib/reply.js";

interface StopNearRow {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  wheelchair_boarding: number | null;
  distance_m: number;
}

/**
 * GET /v1/stops/near -- paradas cercanas a un punto, contra `stops` real
 * (11,362 filas, docs/handoff/01-datos.md). No depende del motor de
 * ruteo, así que a diferencia de POST /v1/routes esto NO está stubeado:
 * usa `$queryRaw` con PostGIS (`ST_DWithin`/`ST_Distance` sobre
 * `geography`) porque la columna `geom` llega a Prisma como
 * `Unsupported("geometry")` (docs/handoff/02-grafo.md sección 1).
 */
export const stopsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: "GET",
    url: "/stops/near",
    schema: {
      tags: ["stops"],
      querystring: stopsNearQuerySchema,
      response: { 200: stopsNearResponseSchema, ...authedErrorResponses },
    },
    handler: async (req, reply) => {
      const { lat, lon, radius_m, limit } = req.query;
      const prisma = getPrisma();

      const rows = await prisma.$queryRaw<StopNearRow[]>`
        SELECT
          stop_id,
          stop_name,
          stop_lat,
          stop_lon,
          wheelchair_boarding,
          ST_Distance(
            geom::geography,
            ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography
          ) AS distance_m
        FROM stops
        WHERE ST_DWithin(
          geom::geography,
          ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography,
          ${radius_m}
        )
        ORDER BY distance_m ASC
        LIMIT ${limit};
      `;

      return sendOk(reply, req, {
        stops: rows.map((r) => ({
          stop_id: r.stop_id,
          name: r.stop_name,
          lat: r.stop_lat,
          lon: r.stop_lon,
          distance_m: Number(r.distance_m),
          wheelchair_boarding: r.wheelchair_boarding,
        })),
      });
    },
  });
};
