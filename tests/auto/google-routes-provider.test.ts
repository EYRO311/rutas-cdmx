import { describe, it, expect, vi } from "vitest";
import {
  GoogleRoutesProvider,
  parseGoogleDurationSecs,
  extractTollMxn,
} from "../../src/modes/auto/google-routes-provider.ts";

/**
 * RESTRICCIÓN DURA DE ESTA FASE: ningún test de este archivo hace un
 * request real contra routes.googleapis.com. GOOGLE_ROUTES_API_KEY está
 * vacía en .env a propósito (el cap de facturación de Google Cloud no
 * está configurado todavía) y el orquestador prohibió gastar un solo
 * request real hasta que lo confirme. `fetchImpl` se inyecta con un mock
 * de vitest que devuelve un fixture con la forma real y documentada de la
 * respuesta de computeRoutes (verificada vía WebFetch a
 * developers.google.com/maps/documentation/routes el 2026-08-16) —
 * incluyendo el shape de Money (`estimatedPrice`) para tollInfo, que
 * también se confirmó contra la documentación pública
 * (TollInfo / RouteTravelAdvisory reference).
 */

// Fixture grabado a mano con la forma documentada de computeRoutes,
// incluyendo travelAdvisory.tollInfo — no es una respuesta real capturada
// de un request (no se hizo ninguno), es un ejemplo realista construido a
// partir del schema documentado.
const FIXTURE_RESPONSE_CON_CASETA = {
  routes: [
    {
      duration: "1620s",
      staticDuration: "1380s",
      distanceMeters: 18500,
      polyline: { encodedPolyline: "ipkcFfichVnP@j@BLoFVwM{E?" },
      travelAdvisory: {
        tollInfo: {
          estimatedPrice: [{ currencyCode: "MXN", units: "62", nanos: 500000000 }],
        },
      },
    },
  ],
};

const FIXTURE_RESPONSE_SIN_CASETA = {
  routes: [
    {
      duration: "600s",
      staticDuration: "540s",
      distanceMeters: 4200,
      polyline: { encodedPolyline: "abc123" },
    },
  ],
};

function mockFetchReturning(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  ) as unknown as typeof fetch;
}

describe("parseGoogleDurationSecs", () => {
  it("parsea el formato 'Ns' de protobuf Duration", () => {
    expect(parseGoogleDurationSecs("165s")).toBe(165);
    expect(parseGoogleDurationSecs("1620s")).toBe(1620);
  });

  it("devuelve null si no hay duración", () => {
    expect(parseGoogleDurationSecs(undefined)).toBeNull();
  });

  it("truena con un formato inesperado en vez de fallar en silencio", () => {
    expect(() => parseGoogleDurationSecs("no-es-una-duracion")).toThrow(/Formato de duración inesperado/);
  });
});

describe("extractTollMxn", () => {
  it("combina units + nanos/1e9 del tipo Money", () => {
    expect(
      extractTollMxn({ estimatedPrice: [{ currencyCode: "MXN", units: "62", nanos: 500000000 }] })
    ).toBeCloseTo(62.5, 6);
  });

  it("devuelve null si no hay tollInfo (ruta sin casetas)", () => {
    expect(extractTollMxn(undefined)).toBeNull();
  });

  it("prioriza MXN si hay varias monedas en estimatedPrice", () => {
    expect(
      extractTollMxn({
        estimatedPrice: [
          { currencyCode: "USD", units: "3", nanos: 0 },
          { currencyCode: "MXN", units: "55", nanos: 0 },
        ],
      })
    ).toBe(55);
  });
});

describe("GoogleRoutesProvider", () => {
  it("truena con un mensaje claro si no hay API key, sin intentar el request", async () => {
    const fetchImpl = vi.fn();
    const provider = new GoogleRoutesProvider({ apiKey: "", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      provider.getEta({
        origin: { lat: 19.4326, lon: -99.1332 },
        destination: { lat: 19.3, lon: -99.2 },
        departureTime: new Date(),
      })
    ).rejects.toThrow(/GOOGLE_ROUTES_API_KEY no está configurada/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("mapea una respuesta con casetas a EtaResult, usando el field mask y headers correctos", async () => {
    const fetchImpl = mockFetchReturning(200, FIXTURE_RESPONSE_CON_CASETA);
    const provider = new GoogleRoutesProvider({ apiKey: "fake-key-de-prueba", fetchImpl });

    const departureTime = new Date("2026-08-17T08:00:00-06:00");
    const result = await provider.getEta({
      origin: { lat: 19.4326, lon: -99.1332 },
      destination: { lat: 19.3, lon: -99.2 },
      departureTime,
      avoidTolls: false,
    });

    expect(result).toMatchObject({
      provider: "google-routes",
      durationSecs: 1620,
      staticDurationSecs: 1380,
      distanceMeters: 18500,
      polyline: "ipkcFfichVnP@j@BLoFVwM{E?",
      tollInfoMxn: 62.5,
      fromCache: false,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://routes.googleapis.com/directions/v2:computeRoutes");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("fake-key-de-prueba");
    expect(headers["X-Goog-FieldMask"]).toContain("routes.travelAdvisory.tollInfo");

    const body = JSON.parse(init.body as string);
    expect(body.travelMode).toBe("DRIVE");
    expect(body.routingPreference).toBe("TRAFFIC_AWARE");
    expect(body.extraComputations).toEqual(["TOLLS"]);
    expect(body.origin.location.latLng.latitude).toBe(19.4326);
    expect(body.departureTime).toBe(departureTime.toISOString());
  });

  it("mapea una respuesta sin casetas: tollInfoMxn queda null", async () => {
    const fetchImpl = mockFetchReturning(200, FIXTURE_RESPONSE_SIN_CASETA);
    const provider = new GoogleRoutesProvider({ apiKey: "fake-key", fetchImpl });

    const result = await provider.getEta({
      origin: { lat: 19.0, lon: -99.0 },
      destination: { lat: 19.01, lon: -99.01 },
      departureTime: new Date(),
    });

    expect(result.tollInfoMxn).toBeNull();
    expect(result.durationSecs).toBe(600);
    expect(result.staticDurationSecs).toBe(540);
  });

  it("propaga un error legible si Google responde 4xx/5xx", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("PERMISSION_DENIED: API key invalid", { status: 403 })
    ) as unknown as typeof fetch;
    const provider = new GoogleRoutesProvider({ apiKey: "fake-key", fetchImpl });

    await expect(
      provider.getEta({
        origin: { lat: 19.0, lon: -99.0 },
        destination: { lat: 19.01, lon: -99.01 },
        departureTime: new Date(),
      })
    ).rejects.toThrow(/Google Routes API respondió 403/);
  });

  it("truena si la respuesta no trae ninguna ruta", async () => {
    const fetchImpl = mockFetchReturning(200, { routes: [] });
    const provider = new GoogleRoutesProvider({ apiKey: "fake-key", fetchImpl });

    await expect(
      provider.getEta({
        origin: { lat: 19.0, lon: -99.0 },
        destination: { lat: 19.01, lon: -99.01 },
        departureTime: new Date(),
      })
    ).rejects.toThrow(/no devolvió ninguna ruta/);
  });
});
