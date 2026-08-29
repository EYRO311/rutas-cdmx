import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { AppError, type ErrorCode } from "../lib/errors.js";
import { buildMeta } from "../lib/reply.js";

function sendError(
  reply: FastifyReply,
  req: FastifyRequest,
  statusCode: number,
  code: ErrorCode,
  message: string,
  details?: unknown
): FastifyReply {
  return reply.code(statusCode).send({
    data: null,
    meta: buildMeta(req),
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  });
}

/**
 * Handler de errores central. Regla dura: nunca un 500 genérico -- toda
 * respuesta de error, incluidos los 500 reales de infraestructura
 * (Postgres caído, bug no anticipado), sale con `{ code, message }`
 * tipado en el envelope `{ data: null, meta, error }`. El stack trace y
 * los detalles crudos se van al logger de Fastify (server-side), nunca al
 * cliente.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) {
      req.log[err.statusCode >= 500 ? "error" : "info"]({ err }, `[${err.code}] ${err.message}`);
      return sendError(reply, req, err.statusCode, err.code, err.message, err.details);
    }

    // Body/querystring/params que no pasaron el schema Zod de entrada.
    if (hasZodFastifySchemaValidationErrors(err)) {
      return sendError(reply, req, 400, "VALIDATION_ERROR", "El request no cumple el schema esperado.", {
        issues: err.validation,
      });
    }

    // La RESPUESTA que armó el handler no cumple su propio schema de salida:
    // es un bug nuestro, no del cliente. Se loguea completo, se oculta al cliente.
    if (isResponseSerializationError(err)) {
      req.log.error({ err }, "response no cumple su schema de salida (bug del servidor)");
      return sendError(reply, req, 500, "INTERNAL_ERROR", "Error interno al construir la respuesta.");
    }

    // Errores nativos de Fastify (body malformado, content-type inválido, payload
    // demasiado grande, rate limit del framework, etc.) ya traen statusCode.
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      req.log.info({ err }, "error 4xx de Fastify");
      const code: ErrorCode = statusCode === 404 ? "NOT_FOUND" : "VALIDATION_ERROR";
      return sendError(reply, req, statusCode, code, err.message || "Request inválido.");
    }

    // Cualquier otra cosa: bug o falla de infraestructura no anticipada.
    req.log.error({ err }, "error no manejado");
    return sendError(reply, req, 500, "INTERNAL_ERROR", "Error interno. Ya quedó registrado en los logs del servidor.");
  });

  app.setNotFoundHandler((req, reply) => {
    return sendError(reply, req, 404, "NOT_FOUND", `No existe ${req.method} ${req.url}.`);
  });
}
