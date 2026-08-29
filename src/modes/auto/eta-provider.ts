/**
 * Contrato `EtaProvider`: la única forma en que el resto del sistema pide
 * un tiempo de viaje en auto. Nadie fuera de src/modes/auto/ sabe si la
 * respuesta vino de Google Routes, de OSRM o de la cache de Postgres — ese
 * es exactamente el punto (blindaje #3 de .claude/agents/modo-auto.md):
 * intercambiar de proveedor, o envolver con cache/fallback, no debe tocar
 * ni un import fuera de este módulo.
 */

export interface LatLng {
  lat: number;
  lon: number;
}

export interface EtaRequest {
  origin: LatLng;
  destination: LatLng;
  /**
   * Hora de salida planeada. Afecta el tráfico proyectado en proveedores
   * que lo soportan (Google Routes con routingPreference TRAFFIC_AWARE).
   * También es la hora que se trunca a la ventana de 15 min para la cache
   * (ver eta-cache.ts) — dos requests con distinta departureTime dentro de
   * la misma ventana comparten entrada de cache.
   */
  departureTime: Date;
  /** Si el usuario tiene evita_casetas activo (user_modes.evita_casetas). */
  avoidTolls?: boolean;
}

export type EtaProviderName = "google-routes" | "osrm";

export interface EtaResult {
  provider: EtaProviderName;
  /**
   * Duración estimada del viaje, con tráfico si el proveedor lo soporta
   * (Google Routes sí; OSRM self-hosted sin feed de tráfico en vivo, no —
   * ver osrm-provider.ts).
   */
  durationSecs: number;
  /**
   * Duración sin tráfico, si el proveedor distingue entre las dos
   * (Google Routes la trae como `staticDuration`). `null` si el proveedor
   * no la distingue (OSRM: duration YA es la única que tiene).
   */
  staticDurationSecs: number | null;
  distanceMeters: number;
  /** Polyline codificada de la ruta, si el proveedor la devuelve. */
  polyline: string | null;
  /**
   * Costo estimado de casetas en pesos mexicanos, si el proveedor lo
   * calcula (Google Routes con extraComputations TOLLS, "solo disponible
   * en ciudades seleccionadas" según su documentación — no garantizado
   * para CDMX, puede venir null aunque la ruta sí tenga casetas reales).
   * OSRM no calcula casetas: siempre null.
   */
  tollInfoMxn: number | null;
  fetchedAt: Date;
  /** true si esta respuesta vino de eta_cache en vez de un request real. */
  fromCache: boolean;
}

export interface EtaProvider {
  readonly name: EtaProviderName;
  getEta(request: EtaRequest): Promise<EtaResult>;
}
