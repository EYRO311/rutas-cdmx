/**
 * Etapa 3 del brief: perfil de salida. No solo "la ruta ahora": "las
 * mejores rutas si salgo entre las 8:00 y las 9:00". Cada salida muestreada
 * corre una búsqueda RAPTOR completa (advertencia explícita del brief: esto
 * multiplica el costo de CPU por invocación) — por eso el muestreo está
 * acotado por `DEPARTURE_PROFILE.MAX_SAMPLES`, no es "cada minuto".
 *
 * Estrategia de muestreo: uniforme cada `SAMPLE_STEP_SECS` dentro de la
 * ventana pedida, acotado a `MAX_SAMPLES`. No es adaptativo (no intenta
 * detectar "huecos" de servicio para muestrear más denso ahí) — se deja
 * como límite conocido documentado en el handoff, una mejora razonable para
 * quien retome esto, no algo que esta fase resuelva.
 */
import type { Pool } from "pg";
import { planRoute, type Engine } from "./index.ts";
import { DEPARTURE_PROFILE, WINDOW } from "./config.ts";
import type { Itinerary, PlanRequest, PlanResult } from "./types.ts";

export interface DepartureProfileSample {
  departSecs: number;
  result: PlanResult;
}

export interface DepartureProfileResult {
  samples: DepartureProfileSample[];
  /** Unión de itinerarios de todas las muestras, podada por dominancia de Pareto (incluye departSecs como criterio adicional implícito vía scalarCost). */
  bestItineraries: Itinerary[];
  totalElapsedMs: number;
}

export async function planRouteProfile(
  pool: Pool,
  request: PlanRequest,
  windowSecs: number = DEPARTURE_PROFILE.DEFAULT_WINDOW_SECS,
  // Ver index.ts#planRoute: mismo default por la misma razón medida (Dijkstra
  // converge de forma más confiable dentro del presupuesto de latencia).
  engine: Engine = "dijkstra"
): Promise<DepartureProfileResult> {
  const startedAt = performance.now();

  const stepSecs = DEPARTURE_PROFILE.SAMPLE_STEP_SECS;
  const sampleCount = Math.min(
    DEPARTURE_PROFILE.MAX_SAMPLES,
    Math.max(1, Math.floor(windowSecs / stepSecs) + 1)
  );

  const departTimes: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    departTimes.push(request.departSecs + i * stepSecs);
  }

  const samples: DepartureProfileSample[] = [];
  for (const departSecs of departTimes) {
    const result = await planRoute(
      pool,
      { ...request, departSecs, horizonSecs: request.horizonSecs ?? WINDOW.TIME_HORIZON_SECS_PROFILE },
      engine
    );
    samples.push({ departSecs, result });
  }

  const allItineraries = samples.flatMap((s) => s.result.itineraries);
  const bestItineraries = dedupeAcrossSamples(allItineraries);

  return {
    samples,
    bestItineraries,
    totalElapsedMs: performance.now() - startedAt,
  };
}

function dedupeAcrossSamples(itineraries: Itinerary[]): Itinerary[] {
  const sorted = [...itineraries].sort((a, b) => a.scalarCost - b.scalarCost);
  const kept: Itinerary[] = [];
  for (const candidate of sorted) {
    const dominated = kept.some(
      (k) =>
        k.arriveSecs <= candidate.arriveSecs &&
        k.transfers <= candidate.transfers &&
        k.walkSecs <= candidate.walkSecs &&
        k.costPesos <= candidate.costPesos &&
        (k.arriveSecs < candidate.arriveSecs ||
          k.transfers < candidate.transfers ||
          k.walkSecs < candidate.walkSecs ||
          k.costPesos < candidate.costPesos)
    );
    if (!dominated) kept.push(candidate);
  }
  return kept;
}
