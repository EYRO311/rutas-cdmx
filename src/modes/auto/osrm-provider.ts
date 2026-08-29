/**
 * Proveedor de fallback: OSRM self-hosted (`/route/v1/{profile}/...`, API
 * HTTP pública y estable de OSRM — http://project-osrm.org/docs/v5.24.0/api/).
 * Se usa cuando Google Routes falla (error de red, 4xx/5xx, cuota agotada)
 * — ver fallback-provider.ts.
 *
 * ESTADO REAL: no hay ninguna instancia de OSRM corriendo en la infra de
 * este proyecto en esta fase (no está en docker-compose, no hay contenedor
 * `osrm-backend` local ni instancia remota configurada). Este archivo es
 * un stub FUNCIONAL: la lógica de request/response está implementada
 * completa contra el contrato real y documentado de la API HTTP de OSRM
 * (no es un mock ni un TODO), y se prueba con `fetchImpl` inyectado y
 * fixtures de respuesta (tests/auto/osrm-provider.test.ts) — pero nunca se
 * ejecutó contra un servidor OSRM real, porque no hay uno disponible.
 * Levantar `osrm-backend` con un extracto de CDMX (el mismo
 * `data/raw/osm/cdmx-pedestrian-cycling.json` que cargó datos-gtfs, aunque
 * OSRM necesita el `.osm.pbf` completo, no el extracto de Overpass ya
 * filtrado a peatonal/ciclista que se usó para walk_edges) es trabajo de
 * infraestructura fuera del alcance de esta fase.
 *
 * Importante: un OSRM self-hosted "vanilla" (perfil `car.lua` default) NO
 * tiene tráfico en vivo — su `duration` es tiempo de viaje sobre la red
 * vial a velocidad de perfil, no tráfico real. Por eso staticDurationSecs
 * y durationSecs son el mismo valor aquí: no hay forma de distinguir
 * "con tráfico" de "sin tráfico" sin un feed de traffic updates (posible
 * en OSRM vía `traffic.csv` / contraction hierarchies actualizables, pero
 * eso es infraestructura adicional no montada). Este proveedor es un
 * fallback de disponibilidad (que exista una ETA cuando Google no
 * responde), no un sustituto con la misma fidelidad de tráfico.
 */
import type { EtaProvider, EtaRequest, EtaResult } from "./eta-provider.ts";

interface OsrmRoute {
  distance?: number;
  duration?: number;
}

interface OsrmResponse {
  code?: string;
  message?: string;
  routes?: OsrmRoute[];
}

export interface OsrmProviderOptions {
  /** p.ej. "http://localhost:5000" — sin trailing slash. */
  baseUrl: string;
  profile?: string;
  /** Inyectable para tests — nunca se usa `fetch` global en pruebas. */
  fetchImpl?: typeof fetch;
}

export class OsrmProvider implements EtaProvider {
  readonly name = "osrm" as const;
  private readonly baseUrl: string;
  private readonly profile: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OsrmProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.profile = options.profile ?? "driving";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getEta(request: EtaRequest): Promise<EtaResult> {
    // OSRM usa lon,lat (orden GeoJSON), no lat,lon.
    const coords =
      `${request.origin.lon},${request.origin.lat}` +
      `;${request.destination.lon},${request.destination.lat}`;
    const url =
      `${this.baseUrl}/route/v1/${this.profile}/${coords}` +
      `?overview=false&alternatives=false&steps=false`;

    const res = await this.fetchImpl(url);
    if (!res.ok) {
      const errBody = await res.text().catch(() => "<no se pudo leer el body>");
      throw new Error(`OSRM respondió ${res.status}: ${errBody}`);
    }

    const json = (await res.json()) as OsrmResponse;
    if (json.code !== "Ok" || !json.routes || json.routes.length === 0) {
      throw new Error(`OSRM no encontró ruta (code=${json.code ?? "desconocido"}): ${json.message ?? ""}`);
    }

    const route = json.routes[0];
    if (!route || typeof route.duration !== "number" || typeof route.distance !== "number") {
      throw new Error("OSRM devolvió una ruta sin duration/distance.");
    }

    const durationSecs = Math.round(route.duration);
    return {
      provider: "osrm",
      durationSecs,
      // Ver nota de archivo: OSRM self-hosted vanilla no tiene tráfico en
      // vivo, así que "estático" y "con tráfico" son el mismo número aquí.
      staticDurationSecs: durationSecs,
      distanceMeters: Math.round(route.distance),
      polyline: null, // pedimos overview=false a propósito (no lo consumimos)
      tollInfoMxn: null, // OSRM no calcula casetas
      fetchedAt: new Date(),
      fromCache: false,
    };
  }
}
