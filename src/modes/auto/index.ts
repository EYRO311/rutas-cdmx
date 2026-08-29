/**
 * Punto de entrada del modo AUTO. `resolveAutoRoute` es la función que
 * consumirá `algoritmo-ruteo` (Fase 3) y/o `api-http` (Fase 3): recibe el
 * perfil de auto del usuario + origen/destino/hora, aplica Hoy No Circula
 * ANTES de gastar un request de ETA (blindaje obligatorio, ver
 * hoy-no-circula.ts), y si el auto puede circular, pide el ETA (a través
 * de cache + fallback) y calcula el costo.
 *
 * Quien instale esto en producción arma el `EtaProvider` compuesto una
 * sola vez (Google + cache + fallback a OSRM) con `buildDefaultEtaProvider`
 * y lo reusa entre requests -- no reconstruir el Pool/provider en cada
 * invocación.
 */
import type { Pool } from "pg";
import { CachingEtaProvider } from "./eta-cache.ts";
import { FallbackEtaProvider } from "./fallback-provider.ts";
import { GoogleRoutesProvider } from "./google-routes-provider.ts";
import { OsrmProvider } from "./osrm-provider.ts";
import { calcularCostoAuto, type EstacionamientoInput } from "./costo.ts";
import {
  evaluarHoyNoCircula,
  type ContingenciaAmbiental,
  type Holograma,
} from "./hoy-no-circula.ts";
import type { EtaProvider, EtaRequest, EtaResult, LatLng } from "./eta-provider.ts";

export * from "./eta-provider.ts";
export * from "./eta-cache.ts";
export * from "./fallback-provider.ts";
export * from "./google-routes-provider.ts";
export * from "./osrm-provider.ts";
export * from "./costo.ts";
export * from "./hoy-no-circula.ts";

export interface DefaultEtaProviderOptions {
  googleApiKey: string;
  osrmBaseUrl: string;
  pool: Pool;
  onFallback?: (error: unknown) => void;
}

/**
 * Compone el proveedor real de producción: Google Routes como primario,
 * OSRM como fallback si Google truena, y todo envuelto en cache de
 * Postgres. Esto es lo único que el resto del sistema necesita construir
 * una vez; después solo llama `.getEta(...)`.
 */
export function buildDefaultEtaProvider(options: DefaultEtaProviderOptions): EtaProvider {
  const google = new GoogleRoutesProvider({ apiKey: options.googleApiKey });
  const osrm = new OsrmProvider({ baseUrl: options.osrmBaseUrl });
  const withFallback = new FallbackEtaProvider(google, osrm, options.onFallback);
  return new CachingEtaProvider(withFallback, options.pool);
}

export interface AutoPerfilUsuario {
  terminacionPlaca: number;
  holograma: Holograma;
  rendimientoKmPorLitro: number;
  precioLitroMxn: number;
  evitaCasetas: boolean;
  estacionamiento?: EstacionamientoInput | null;
}

export interface ResolveAutoRouteInput {
  perfil: AutoPerfilUsuario;
  origin: LatLng;
  destination: LatLng;
  /** Fecha/hora de salida planeada. Determina tanto Hoy No Circula como el tráfico proyectado. */
  departureTime: Date;
  contingencia?: ContingenciaAmbiental;
}

export type ResolveAutoRouteResult =
  | {
      disponible: false;
      motivo: string;
      confianza: "alta" | "baja";
    }
  | {
      disponible: true;
      eta: EtaResult;
      costo: ReturnType<typeof calcularCostoAuto>;
    };

/**
 * Resuelve si el modo AUTO es viable para este viaje y, si lo es, su ETA y
 * costo. Orden de operaciones deliberado:
 *   1. Hoy No Circula -- sin tocar el `EtaProvider` todavía.
 *   2. Si está restringido, se devuelve de inmediato: CERO requests de ETA
 *      (a Google o a OSRM) se disparan para un viaje que no se puede hacer.
 *   3. Si puede circular, se pide el ETA (cache primero, luego proveedor
 *      real) y se calcula el costo con el ETA resultante (para casetas).
 */
export async function resolveAutoRoute(
  provider: EtaProvider,
  input: ResolveAutoRouteInput
): Promise<ResolveAutoRouteResult> {
  const hnc = evaluarHoyNoCircula({
    terminacionPlaca: input.perfil.terminacionPlaca,
    holograma: input.perfil.holograma,
    fecha: input.departureTime,
    // exactOptionalPropertyTypes: no asignar `contingencia: undefined`
    // explícito -- o se omite la llave o se pasa el valor real.
    ...(input.contingencia !== undefined ? { contingencia: input.contingencia } : {}),
  });

  if (hnc.restringido) {
    return { disponible: false, motivo: hnc.motivo, confianza: hnc.confianza };
  }

  const request: EtaRequest = {
    origin: input.origin,
    destination: input.destination,
    departureTime: input.departureTime,
    avoidTolls: input.perfil.evitaCasetas,
  };

  const eta = await provider.getEta(request);

  const costo = calcularCostoAuto({
    distanciaMetros: eta.distanceMeters,
    rendimientoKmPorLitro: input.perfil.rendimientoKmPorLitro,
    precioLitroMxn: input.perfil.precioLitroMxn,
    casetasMxn: eta.tollInfoMxn,
    // exactOptionalPropertyTypes: normalizamos `undefined` a `null` (ambos
    // significan "no hay estimación de estacionamiento" para calcularCostoAuto).
    estacionamiento: input.perfil.estacionamiento ?? null,
  });

  return { disponible: true, eta, costo };
}
