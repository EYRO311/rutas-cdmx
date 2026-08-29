import type { Mode } from "../schemas/common.js";

/**
 * CONTRATO entre la capa HTTP (este agente) y el motor de ruteo real
 * (`algoritmo-ruteo`, Fase 3, en paralelo). Este archivo es la interfaz
 * que consume `src/api/routes/routes.ts` -- no depende de ninguna
 * implementación concreta. Mientras algoritmo-ruteo no exista, se usa
 * `StubRouterEngine` (ver stub-router-engine.ts). Cuando exista, se
 * conecta reemplazando UNA sola línea en `src/api/engine/index.ts` --
 * nada más en src/api/ debería necesitar cambios.
 *
 * Basado en el punto de entrada al grafo que describe
 * docs/handoff/02-grafo.md sección 8: `graph_stop_neighbors(stop,
 * fecha_servicio, segundos_desde_medianoche, ventana_segundos)`. Ese es un
 * detalle de implementación de algoritmo-ruteo -- esta interfaz no lo
 * expone, solo pide/devuelve lo que necesita el request/response HTTP.
 */

export interface EngineCoordinate {
  lat: number;
  lon: number;
}

/**
 * Un extremo (origen o destino) de un tramo. `stopId`/`name` son null para
 * puntos que no son un nodo del grafo (ej. el origen/destino exactos de un
 * tramo de caminata). Cuando sí hay nodo, `stopId` puede ser una parada
 * GTFS o una estación Ecobici (`RealRouterEngine` resuelve cada una contra
 * su tabla real según `ItineraryLeg.fromNodeType`/`toNodeType`) -- no
 * asumir que siempre es GTFS.
 */
export interface EngineStopRef {
  stopId: string | null;
  name: string | null;
  lat: number;
  lon: number;
}

export interface EngineRouteLeg {
  mode: Mode;
  durationS: number;
  costMxn: number;
  /** 0..1. Ver docs/handoff/02-grafo.md: GTFS estático del Metro (2022) vale menos que GTFS-RT de Metrobús. */
  confidence: number;
  from: EngineStopRef;
  to: EngineStopRef;
  routeId?: string | null;
  tripId?: string | null;
  departureAt?: Date | null;
  arrivalAt?: Date | null;
  /** Polyline codificada (Google) para tramos AUTO vía Google Routes API, si aplica. */
  polyline?: string | null;
}

export interface EngineRouteOption {
  /** Id estable dentro de la respuesta (no tiene que persistir entre requests). */
  id: string;
  legs: EngineRouteLeg[];
  summary: {
    durationS: number;
    costMxn: number;
    confidence: number;
    transfers: number;
    distanceM?: number | null;
  };
}

export interface RouteQuery {
  origin: EngineCoordinate;
  destination: EngineCoordinate;
  /**
   * Instante concreto de salida, ya resuelto por la capa HTTP:
   * - Si el cliente mandó `departure_at`, es ese valor.
   * - Si el cliente mandó `arrival_at`, la capa HTTP NO hace el cálculo
   *   "hacia atrás" -- lo manda tal cual en `arrivalAt` y deja
   *   `departureAt` como el momento del request (ahora), documentado como
   *   mejor esfuerzo. NINGÚN motor implementado hoy resuelve "llegar antes
   *   de X": ni `StubRouterEngine` (lo ignora para el cálculo, solo lo
   *   refleja) ni `RealRouterEngine` (`PlanRequest` de `algoritmo-ruteo`,
   *   docs/handoff/03-algoritmo.md sección 9, no tiene ningún parámetro de
   *   "llegar antes de" -- gap real, documentado en docs/handoff/05-api.md,
   *   no inventado aquí). `src/api/routes/routes.ts` agrega un warning
   *   explícito en `meta` cuando esto pasa, para que el cliente no asuma
   *   que se honró.
   * - Si el cliente no mandó ninguno, es "ahora" (Date.now() en el
   *   servidor, zona horaria del proceso -- Vercel corre en UTC).
   */
  departureAt: Date;
  arrivalAt: Date | null;
  isArriveBy: boolean;
  allowedModes: Mode[] | null;
  maxResults: number;
  userId: string | null;
}

export interface EngineComputeResult {
  options: EngineRouteOption[];
  /**
   * Metadatos de observabilidad propios del motor -- NUNCA parte del
   * contrato semántico de una ruta (nada aquí debería ser necesario para
   * interpretar `options`). El motor real (`RealRouterEngine`) los llena
   * con lo que expone `PlanResult.meta`/`PlanResult.confidence` de
   * `algoritmo-ruteo` (docs/handoff/03-algoritmo.md sección 9): p.ej.
   * `plan_confidence: "full" | "degraded_radius_8km" | "no_coverage"`,
   * `truncated_by_expansion_cap`. `StubRouterEngine` no tiene nada
   * análogo que reportar y devuelve `{}`.
   */
  meta: Record<string, unknown>;
}

export interface RouterEngine {
  readonly name: string;
  readonly version: string;
  /** true = respuesta sintética (stub), false = motor real. Se refleja en `meta.engine.is_stub` de la respuesta HTTP -- un consumidor NUNCA debería confundir una ruta stub con una real. */
  readonly isStub: boolean;
  computeRoutes(query: RouteQuery): Promise<EngineComputeResult>;
}
