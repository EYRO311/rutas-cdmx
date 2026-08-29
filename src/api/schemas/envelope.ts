import { z } from "zod";

/**
 * Forma estable de toda respuesta (.claude/agents/api-http.md, regla
 * dura): `{ data, meta, error }`, nunca un array pelón. Éxito = `data`
 * poblado + `error: null`. Falla = `data: null` + `error` poblado. `meta`
 * siempre va, incluso en error (trae al menos `request_id`).
 */

export const errorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "CONFLICT",
  "ENGINE_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

export const errorShapeSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  })
  .describe("Error tipado. Solo presente cuando `data` es null.");

export const baseMetaSchema = z
  .object({
    request_id: z.string().describe("Id de correlación de este request, útil para buscar en logs."),
    generated_at: z.iso.datetime().describe("Momento en que el servidor construyó esta respuesta."),
  })
  .catchall(z.unknown())
  .describe("Metadatos de la respuesta. Puede traer campos adicionales según el endpoint.");

export function successEnvelope<D extends z.ZodTypeAny>(dataSchema: D) {
  return z
    .object({
      data: dataSchema,
      meta: baseMetaSchema,
      error: z.null(),
    })
    .describe("Respuesta exitosa.");
}

export function errorEnvelope() {
  return z
    .object({
      data: z.null(),
      meta: baseMetaSchema,
      error: errorShapeSchema,
    })
    .describe("Respuesta de error.");
}

export type ErrorShape = z.infer<typeof errorShapeSchema>;

/** Respuestas de error típicas para documentar en cada ruta autenticada. */
export const authedErrorResponses = {
  400: errorEnvelope(),
  401: errorEnvelope(),
  500: errorEnvelope(),
} as const;

/** Igual que `authedErrorResponses` pero sin 401 (rutas públicas, ej. /health). */
export const publicErrorResponses = {
  500: errorEnvelope(),
} as const;

