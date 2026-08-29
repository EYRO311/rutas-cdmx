/**
 * Errores tipados de la API. Regla dura (.claude/agents/api-http.md):
 * "Errores tipados con código propio, nunca un 500 genérico" -- se
 * interpreta como "toda respuesta de error, incluidos los 500, tiene
 * `{ code, message }` estructurado", no como "un 500 nunca puede pasar"
 * (eso sería mentir: bugs y caídas de Postgres van a pasar). Lo que no
 * pasa nunca es devolver el stack trace crudo de Node o un cuerpo vacío.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "ENGINE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(params: {
    statusCode: number;
    code: ErrorCode;
    message: string;
    details?: unknown;
  }) {
    super(params.message);
    this.name = "AppError";
    this.statusCode = params.statusCode;
    this.code = params.code;
    this.details = params.details;
  }
}

export class ValidationAppError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ statusCode: 400, code: "VALIDATION_ERROR", message, details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "API key inválida, revocada o ausente.", details?: unknown) {
    super({ statusCode: 401, code: "UNAUTHORIZED", message, details });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ statusCode: 404, code: "NOT_FOUND", message, details });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ statusCode: 409, code: "CONFLICT", message, details });
  }
}

/** El motor de ruteo real (algoritmo-ruteo) no está disponible o rechazó la consulta. */
export class EngineUnavailableError extends AppError {
  constructor(message = "El motor de ruteo no pudo procesar la consulta.", details?: unknown) {
    super({ statusCode: 503, code: "ENGINE_UNAVAILABLE", message, details });
  }
}

export class InternalAppError extends AppError {
  constructor(message = "Error interno. Ya quedó registrado en los logs del servidor.", details?: unknown) {
    super({ statusCode: 500, code: "INTERNAL_ERROR", message, details });
  }
}
