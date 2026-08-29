import { z } from "zod";
import { coordinateSchema, modeSchema } from "./common.js";
import { successEnvelope } from "./envelope.js";

/**
 * POST /v1/trips registra un viaje real con tiempos medidos -- alimenta
 * `trip_history` (docs/handoff/02-grafo.md sección 3.4), insumo de
 * aprendizaje-beta (Fase 5). No existe todavía sistema de autenticación de
 * usuarios (user_id es TEXT libre), así que se manda explícito en el body.
 */
export const createTripRequestSchema = z.object({
  user_id: z.string().min(1).max(128),
  origin: coordinateSchema,
  destination: coordinateSchema,
  planned_departure_at: z.iso.datetime({ offset: true }).optional(),
  actual_departure_at: z.iso.datetime({ offset: true }).optional(),
  actual_arrival_at: z.iso.datetime({ offset: true }).optional(),
  planned_duration_secs: z.number().int().nonnegative().optional(),
  actual_duration_secs: z.number().int().nonnegative().optional(),
  modes_used: z.array(modeSchema).optional(),
  route_taken: z.unknown().optional().describe("Snapshot del itinerario devuelto por POST /v1/routes, tal cual (JSONB)."),
  user_rating: z.number().int().min(1).max(5).optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateTripRequest = z.infer<typeof createTripRequestSchema>;

export const tripCreatedResponseDataSchema = z.object({
  id: z.string().describe("bigserial de trip_history, como string (evita perder precisión en JSON)."),
  created_at: z.iso.datetime(),
});

export const tripCreatedResponseSchema = successEnvelope(tripCreatedResponseDataSchema);
