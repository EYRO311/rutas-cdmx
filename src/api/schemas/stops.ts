import { z } from "zod";
import { successEnvelope } from "./envelope.js";

export const stopsNearQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radius_m: z.coerce
    .number()
    .positive()
    .max(2000)
    .default(400)
    .describe("Radio de búsqueda en metros, línea recta. Tope 2000m."),
  limit: z.coerce.number().int().positive().max(50).default(10),
});
export type StopsNearQuery = z.infer<typeof stopsNearQuerySchema>;

const stopNearItemSchema = z.object({
  stop_id: z.string(),
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
  distance_m: z.number().nonnegative().describe("Distancia geodésica en línea recta (ST_Distance sobre geography)."),
  wheelchair_boarding: z.number().int().nullable(),
});

export const stopsNearResponseDataSchema = z.object({
  stops: z.array(stopNearItemSchema),
});

export const stopsNearResponseSchema = successEnvelope(stopsNearResponseDataSchema);
