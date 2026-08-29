/**
 * Cliente delgado hacia la API HTTP real (`src/api/`). Todas las
 * herramientas que tienen equivalente HTTP (`calcular_ruta` ->
 * `POST /v1/routes`, `paradas_cercanas` -> `GET /v1/stops/near`,
 * `registrar_viaje` -> `POST /v1/trips`, la lectura de config de auto
 * dentro de `puede_circular_hoy` -> `GET /v1/modes`) pasan por aquí. Nunca
 * importa nada de `src/api/` -- solo hace `fetch` real contra el server
 * Fastify, exactamente como cualquier otro consumidor externo.
 *
 * Envuelve la forma de respuesta `{data, meta, error}` (docs/handoff/
 * 05-api.md) en un resultado discriminado para que las herramientas no
 * tengan que repetir el manejo de errores HTTP en cada una.
 */
import { loadConfig } from "./config.js";

export interface ApiEnvelope<T> {
  data: T | null;
  meta: Record<string, unknown>;
  error: { code: string; message: string; details?: unknown } | null;
}

export type ApiResult<T> =
  | { ok: true; data: T; meta: Record<string, unknown> }
  | { ok: false; code: string; message: string; httpStatus: number };

async function request<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  opts?: { query?: Record<string, string | number | undefined>; body?: unknown }
): Promise<ApiResult<T>> {
  const cfg = loadConfig();

  const url = new URL(cfg.apiBaseUrl + path);
  if (opts?.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { "X-API-Key": cfg.apiKey } : {}),
      },
      ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    });

    let envelope: ApiEnvelope<T> | undefined;
    try {
      envelope = (await res.json()) as ApiEnvelope<T>;
    } catch {
      return {
        ok: false,
        code: "BAD_RESPONSE",
        message: `La API respondió ${res.status} sin cuerpo JSON válido.`,
        httpStatus: res.status,
      };
    }

    if (!res.ok || envelope.error) {
      return {
        ok: false,
        code: envelope.error?.code ?? "HTTP_ERROR",
        message: envelope.error?.message ?? `La API respondió ${res.status}.`,
        httpStatus: res.status,
      };
    }

    return { ok: true, data: envelope.data as T, meta: envelope.meta };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      code: isAbort ? "TIMEOUT" : "NETWORK_ERROR",
      message: isAbort
        ? `La API no respondió en ${cfg.requestTimeoutMs}ms (${cfg.apiBaseUrl}${path}).`
        : `No se pudo conectar a la API en ${cfg.apiBaseUrl}${path}: ${err instanceof Error ? err.message : String(err)}.`,
      httpStatus: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const apiClient = {
  get: <T>(path: string, query?: Record<string, string | number | undefined>) =>
    request<T>("GET", path, query !== undefined ? { query } : {}),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
};
