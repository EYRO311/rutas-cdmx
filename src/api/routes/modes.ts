import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getPrisma } from "../db/prisma.js";
import { getModesQuerySchema, modesResponseSchema, putModesRequestSchema, type UserMode } from "../schemas/modes.js";
import type { Mode } from "../schemas/common.js";
import { authedErrorResponses } from "../schemas/envelope.js";
import { sendOk } from "../lib/reply.js";

/**
 * GET/PUT /v1/modes -- configuración de modos de transporte del usuario,
 * tabla `user_modes` (docs/handoff/02-grafo.md sección 3.4). A diferencia
 * de POST /v1/routes, esto NO depende del motor de ruteo: usa el cliente
 * Prisma tipado normal (el modelo `user_modes` ya está en
 * prisma/schema.prisma desde Fase 2, sin columnas de geometría).
 */
export const modesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: "GET",
    url: "/modes",
    schema: {
      tags: ["modes"],
      querystring: getModesQuerySchema,
      response: { 200: modesResponseSchema, ...authedErrorResponses },
    },
    handler: async (req, reply) => {
      const { user_id } = req.query;
      const rows = await getPrisma().user_modes.findMany({
        where: { user_id },
        orderBy: { mode: "asc" },
      });

      return sendOk(reply, req, {
        user_id,
        modes: rows.map(toUserModeDto),
      });
    },
  });

  app.route({
    method: "PUT",
    url: "/modes",
    schema: {
      tags: ["modes"],
      body: putModesRequestSchema,
      response: { 200: modesResponseSchema, ...authedErrorResponses },
    },
    handler: async (req, reply) => {
      const { user_id, modes } = req.body;
      const prisma = getPrisma();

      await prisma.$transaction(
        modes.map((m) =>
          prisma.user_modes.upsert({
            where: { user_id_mode: { user_id, mode: m.mode } },
            create: { user_id, ...toUpsertFields(m) },
            update: toUpsertFields(m),
          })
        )
      );

      const rows = await prisma.user_modes.findMany({
        where: { user_id },
        orderBy: { mode: "asc" },
      });

      return sendOk(reply, req, {
        user_id,
        modes: rows.map(toUserModeDto),
      });
    },
  });
};

function toUpsertFields(m: UserMode) {
  return {
    mode: m.mode,
    is_enabled: m.is_enabled,
    tiene_auto: m.tiene_auto ?? null,
    rendimiento_km_l: m.rendimiento_km_l ?? null,
    costo_combustible: m.costo_combustible ?? null,
    tolerancia_estacionamiento_min: m.tolerancia_estacionamiento_min ?? null,
    terminacion_placa: m.terminacion_placa ?? null,
    holograma: m.holograma ?? null,
    evita_casetas: m.evita_casetas ?? null,
  };
}

interface UserModeRow {
  mode: string;
  is_enabled: boolean;
  tiene_auto: boolean | null;
  rendimiento_km_l: number | null;
  costo_combustible: number | null;
  tolerancia_estacionamiento_min: number | null;
  terminacion_placa: number | null;
  holograma: string | null;
  evita_casetas: boolean | null;
}

function toUserModeDto(row: UserModeRow): UserMode {
  return {
    mode: row.mode as Mode,
    is_enabled: row.is_enabled,
    tiene_auto: row.tiene_auto,
    rendimiento_km_l: row.rendimiento_km_l,
    costo_combustible: row.costo_combustible,
    tolerancia_estacionamiento_min: row.tolerancia_estacionamiento_min,
    terminacion_placa: row.terminacion_placa,
    holograma: row.holograma,
    evita_casetas: row.evita_casetas,
  };
}
