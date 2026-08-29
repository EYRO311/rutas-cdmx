/**
 * Resuelve el parámetro "lugar" que aceptan `calcular_ruta` y
 * `paradas_cercanas`: coordenadas explícitas, o un nombre guardado del
 * usuario ("casa", "ESCOM" -- tabla `saved_places`, migración
 * `0010_user_tables.sql`, ver docs/handoff/02-grafo.md sección 3.4).
 *
 * Regla dura del brief: "si el usuario dice 'al centro', la herramienta
 * no debe adivinar. Devuelve las opciones candidatas para que el
 * asistente pregunte." Este proyecto NO tiene ningún geocodificador de
 * texto libre conectado (no hay Google Geocoding ni Nominatim en el stack
 * -- CLAUDE.md solo menciona Google Routes API para ETA de auto). Por
 * eso "candidatos" aquí significa, honestamente, coincidencias dentro de
 * `saved_places` del usuario -- no una búsqueda geográfica de topónimos
 * libres. Si el texto no matchea ningún lugar guardado, la respuesta lo
 * dice explícito y pide coordenadas en vez de inventar un resultado. Ver
 * docs/handoff/06-mcp.md, sección "Decisiones", para más detalle de este
 * gap.
 */
import { getMcpPgPool } from "./db.js";

export interface ResolvedCoord {
  lat: number;
  lon: number;
  /** Cómo se resolvió, para que la herramienta pueda decir "casa (guardado)" en vez de solo un par de números. */
  label: string | null;
}

export type PlaceResolution =
  | { kind: "resolved"; coord: ResolvedCoord }
  | { kind: "ambiguous"; query: string; candidates: ResolvedCoord[] }
  | { kind: "not_found"; query: string; savedPlaces: ResolvedCoord[] }
  | { kind: "needs_user_id"; query: string };

const COORD_PATTERN = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

export type PlaceInput = string | { lat: number; lon: number };

export async function resolvePlace(userId: string | undefined, input: PlaceInput): Promise<PlaceResolution> {
  if (typeof input === "object") {
    return { kind: "resolved", coord: { lat: input.lat, lon: input.lon, label: null } };
  }

  const trimmed = input.trim();
  const coordMatch = COORD_PATTERN.exec(trimmed);
  if (coordMatch) {
    const lat = Number(coordMatch[1]);
    const lon = Number(coordMatch[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return { kind: "resolved", coord: { lat, lon, label: null } };
    }
  }

  if (!userId) {
    return { kind: "needs_user_id", query: trimmed };
  }

  const pool = getMcpPgPool();

  const exact = await pool.query<{ label: string; lat: number; lon: number }>(
    `SELECT label, lat, lon FROM saved_places WHERE user_id = $1 AND lower(label) = lower($2) LIMIT 1`,
    [userId, trimmed]
  );
  if (exact.rows.length === 1) {
    const r = exact.rows[0]!;
    return { kind: "resolved", coord: { lat: r.lat, lon: r.lon, label: r.label } };
  }

  const partial = await pool.query<{ label: string; lat: number; lon: number }>(
    `SELECT label, lat, lon FROM saved_places WHERE user_id = $1 AND label ILIKE $2 ORDER BY label LIMIT 10`,
    [userId, `%${trimmed}%`]
  );
  if (partial.rows.length === 1) {
    const r = partial.rows[0]!;
    return { kind: "resolved", coord: { lat: r.lat, lon: r.lon, label: r.label } };
  }
  if (partial.rows.length > 1) {
    return {
      kind: "ambiguous",
      query: trimmed,
      candidates: partial.rows.map((r) => ({ lat: r.lat, lon: r.lon, label: r.label })),
    };
  }

  const all = await pool.query<{ label: string; lat: number; lon: number }>(
    `SELECT label, lat, lon FROM saved_places WHERE user_id = $1 ORDER BY label LIMIT 20`,
    [userId]
  );
  return {
    kind: "not_found",
    query: trimmed,
    savedPlaces: all.rows.map((r) => ({ lat: r.lat, lon: r.lon, label: r.label })),
  };
}

/** Mensaje en lenguaje natural para cuando `resolvePlace` no puede dar una coordenada directa. */
export function describeUnresolved(res: Exclude<PlaceResolution, { kind: "resolved" }>): string {
  if (res.kind === "needs_user_id") {
    return (
      `No reconozco "${res.query}" como coordenadas, y no me diste user_id para buscarlo entre tus lugares ` +
      `guardados. Manda coordenadas explícitas (lat,lon) o incluye user_id.`
    );
  }
  if (res.kind === "ambiguous") {
    const opciones = res.candidates.map((c) => `"${c.label}" (${c.lat.toFixed(4)}, ${c.lon.toFixed(4)})`).join(", ");
    return `"${res.query}" coincide con varios lugares guardados: ${opciones}. Pregunta al usuario cuál es.`;
  }
  // not_found
  if (res.savedPlaces.length === 0) {
    return (
      `No reconozco "${res.query}" -- no son coordenadas válidas y este usuario no tiene lugares guardados ` +
      `todavía. Pide coordenadas explícitas, o el nombre exacto de un lugar si ya lo guardó antes.`
    );
  }
  const guardados = res.savedPlaces.map((p) => `"${p.label}"`).join(", ");
  return (
    `No reconozco "${res.query}" -- no son coordenadas válidas y no coincide con ningún lugar guardado de este ` +
    `usuario. Sus lugares guardados son: ${guardados}. Pregunta cuál quiso decir, o pide coordenadas.`
  );
}
