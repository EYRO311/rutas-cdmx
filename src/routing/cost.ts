/**
 * Función de costo configurable. Los pesos NUNCA están hardcodeados dentro
 * del algoritmo: siempre llegan como parámetro `CostWeights`, cargado desde
 * `user_preferences` (con defaults documentados si no hay fila — la tabla
 * está vacía hoy, ver docs/handoff/02-grafo.md sección 3.4) o inyectado
 * directamente en los tests.
 *
 * Qué SÍ tiene columna real en user_preferences (migrations/0010_user_tables.sql):
 * weight_time, weight_cost, walking_speed_mps, max_transfers, crowding_tolerance.
 *
 * Qué NO tiene columna (documentado explícitamente, no es un descuido):
 * penalización de transbordo, multiplicador de caminata, penalización de
 * saturación, tarifa por abordaje. `user_preferences` fue diseñada por
 * `modelo-grafo` (Fase 2) antes de que existiera este agente; extenderla
 * con esas columnas es una mejora legítima para Fase 5 (`aprendizaje-beta`,
 * que es quien ajusta estos pesos según CLAUDE.md), no algo que
 * corresponda decidir en Fase 3. Mientras tanto viven como constantes de
 * configuración en config.ts (COST_DEFAULTS), pasadas explícitamente.
 */
import type { Pool } from "pg";
import type { CostWeights, Label } from "./types.ts";
import { COST_DEFAULTS, USER_PREFERENCES_DEFAULTS, WINDOW } from "./config.ts";

export function defaultCostWeights(): CostWeights {
  return {
    weightTime: USER_PREFERENCES_DEFAULTS.weightTime,
    weightCost: USER_PREFERENCES_DEFAULTS.weightCost,
    walkingSpeedMps: USER_PREFERENCES_DEFAULTS.walkingSpeedMps,
    maxTransfers: Math.min(USER_PREFERENCES_DEFAULTS.maxTransfers, WINDOW.MAX_ROUNDS),
    crowdingTolerance: USER_PREFERENCES_DEFAULTS.crowdingTolerance,
    transferPenaltySecs: COST_DEFAULTS.transferPenaltySecs,
    walkPenaltyMultiplier: COST_DEFAULTS.walkPenaltyMultiplier,
    crowdingPenaltySecsPerBoarding: crowdingPenaltyFor(USER_PREFERENCES_DEFAULTS.crowdingTolerance),
    flatFarePesosPerBoarding: COST_DEFAULTS.flatFarePesosPerBoarding,
  };
}

function crowdingPenaltyFor(tolerance: number): number {
  // tolerance 1 (odia el gentío) -> penalización alta; 5 (le da igual) -> ~0.
  // Lineal alrededor del punto neutro (3), en pasos de COST_DEFAULTS.crowdingPenaltySecsBase.
  const stepsFromNeutral = 3 - tolerance;
  return Math.max(0, COST_DEFAULTS.crowdingPenaltySecsBase * (1 + stepsFromNeutral));
}

interface UserPreferencesRow {
  walking_speed_mps: number;
  max_transfers: number;
  crowding_tolerance: number;
  weight_time: number;
  weight_cost: number;
}

/**
 * Carga los pesos de un usuario desde `user_preferences`, con fallback a
 * defaults documentados si no hay fila (tabla vacía hoy — 0 usuarios reales,
 * ver docs/handoff/02-grafo.md). Las columnas sin equivalente en el esquema
 * (transferPenaltySecs, walkPenaltyMultiplier, flatFarePesosPerBoarding)
 * siempre vienen de COST_DEFAULTS; crowdingPenaltySecsPerBoarding se deriva
 * de crowding_tolerance si existe fila, o del default si no.
 */
export async function loadCostWeights(pool: Pool, userId: string | undefined): Promise<CostWeights> {
  const base = defaultCostWeights();
  if (!userId) return base;

  const { rows } = await pool.query<UserPreferencesRow>(
    `SELECT walking_speed_mps, max_transfers, crowding_tolerance, weight_time, weight_cost
     FROM user_preferences WHERE user_id = $1`,
    [userId]
  );
  const row = rows[0];
  if (!row) return base;

  return {
    ...base,
    weightTime: row.weight_time,
    weightCost: row.weight_cost,
    walkingSpeedMps: row.walking_speed_mps,
    maxTransfers: Math.min(row.max_transfers, WINDOW.MAX_ROUNDS),
    crowdingTolerance: row.crowding_tolerance,
    crowdingPenaltySecsPerBoarding: crowdingPenaltyFor(row.crowding_tolerance),
  };
}

/**
 * Costo escalarizado de un label completo, usado para: (a) ordenar la cola
 * de prioridad en dijkstra.ts/raptor.ts, (b) rankear itinerarios finales
 * Pareto-óptimos entre sí para decidir cuál mostrar primero. La poda
 * interna del algoritmo sigue siendo por dominancia de Pareto (labels.ts);
 * este escalar NUNCA descarta un label, solo ordena.
 */
export function scalarCost(label: Label, weights: CostWeights, originDepartSecs: number): number {
  const travelSecs = label.arrivalSecs - originDepartSecs;
  const timeComponent = travelSecs + label.transfers * weights.transferPenaltySecs;
  const walkComponent = label.walkSecs * (weights.walkPenaltyMultiplier - 1);
  const crowdingComponent = label.transfers * weights.crowdingPenaltySecsPerBoarding;
  // weight_cost pondera el costo monetario, convertido a "segundos
  // equivalentes" con una tasa fija de conversión para poder sumarlo al
  // resto en una sola escala. 60 segundos ~ 1 minuto por peso es una
  // decisión de escala documentada aquí, no una medición de disposición a
  // pagar real (eso es trabajo de aprendizaje-beta con datos reales).
  const costComponentSecs = label.costPesos * 60;

  return (
    weights.weightTime * (timeComponent + walkComponent + crowdingComponent) +
    weights.weightCost * costComponentSecs
  );
}

/** Cuántos segundos toma caminar una distancia dada (línea recta ya ajustada por circuidad si viene de walk_edges). */
export function walkSecondsFromMeters(meters: number, walkingSpeedMps: number): number {
  return meters / walkingSpeedMps;
}
