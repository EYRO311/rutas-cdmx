import { describe, it, expect, vi } from "vitest";
import { OsrmProvider } from "../../src/modes/auto/osrm-provider.ts";

/**
 * No hay ninguna instancia de OSRM corriendo en este proyecto en esta fase
 * (ver nota completa en src/modes/auto/osrm-provider.ts). Estos tests
 * prueban la lógica de request/response contra el contrato HTTP real y
 * documentado de OSRM (http://project-osrm.org/docs/v5.24.0/api/) con
 * `fetchImpl` inyectado — nunca contra un servidor real.
 */

const FIXTURE_OSRM_OK = {
  code: "Ok",
  routes: [{ distance: 12345.6, duration: 987.3 }],
  waypoints: [],
};

function mockFetchReturning(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  ) as unknown as typeof fetch;
}

describe("OsrmProvider", () => {
  it("arma la URL con coordenadas en orden lon,lat (GeoJSON) y mapea la respuesta", async () => {
    const fetchImpl = mockFetchReturning(200, FIXTURE_OSRM_OK);
    const provider = new OsrmProvider({ baseUrl: "http://localhost:5000", fetchImpl });

    const result = await provider.getEta({
      origin: { lat: 19.4326, lon: -99.1332 },
      destination: { lat: 19.3, lon: -99.2 },
      departureTime: new Date(),
    });

    expect(result).toMatchObject({
      provider: "osrm",
      durationSecs: 987,
      staticDurationSecs: 987, // OSRM vanilla no distingue tráfico -- ver nota de archivo
      distanceMeters: 12346,
      polyline: null,
      tollInfoMxn: null,
      fromCache: false,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe(
      "http://localhost:5000/route/v1/driving/-99.1332,19.4326;-99.2,19.3?overview=false&alternatives=false&steps=false"
    );
  });

  it("truena con mensaje claro si OSRM responde code distinto de 'Ok' (p.ej. NoRoute)", async () => {
    const fetchImpl = mockFetchReturning(200, { code: "NoRoute", message: "Impossible route" });
    const provider = new OsrmProvider({ baseUrl: "http://localhost:5000", fetchImpl });

    await expect(
      provider.getEta({
        origin: { lat: 19.0, lon: -99.0 },
        destination: { lat: 19.01, lon: -99.01 },
        departureTime: new Date(),
      })
    ).rejects.toThrow(/OSRM no encontró ruta/);
  });

  it("propaga un error legible en 4xx/5xx del servidor OSRM", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("internal error", { status: 500 })
    ) as unknown as typeof fetch;
    const provider = new OsrmProvider({ baseUrl: "http://localhost:5000", fetchImpl });

    await expect(
      provider.getEta({
        origin: { lat: 19.0, lon: -99.0 },
        destination: { lat: 19.01, lon: -99.01 },
        departureTime: new Date(),
      })
    ).rejects.toThrow(/OSRM respondió 500/);
  });

  it("respeta un profile custom si se pasa", async () => {
    const fetchImpl = mockFetchReturning(200, FIXTURE_OSRM_OK);
    const provider = new OsrmProvider({ baseUrl: "http://localhost:5000", profile: "car", fetchImpl });

    await provider.getEta({
      origin: { lat: 19.0, lon: -99.0 },
      destination: { lat: 19.01, lon: -99.01 },
      departureTime: new Date(),
    });

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("/route/v1/car/");
  });
});
