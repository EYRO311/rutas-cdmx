import type { FastifyReply, FastifyRequest } from "fastify";

export function buildMeta(req: FastifyRequest, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    request_id: String(req.id),
    generated_at: new Date().toISOString(),
    ...extra,
  };
}

/** Envía `{ data, meta, error: null }`. `statusCode` default 200. */
export function sendOk(
  reply: FastifyReply,
  req: FastifyRequest,
  data: unknown,
  opts?: { statusCode?: number; meta?: Record<string, unknown> }
): FastifyReply {
  return reply.code(opts?.statusCode ?? 200).send({
    data,
    meta: buildMeta(req, opts?.meta),
    error: null,
  });
}
