import { z } from "zod";
import { coordinateSchema, confidenceSchema, modeSchema } from "./common.js";
import { successEnvelope } from "./envelope.js";

export const routesRequestSchema = z
  .object({
    origin: coordinateSchema,
    destination: coordinateSchema,
    departure_at: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("Hora de salida deseada, ISO 8601 con offset. Excluyente con arrival_at."),
    arrival_at: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("Hora de llegada deseada, ISO 8601 con offset. Excluyente con departure_at."),
    allowed_modes: z
      .array(modeSchema)
      .min(1)
      .optional()
      .describe("Subconjunto de modos permitidos. Si se omite, el motor considera todos."),
    max_results: z.number().int().min(1).max(5).default(3),
    user_id: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Si se manda, el motor puede personalizar con user_preferences/user_modes de ese usuario."),
  })
  .refine((v) => !(v.departure_at && v.arrival_at), {
    message: "Manda departure_at o arrival_at, no ambos.",
    path: ["departure_at"],
  });

export type RoutesRequest = z.infer<typeof routesRequestSchema>;

const stopRefSchema = z.object({
  stop_id: z.string().nullable(),
  name: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
});

const routeLegSchema = z.object({
  mode: modeSchema,
  duration_s: z.number().int().nonnegative(),
  cost_mxn: z.number().nonnegative(),
  confidence: confidenceSchema,
  from: stopRefSchema,
  to: stopRefSchema,
  route_id: z.string().nullable().optional(),
  trip_id: z.string().nullable().optional(),
  departure_at: z.iso.datetime().nullable().optional(),
  arrival_at: z.iso.datetime().nullable().optional(),
  polyline: z.string().nullable().optional(),
});

const routeOptionSchema = z.object({
  id: z.string(),
  summary: z.object({
    duration_s: z.number().int().nonnegative(),
    cost_mxn: z.number().nonnegative(),
    confidence: confidenceSchema,
    transfers: z.number().int().nonnegative(),
    distance_m: z.number().nonnegative().nullable().optional(),
  }),
  legs: z.array(routeLegSchema).min(1),
});

export const routesResponseDataSchema = z.object({
  routes: z.array(routeOptionSchema),
});

export const routesResponseSchema = successEnvelope(routesResponseDataSchema);
