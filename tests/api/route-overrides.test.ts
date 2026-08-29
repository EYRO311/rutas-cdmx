/**
 * `route_overrides` (migrations/0017_route_overrides.sql) y su consumo en
 * `lookupRouteModes` (src/api/engine/real-router-engine.ts). Ver
 * docs/handoff/01-datos.md secciones 5.1 y 6, y el comentario de módulo
 * de real-router-engine.ts punto 7 -- resuelve el hallazgo abierto desde
 * Fase 1: `routes.agency_id = 'SEMOVI'` (ruta TR13, Trolebús) no existe en
 * `agency.txt`.
 *
 * Nota real (2026-08-28, investigado al construir este test): TR13 no
 * tiene NINGUNA fila en `stop_times` (solo trae `frequencies`, sin
 * secuencia de paradas) -- es inalcanzable por el motor de ruteo hoy,
 * independientemente de este fix. Por eso este test verifica el mecanismo
 * de override directamente (contra Postgres real), no un caso end-to-end
 * de `/v1/routes` -- ese caso no puede existir hasta que `datos-gtfs`
 * resuelva ese gap distinto y más profundo, fuera de alcance aquí.
 */
import "dotenv/config";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { lookupRouteModes } from "../../src/api/engine/real-router-engine.ts";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"], max: 3 });
afterAll(async () => {
  await pool.end();
});

describe("route_overrides", () => {
  it("TR13 (agency_id real 'SEMOVI', sin match en agency.txt) resuelve a modo 'trole' vía el override sembrado en la migración 0017", async () => {
    const modes = await lookupRouteModes(pool, ["TR13"]);
    expect(modes.get("TR13")).toBe("trole");
  });

  it("el agency_id crudo de una ruta real, SIN override activo, sigue resolviendo directo (el mecanismo no interfiere cuando no hace falta)", async () => {
    const { rows } = await pool.query<{ route_id: string }>(
      `SELECT route_id FROM routes WHERE agency_id = 'METRO' LIMIT 1;`
    );
    const metroRouteId = rows[0]!.route_id;
    const modes = await lookupRouteModes(pool, [metroRouteId]);
    expect(modes.get(metroRouteId)).toBe("metro");
  });

  it("un override activo tiene prioridad sobre agency_id, y desactivarlo (is_active=false) vuelve a exponer el dato crudo", async () => {
    const { rows } = await pool.query<{ route_id: string }>(
      `SELECT route_id FROM routes WHERE agency_id = 'MB' LIMIT 1;`
    );
    const mbRouteId = rows[0]!.route_id;

    await pool.query(
      `INSERT INTO route_overrides (route_id, override_agency_id, reason, created_by)
       VALUES ($1, 'RTP', 'test: verificar prioridad del override', 'vitest');`,
      [mbRouteId]
    );
    try {
      const withOverride = await lookupRouteModes(pool, [mbRouteId]);
      expect(withOverride.get(mbRouteId)).toBe("rtp");

      await pool.query(`UPDATE route_overrides SET is_active = false WHERE route_id = $1;`, [mbRouteId]);
      const withoutOverride = await lookupRouteModes(pool, [mbRouteId]);
      expect(withoutOverride.get(mbRouteId)).toBe("metrobus");
    } finally {
      await pool.query(`DELETE FROM route_overrides WHERE route_id = $1 AND created_by = 'vitest';`, [mbRouteId]);
    }
  });
});
