import { RealRouterEngine } from "./real-router-engine.js";
import type { RouterEngine } from "./router-engine.js";

/**
 * PUNTO DE CONEXIÓN ÚNICO para el motor de ruteo real.
 *
 * `algoritmo-ruteo` (Fase 3) ya terminó y expone `planRoute` en
 * `src/routing/index.ts` (contrato en docs/handoff/03-algoritmo.md sección
 * 9) -- `RealRouterEngine` (src/api/engine/real-router-engine.ts) es el
 * adapter que lo envuelve detrás de `RouterEngine`. `StubRouterEngine`
 * sigue existiendo (src/api/engine/stub-router-engine.ts) para tests que
 * no necesitan Postgres/el motor real, pero ya no es lo que usa la app en
 * runtime.
 */
export const routerEngine: RouterEngine = new RealRouterEngine();

export { RealRouterEngine } from "./real-router-engine.js";
export { StubRouterEngine } from "./stub-router-engine.js";
export type {
  EngineComputeResult,
  EngineRouteLeg,
  EngineRouteOption,
  EngineStopRef,
  RouteQuery,
  RouterEngine,
} from "./router-engine.js";
