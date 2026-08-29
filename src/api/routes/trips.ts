import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getPrisma } from "../db/prisma.js";
import { createTripRequestSchema, tripCreatedResponseSchema } from "../schemas/trips.js";
import { authedErrorResponses } from "../schemas/envelope.js";
import { sendOk } from "../lib/reply.js";

interface InsertedTripRow {
  id: bigint;
  created_at: Date;
}

/**
 * POST /v1/trips -- registra un viaje real con tiempos medidos, insumo de
 * `aprendizaje-beta` (Fase 5). Inserta en `trip_history` real (no
 * stubeado: no depende del motor de ruteo, solo persiste lo que manda el
 * cliente). Usa `$queryRaw` porque `origin_geom`/`destination_geom` son
 * columnas `geometry` que Prisma no puede escribir tipadas
 * (docs/handoff/02-grafo.md sección 1).
 */
export const tripsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: "POST",
    url: "/trips",
    schema: {
      tags: ["trips"],
      body: createTripRequestSchema,
      response: { 201: tripCreatedResponseSchema, ...authedErrorResponses },
    },
    handler: async (req, reply) => {
      const b = req.body;
      const prisma = getPrisma();

      const rows = await prisma.$queryRaw<InsertedTripRow[]>`
        INSERT INTO trip_history (
          user_id,
          origin_lat, origin_lon, origin_geom,
          destination_lat, destination_lon, destination_geom,
          planned_departure_at, actual_departure_at, actual_arrival_at,
          planned_duration_secs, actual_duration_secs,
          modes_used, route_taken, user_rating, notes
        ) VALUES (
          ${b.user_id},
          ${b.origin.lat}, ${b.origin.lon}, ST_SetSRID(ST_MakePoint(${b.origin.lon}, ${b.origin.lat}), 4326),
          ${b.destination.lat}, ${b.destination.lon}, ST_SetSRID(ST_MakePoint(${b.destination.lon}, ${b.destination.lat}), 4326),
          ${b.planned_departure_at ?? null}, ${b.actual_departure_at ?? null}, ${b.actual_arrival_at ?? null},
          ${b.planned_duration_secs ?? null}, ${b.actual_duration_secs ?? null},
          ${b.modes_used ?? null}, ${b.route_taken !== undefined ? JSON.stringify(b.route_taken) : null}::jsonb,
          ${b.user_rating ?? null}, ${b.notes ?? null}
        )
        RETURNING id, created_at;
      `;

      const row = rows[0];
      if (!row) {
        // No debería pasar (INSERT...RETURNING siempre devuelve la fila insertada);
        // si pasa, es un bug del servidor -> lo captura el error handler global.
        throw new Error("INSERT en trip_history no devolvió fila.");
      }

      return sendOk(
        reply,
        req,
        { id: row.id.toString(), created_at: row.created_at.toISOString() },
        { statusCode: 201 }
      );
    },
  });
};
