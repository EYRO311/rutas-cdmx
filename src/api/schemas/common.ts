import { z } from "zod";

/**
 * Modos de transporte conocidos. Se deriva de las agencias reales del GTFS
 * cargado (docs/handoff/01-datos.md: METRO, MB=metrobus, RTP, CC, TROLE,
 * CBB=cablebus, PUMABUS, TL=tren_ligero, SUB=suburbano, INTERURBANO) más
 * los modos que no vienen de GTFS (ecobici, walk, auto -- CLAUDE.md
 * decisión #3, AUTO es terminal) y `transfer`, que es un tipo de arista de
 * `graph_stop_neighbors()` (docs/handoff/02-grafo.md sección 3.5), no una
 * agencia, pero puede aparecer como tramo de ruta (un transbordo caminado
 * dentro de la misma estación).
 *
 * Es un enum cerrado a propósito -- si algoritmo-ruteo necesita un modo
 * nuevo, se agrega aquí explícitamente (punto de extensión documentado),
 * no se vuelve `z.string()` libre: la validación de forma es parte del
 * contrato de esta capa.
 */
export const KNOWN_MODES = [
  "metro",
  "metrobus",
  "rtp",
  "cc",
  "trole",
  "cablebus",
  "pumabus",
  "tren_ligero",
  "suburbano",
  "interurbano",
  "ecobici",
  "walk",
  "auto",
  "transfer",
  /**
   * Fallback defensivo para el motor real (`RealRouterEngine`, Fase 3
   * `algoritmo-ruteo`): un tramo `ride` cuyo `route_id` no mapea a una
   * agencia conocida (ver AGENCY_TO_MODE en
   * src/api/engine/real-router-engine.ts). Pasa hoy con exactamente 1 ruta
   * real (`agency_id = 'SEMOVI'`, ruta TR13 -- ver
   * docs/handoff/01-datos.md sección "Lo que no se pudo verificar": ese
   * `agency_id` no existe en `agency.txt`, así que NO se adivina cuál
   * agencia es de verdad). Deliberado: nunca se inventa un modo específico
   * para datos sucios, se declara explícitamente "no se sabe".
   */
  "transit",
] as const;

export const modeSchema = z.enum(KNOWN_MODES).describe("Modo de transporte de un tramo.");
export type Mode = z.infer<typeof modeSchema>;

export const coordinateSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  })
  .describe("Coordenada WGS84.");
export type Coordinate = z.infer<typeof coordinateSchema>;

export const confidenceSchema = z
  .number()
  .min(0)
  .max(1)
  .describe(
    "Qué tanto confiar en este dato: 1 = medido/tiempo real, valores bajos = estimado sobre GTFS estático viejo o heurística de distancia. Ver .claude/agents/api-http.md."
  );
