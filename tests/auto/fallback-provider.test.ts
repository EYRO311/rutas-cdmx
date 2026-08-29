import { describe, it, expect, vi } from "vitest";
import { FallbackEtaProvider } from "../../src/modes/auto/fallback-provider.ts";
import type { EtaProvider, EtaResult } from "../../src/modes/auto/eta-provider.ts";

function fakeProvider(name: "google-routes" | "osrm", impl: () => Promise<EtaResult>): EtaProvider {
  return { name, getEta: impl };
}

const BASE_RESULT: EtaResult = {
  provider: "google-routes",
  durationSecs: 100,
  staticDurationSecs: 90,
  distanceMeters: 1000,
  polyline: null,
  tollInfoMxn: null,
  fetchedAt: new Date(),
  fromCache: false,
};

const REQUEST = {
  origin: { lat: 19.0, lon: -99.0 },
  destination: { lat: 19.01, lon: -99.01 },
  departureTime: new Date(),
};

describe("FallbackEtaProvider", () => {
  it("usa el primario si responde bien, sin tocar el fallback", async () => {
    const primaryGetEta = vi.fn(async () => BASE_RESULT);
    const fallbackGetEta = vi.fn(async () => ({ ...BASE_RESULT, provider: "osrm" as const }));
    const provider = new FallbackEtaProvider(
      fakeProvider("google-routes", primaryGetEta),
      fakeProvider("osrm", fallbackGetEta)
    );

    const result = await provider.getEta(REQUEST);

    expect(result.provider).toBe("google-routes");
    expect(primaryGetEta).toHaveBeenCalledTimes(1);
    expect(fallbackGetEta).not.toHaveBeenCalled();
    expect(provider.name).toBe("google-routes");
  });

  it("cae al fallback si el primario truena, y notifica vía onFallback", async () => {
    const primaryError = new Error("Google Routes no disponible");
    const primaryGetEta = vi.fn(async () => {
      throw primaryError;
    });
    const fallbackGetEta = vi.fn(async () => ({ ...BASE_RESULT, provider: "osrm" as const }));
    const onFallback = vi.fn();

    const provider = new FallbackEtaProvider(
      fakeProvider("google-routes", primaryGetEta),
      fakeProvider("osrm", fallbackGetEta),
      onFallback
    );

    const result = await provider.getEta(REQUEST);

    expect(result.provider).toBe("osrm");
    expect(fallbackGetEta).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(primaryError);
  });

  it("si ambos truenan, propaga el error del fallback", async () => {
    const primaryGetEta = vi.fn(async () => {
      throw new Error("primario caído");
    });
    const fallbackError = new Error("fallback también caído");
    const fallbackGetEta = vi.fn(async () => {
      throw fallbackError;
    });

    const provider = new FallbackEtaProvider(
      fakeProvider("google-routes", primaryGetEta),
      fakeProvider("osrm", fallbackGetEta)
    );

    await expect(provider.getEta(REQUEST)).rejects.toThrow("fallback también caído");
  });
});
