import type { EngineComputeResult, EngineRouteOption, RouteQuery, RouterEngine } from "./router-engine.js";

const EARTH_RADIUS_M = 6_371_000;
/** Misma constante que usa walk_edges (docs/handoff/02-grafo.md sección 3.3): línea recta * factor de circuidad. */
const CIRCUITY_FACTOR = 1.3;
/** user_preferences.walking_speed_mps default (migración 0010_user_tables.sql). */
const DEFAULT_WALKING_SPEED_MPS = 1.4;
/** Por encima de esto ya no es razonable ofrecer "caminar todo el trayecto" como única opción. */
const MAX_STUB_WALK_METERS = 3000;

function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Motor de ruteo STUB. NO implementa RAPTOR ni ninguna búsqueda sobre el
 * grafo -- es responsabilidad de `algoritmo-ruteo` (Fase 3), que no es
 * esta fase. Existe únicamente para que la capa HTTP tenga algo real que
 * llamar y probar end-to-end mientras ese motor no existe.
 *
 * Comportamiento: siempre devuelve como máximo UNA opción, un solo tramo
 * `walk` en línea recta origen->destino (distancia haversine * 1.3, mismo
 * factor de circuidad que `walk_edges`), a la velocidad de caminata
 * default. Si la distancia supera `MAX_STUB_WALK_METERS`, devuelve arreglo
 * vacío (no hay "ruta" razonable que un stub de caminata pueda ofrecer
 * para 20km) -- eso es una respuesta 200 con `routes: []`, no un error:
 * el request es válido, simplemente no hay ruta que ofrecer todavía.
 *
 * `confidence` siempre 0.05: deliberadamente bajo, para que sea imposible
 * confundir esto con una ruta real incluso si alguien no revisa
 * `meta.engine.is_stub`.
 */
export class StubRouterEngine implements RouterEngine {
  readonly name = "stub-walk-only";
  readonly version = "0.1.0";
  readonly isStub = true;

  async computeRoutes(query: RouteQuery): Promise<EngineComputeResult> {
    const straightLineM = haversineMeters(query.origin, query.destination);
    const distanceM = straightLineM * CIRCUITY_FACTOR;

    if (distanceM > MAX_STUB_WALK_METERS) {
      return { options: [], meta: {} };
    }

    if (query.allowedModes && !query.allowedModes.includes("walk")) {
      // El stub solo sabe caminar. Si el cliente excluyó 'walk' explícitamente,
      // no hay nada honesto que devolver.
      return { options: [], meta: {} };
    }

    const durationS = Math.round(distanceM / DEFAULT_WALKING_SPEED_MPS);
    const departureAt = query.departureAt;
    const arrivalAt = new Date(departureAt.getTime() + durationS * 1000);

    const option: EngineRouteOption = {
      id: "stub-walk-1",
      legs: [
        {
          mode: "walk",
          durationS,
          costMxn: 0,
          confidence: 0.05,
          from: { stopId: null, name: "Origen", lat: query.origin.lat, lon: query.origin.lon },
          to: { stopId: null, name: "Destino", lat: query.destination.lat, lon: query.destination.lon },
          departureAt,
          arrivalAt,
        },
      ],
      summary: {
        durationS,
        costMxn: 0,
        confidence: 0.05,
        transfers: 0,
        distanceM,
      },
    };

    return { options: [option].slice(0, Math.max(1, query.maxResults)), meta: {} };
  }
}
