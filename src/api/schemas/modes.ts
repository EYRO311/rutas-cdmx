import { z } from "zod";
import { modeSchema } from "./common.js";
import { successEnvelope } from "./envelope.js";

/**
 * GET/PUT /v1/modes -- configuración de modos de transporte del usuario
 * (tabla `user_modes`, docs/handoff/02-grafo.md sección 3.4). Los campos
 * de AUTO quedan NULL para cualquier modo que no sea 'auto' (mismo
 * comportamiento que la tabla).
 */
export const userModeSchema = z.object({
  mode: modeSchema,
  is_enabled: z.boolean().default(true),
  tiene_auto: z.boolean().nullable().optional(),
  rendimiento_km_l: z.number().positive().nullable().optional(),
  costo_combustible: z.number().nonnegative().nullable().optional(),
  tolerancia_estacionamiento_min: z.number().int().nonnegative().nullable().optional(),
  terminacion_placa: z.number().int().min(0).max(9).nullable().optional(),
  holograma: z.string().nullable().optional(),
  evita_casetas: z.boolean().nullable().optional(),
});
export type UserMode = z.infer<typeof userModeSchema>;

export const getModesQuerySchema = z.object({
  user_id: z.string().min(1).max(128),
});

export const putModesRequestSchema = z.object({
  user_id: z.string().min(1).max(128),
  modes: z.array(userModeSchema).min(1),
});

const modesResponseDataSchema = z.object({
  user_id: z.string(),
  modes: z.array(userModeSchema),
});

export const modesResponseSchema = successEnvelope(modesResponseDataSchema);
