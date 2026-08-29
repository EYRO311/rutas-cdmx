/**
 * Proveedor de ETA por default: Google Routes API (computeRoutes), SKU Pro
 * porque usa `routingPreference: TRAFFIC_AWARE` (mismo modelo de tráfico
 * que Waze — decisión de arquitectura, ver .claude/agents/modo-auto.md).
 *
 * RESTRICCIÓN DURA DE ESTA FASE: este archivo se implementó contra la
 * forma real y pública de la API (verificada vía WebFetch a
 * developers.google.com/maps/documentation/routes el 2026-08-16, sin
 * necesidad de API key), pero NUNCA se invocó contra el endpoint real.
 * `GOOGLE_ROUTES_API_KEY` está vacía en `.env` a propósito — el cap de
 * facturación en Google Cloud todavía no está configurado (blindaje #1 de
 * .claude/agents/modo-auto.md, bloqueo abierto en PLAN.md). Todas las
 * pruebas de este proveedor (tests/auto/google-routes-provider.test.ts)
 * inyectan un `fetchImpl` que devuelve fixtures HTTP grabados a mano con
 * la forma real documentada — no hay ni un solo request de red en esas
 * pruebas. Si en producción esta clase intenta llamar al endpoint real sin
 * key configurada, debe fallar con el error de abajo — eso es
 * comportamiento esperado, no un bug a "arreglar" poniendo una key.
 */
import type { EtaProvider, EtaRequest, EtaResult } from "./eta-provider.ts";

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

// Solo pedimos los campos que consumimos: Google Routes cobra el mismo SKU
// sin importar el field mask, pero un field mask angosto reduce payload y
// dificulta que un futuro cambio use un campo no revisado por este agente.
const FIELD_MASK = [
  "routes.duration",
  "routes.staticDuration",
  "routes.distanceMeters",
  "routes.polyline.encodedPolyline",
  "routes.travelAdvisory.tollInfo",
].join(",");

interface GoogleMoney {
  currencyCode?: string;
  units?: string;
  nanos?: number;
}

interface GoogleTollInfo {
  estimatedPrice?: GoogleMoney[];
}

interface GoogleRoute {
  duration?: string; // formato "165s"
  staticDuration?: string;
  distanceMeters?: number;
  polyline?: { encodedPolyline?: string };
  travelAdvisory?: { tollInfo?: GoogleTollInfo };
}

interface GoogleComputeRoutesResponse {
  routes?: GoogleRoute[];
}

/** Google Routes devuelve duraciones como string "165s" (protobuf Duration). */
export function parseGoogleDurationSecs(duration: string | undefined): number | null {
  if (!duration) return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(duration.trim());
  if (!match) {
    throw new Error(`Formato de duración inesperado de Google Routes: "${duration}"`);
  }
  return Math.round(Number(match[1]));
}

/**
 * `Money` (google.type.Money): units + nanos son enteros que se combinan
 * como `units + nanos / 1e9`. `units` llega como string porque puede
 * exceder Number.MAX_SAFE_INTEGER en otras APIs de Google (aquí nunca en
 * la práctica, pero seguimos el tipo tal como lo documenta Google).
 * Si hay varias monedas en `estimatedPrice`, se prioriza MXN explícito;
 * si no hay MXN, se usa la primera entrada (mejor una estimación en la
 * moneda que sea a asumir 0 casetas cuando sí las hay).
 */
export function extractTollMxn(tollInfo: GoogleTollInfo | undefined): number | null {
  const prices = tollInfo?.estimatedPrice;
  if (!prices || prices.length === 0) return null;
  const mxn = prices.find((p) => p.currencyCode === "MXN") ?? prices[0];
  if (!mxn) return null;
  const units = Number(mxn.units ?? "0");
  const nanos = mxn.nanos ?? 0;
  return units + nanos / 1e9;
}

export interface GoogleRoutesProviderOptions {
  apiKey: string;
  /** Inyectable para tests — nunca se usa `fetch` global en pruebas. */
  fetchImpl?: typeof fetch;
}

export class GoogleRoutesProvider implements EtaProvider {
  readonly name = "google-routes" as const;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleRoutesProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getEta(request: EtaRequest): Promise<EtaResult> {
    if (!this.apiKey) {
      throw new Error(
        "GOOGLE_ROUTES_API_KEY no está configurada. Esto es esperado en esta " +
          "fase: el cap de facturación en Google Cloud todavía no está puesto " +
          "(ver PLAN.md). No se debe configurar una key ni hacer requests " +
          "reales hasta que el orquestador lo confirme explícitamente."
      );
    }

    const body = {
      origin: {
        location: {
          latLng: { latitude: request.origin.lat, longitude: request.origin.lon },
        },
      },
      destination: {
        location: {
          latLng: {
            latitude: request.destination.lat,
            longitude: request.destination.lon,
          },
        },
      },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      departureTime: request.departureTime.toISOString(),
      computeAlternativeRoutes: false,
      routeModifiers: { avoidTolls: request.avoidTolls ?? false },
      extraComputations: ["TOLLS"],
      units: "METRIC",
    };

    const res = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "<no se pudo leer el body>");
      throw new Error(`Google Routes API respondió ${res.status}: ${errBody}`);
    }

    const json = (await res.json()) as GoogleComputeRoutesResponse;
    const route = json.routes?.[0];
    if (!route) {
      throw new Error(
        "Google Routes API no devolvió ninguna ruta (routes vacío o ausente)."
      );
    }

    const durationSecs = parseGoogleDurationSecs(route.duration);
    if (durationSecs === null) {
      throw new Error("Google Routes API no devolvió `duration` en la ruta.");
    }
    if (typeof route.distanceMeters !== "number") {
      throw new Error("Google Routes API no devolvió `distanceMeters` en la ruta.");
    }

    return {
      provider: "google-routes",
      durationSecs,
      staticDurationSecs: parseGoogleDurationSecs(route.staticDuration),
      distanceMeters: route.distanceMeters,
      polyline: route.polyline?.encodedPolyline ?? null,
      tollInfoMxn: extractTollMxn(route.travelAdvisory?.tollInfo),
      fetchedAt: new Date(),
      fromCache: false,
    };
  }
}
