import { createHash } from "node:crypto";

/**
 * Hash de una API key en claro para comparar contra `api_keys.key_hash`.
 * SHA-256 hex, sin sal: es aceptable para este caso (keys de alta entropía
 * generadas por `scripts/seed-api-key.ts`, no contraseñas elegidas por un
 * humano) -- el riesgo que mitiga bcrypt/argon2 es fuerza bruta sobre
 * contraseñas de baja entropía, que no aplica aquí. Compartido entre el
 * seed script y el plugin de auth para que ambos hasheen igual.
 */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}
