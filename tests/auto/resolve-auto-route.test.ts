import { describe, it, expect, vi } from "vitest";
import { resolveAutoRoute } from "../../src/modes/auto/index.ts";
import type { EtaProvider, EtaResult } from "../../src/modes/auto/eta-provider.ts";

const LUNES_RESTRINGE_5_6 = new Date("2026-08-17T08:00:00-06:00");

function fakeProvider(getEta: EtaProvider["getEta"]): EtaProvider {
  return { name: "google-routes", getEta };
}

const PERFIL_BASE = {
  terminacionPlaca: 5,
  holograma: "1" as const,
  rendimientoKmPorLitro: 12,
  precioLitroMxn: 24,
  evitaCasetas: false,
};

describe("resolveAutoRoute", () => {
  it("Hoy No Circula bloquea el viaje SIN llamar al EtaProvider (blindaje: cero requests si no puede circular)", async () => {
    const getEta = vi.fn();
    const provider = fakeProvider(getEta);

    const result = await resolveAutoRoute(provider, {
      perfil: PERFIL_BASE, // terminación 5, holograma 1 -> restringido el lunes
      origin: { lat: 19.4326, lon: -99.1332 },
      destination: { lat: 19.3, lon: -99.2 },
      departureTime: LUNES_RESTRINGE_5_6,
    });

    expect(result.disponible).toBe(false);
    if (!result.disponible) {
      expect(result.motivo).toMatch(/descansa/);
      expect(result.confianza).toBe("alta");
    }
    expect(getEta).not.toHaveBeenCalled();
  });

  it("si puede circular, pide el ETA y calcula el costo con distancia y casetas del proveedor", async () => {
    const etaResult: EtaResult = {
      provider: "google-routes",
      durationSecs: 1500,
      staticDurationSecs: 1200,
      distanceMeters: 20_000,
      polyline: "poly",
      tollInfoMxn: 30,
      fetchedAt: new Date(),
      fromCache: false,
    };
    const getEta = vi.fn(async () => etaResult);
    const provider = fakeProvider(getEta);

    const result = await resolveAutoRoute(provider, {
      perfil: { ...PERFIL_BASE, terminacionPlaca: 7 }, // 7 no descansa el lunes
      origin: { lat: 19.4326, lon: -99.1332 },
      destination: { lat: 19.3, lon: -99.2 },
      departureTime: LUNES_RESTRINGE_5_6,
    });

    expect(getEta).toHaveBeenCalledTimes(1);
    expect(result.disponible).toBe(true);
    if (result.disponible) {
      expect(result.eta).toEqual(etaResult);
      // gasolina: 20km / 12 km/l * 24 = 40; casetas 30 -> total 70
      expect(result.costo.gasolinaMxn).toBeCloseTo(40, 2);
      expect(result.costo.casetasMxn).toBe(30);
      expect(result.costo.totalMxn).toBeCloseTo(70, 2);
    }
  });

  it("pasa evitaCasetas del perfil como avoidTolls al EtaRequest", async () => {
    const etaResult: EtaResult = {
      provider: "google-routes",
      durationSecs: 100,
      staticDurationSecs: 90,
      distanceMeters: 1000,
      polyline: null,
      tollInfoMxn: null,
      fetchedAt: new Date(),
      fromCache: false,
    };
    const getEta = vi.fn(async () => etaResult);
    const provider = fakeProvider(getEta);

    await resolveAutoRoute(provider, {
      perfil: { ...PERFIL_BASE, terminacionPlaca: 7, evitaCasetas: true },
      origin: { lat: 19.4326, lon: -99.1332 },
      destination: { lat: 19.3, lon: -99.2 },
      departureTime: LUNES_RESTRINGE_5_6,
    });

    expect(getEta).toHaveBeenCalledWith(
      expect.objectContaining({ avoidTolls: true })
    );
  });

  it("con contingencia activa Fase 2 sin boletín, bloquea incluso holograma 0 y devuelve confianza baja", async () => {
    const getEta = vi.fn();
    const provider = fakeProvider(getEta);

    const result = await resolveAutoRoute(provider, {
      perfil: { ...PERFIL_BASE, holograma: "0", terminacionPlaca: 7 },
      origin: { lat: 19.4326, lon: -99.1332 },
      destination: { lat: 19.3, lon: -99.2 },
      departureTime: LUNES_RESTRINGE_5_6,
      contingencia: { activa: true, fase: 2 },
    });

    expect(result.disponible).toBe(false);
    if (!result.disponible) {
      expect(result.confianza).toBe("baja");
    }
    expect(getEta).not.toHaveBeenCalled();
  });
});
