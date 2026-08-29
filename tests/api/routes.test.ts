/**
 * Pruebas de integración de la capa HTTP contra el Postgres real local
 * (puerto 5433, ver CLAUDE.md) -- no mockean Prisma ni pg. Usan
 * `app.inject()` de Fastify (no abren un puerto TCP real). Crean su
 * propia API key y su propio `user_id` de prueba en `beforeAll`/limpian
 * en `afterAll` para no ensuciar la base de desarrollo real.
 *
 * `algoritmo-ruteo` (Fase 3) ya terminó: `POST /v1/routes` corre contra el
 * motor REAL (`RealRouterEngine`, src/api/engine/real-router-engine.ts),
 * no el stub. Las pruebas usan `2025-06-16` (lunes) como fecha de
 * servicio -- la misma que usó `algoritmo-ruteo` en sus propias pruebas
 * (docs/handoff/03-algoritmo.md sección 5) -- porque `calendar` cubre
 * mayormente 2024-12-01 a 2025-12-31; una fecha de "hoy" cae fuera de esa
 * vigencia.
 *
 * Corrección 2026-08-28: una fecha sin servicio activo YA NO implica
 * `no_coverage`. Desde el entregable de bici (2026-08-22, ver
 * docs/handoff/02-grafo.md sección 9.5), las estaciones Ecobici son nodos
 * caminables del grafo (`graph_bike_station_neighbors` expone `walk` hacia
 * "paradas GTFS u otras estaciones Ecobici cercanas"), lo que densifica la
 * red peatonal lo suficiente para que, en corredores como Reforma, el
 * motor encuentre una ruta real caminando TODO el trayecto -- sin ningún
 * tramo `ride` -- dentro del horizonte de 90 min. Verificado: El Ángel ->
 * Zócalo el 2026-08-17 (0 servicios GTFS relevantes activos) encuentra un
 * itinerario de 18 tramos, todos `walk`, ~61 min, `plan_confidence:
 * "full"`. Es un resultado real y físicamente plausible (los tramos
 * intermedios por estaciones Ecobici son solo puntos de paso peatonales,
 * nunca se aborda una bici), no un bug del motor -- la vieja aserción de
 * `no_coverage` dependía de una propiedad accidental del grafo peatonal
 * más disperso de antes de esa fase, nunca fue una garantía de diseño.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.ts";
import { closePrisma, getPrisma } from "../../src/api/db/prisma.ts";
import { hashApiKey } from "../../src/api/lib/api-key.ts";
import { cdmxServiceDateAndSecsToDate } from "../../src/api/lib/cdmx-time.ts";

/** Lunes real dentro de la vigencia de `calendar` -- mismo criterio que docs/handoff/02-grafo.md y 03-algoritmo.md. */
const SERVICE_DATE = "2025-06-16";
const DEPART_AT_8AM_CDMX = cdmxServiceDateAndSecsToDate(SERVICE_DATE, 8 * 3600).toISOString();

// El Ángel / Zócalo -- mismo par que usó algoritmo-ruteo en sus propias
// pruebas (docs/handoff/03-algoritmo.md sección 5), corredor Reforma/Centro
// con Metrobús y Metro reales, encuentra ruta de verdad.
const EL_ANGEL = { lat: 19.427, lon: -99.1677 };
const ZOCALO = { lat: 19.4326, lon: -99.1332 };

let app: FastifyInstance;
let apiKey: string;
let apiKeyId: bigint;
let testUserId: string;
let realStop: { stop_id: string; stop_lat: number; stop_lon: number };
let createdTripIds: string[] = [];

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  const prisma = getPrisma();

  apiKey = `rk_test_${randomUUID()}`;
  testUserId = `test-user-${randomUUID()}`;

  const rows = await prisma.$queryRaw<Array<{ id: bigint }>>`
    INSERT INTO api_keys (key_hash, label, user_id)
    VALUES (${hashApiKey(apiKey)}, ${"vitest"}, ${testUserId})
    RETURNING id;
  `;
  apiKeyId = rows[0]!.id;

  const stopRows = await prisma.$queryRaw<
    Array<{ stop_id: string; stop_lat: number; stop_lon: number }>
  >`SELECT stop_id, stop_lat, stop_lon FROM stops LIMIT 1;`;
  realStop = stopRows[0]!;
});

afterAll(async () => {
  const prisma = getPrisma();
  await prisma.$executeRaw`DELETE FROM api_keys WHERE id = ${apiKeyId};`;
  await prisma.user_modes.deleteMany({ where: { user_id: testUserId } });
  if (createdTripIds.length > 0) {
    await prisma.$executeRaw`DELETE FROM trip_history WHERE id = ANY(${createdTripIds.map(BigInt)});`;
  }
  await app.close();
  await closePrisma();
});

describe("GET /health", () => {
  it("responde 200 sin API key y reporta la DB como ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeNull();
    expect(body.data.status).toBe("ok");
    expect(body.data.db).toBe("ok");
  });
});

describe("Auth", () => {
  it("rechaza POST /v1/routes sin X-API-Key con 401 tipado", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/routes",
      payload: {
        origin: { lat: 19.4326, lon: -99.1332 },
        destination: { lat: 19.436, lon: -99.14 },
      },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.data).toBeNull();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.meta.request_id).toBeTruthy();
  });

  it("rechaza una API key inválida con 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/routes",
      headers: { "x-api-key": "rk_esto-no-existe" },
      payload: {
        origin: { lat: 19.4326, lon: -99.1332 },
        destination: { lat: 19.436, lon: -99.14 },
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });
});

describe("POST /v1/routes (contra el motor real de algoritmo-ruteo)", () => {
  it("El Ángel -> Zócalo, 2025-06-16 08:00 CDMX: encuentra un itinerario real con Metrobús+Metro", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/routes",
      headers: { "x-api-key": apiKey },
      payload: {
        origin: EL_ANGEL,
        destination: ZOCALO,
        departure_at: DEPART_AT_8AM_CDMX,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeNull();
    expect(body.meta.engine.name).toBe("algoritmo-ruteo");
    expect(body.meta.engine.is_stub).toBe(false);
    expect(body.meta.engine.plan_confidence).toBe("full");
    expect(typeof body.meta.engine.elapsed_ms).toBe("number");

    expect(Array.isArray(body.data.routes)).toBe(true);
    expect(body.data.routes.length).toBeGreaterThan(0);

    const route = body.data.routes[0];
    expect(route.summary.transfers).toBeGreaterThanOrEqual(1); // El Ángel->Zócalo requiere al menos un transbordo real
    expect(route.legs.length).toBeGreaterThan(1);

    // Todos los modos usados son reales del GTFS de CDMX o walk -- no "ride" genérico.
    const modesUsed = new Set(route.legs.map((l: { mode: string }) => l.mode));
    for (const m of modesUsed) {
      expect(["walk", "transfer", "metro", "metrobus", "rtp", "cc", "trole", "cablebus", "pumabus", "tren_ligero", "suburbano", "interurbano", "transit"]).toContain(m);
    }

    for (const leg of route.legs) {
      expect(typeof leg.duration_s).toBe("number");
      expect(leg.duration_s).toBeGreaterThanOrEqual(0);
      expect(typeof leg.cost_mxn).toBe("number");
      expect(typeof leg.confidence).toBe("number");
      expect(leg.confidence).toBeGreaterThan(0);
      expect(leg.confidence).toBeLessThanOrEqual(1);
      expect(typeof leg.from.lat).toBe("number");
      expect(typeof leg.to.lat).toBe("number");
    }

    // Al menos un tramo cobra la tarifa plana de abordaje (metro/metrobús real).
    expect(route.summary.cost_mxn).toBeGreaterThan(0);
  });

  it("fecha fuera de la vigencia de calendar, sin servicio GTFS activo -> 200 con una ruta real a pie, nunca 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/routes",
      headers: { "x-api-key": apiKey },
      payload: {
        origin: EL_ANGEL,
        destination: ZOCALO,
        departure_at: "2026-08-17T14:00:00.000Z", // "hoy" -- fuera de la vigencia real del feed, 0 servicio GTFS relevante activo
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeNull();
    // Sin servicio GTFS ese día, el motor igual encuentra una ruta real
    // caminando (la red peatonal, densificada por las estaciones Ecobici
    // como nodos de paso -- ver comentario de módulo -- alcanza para
    // cubrir el corredor dentro del horizonte de 90 min). Es una ruta
    // válida, no un caso degradado: ningún tramo es "ride".
    expect(body.meta.engine.plan_confidence).toBe("full");
    expect(Array.isArray(body.data.routes)).toBe(true);
    expect(body.data.routes.length).toBeGreaterThan(0);
    const route = body.data.routes[0];
    for (const leg of route.legs) {
      expect(leg.mode).not.toBe("ride");
    }
    expect(route.summary.transfers).toBe(0);
    expect(route.summary.cost_mxn).toBe(0);
  });

  it("devuelve routes: [] (200, no error) para un destino geográficamente sin cobertura (fuera de CDMX)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/routes",
      headers: { "x-api-key": apiKey },
      payload: {
        origin: EL_ANGEL,
        destination: { lat: 20.6597, lon: -103.3496 }, // Guadalajara, sin stops en este GTFS
        departure_at: DEPART_AT_8AM_CDMX,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeNull();
    expect(body.data.routes).toEqual([]);
  });

  it("allowed_modes filtra itinerarios que usan un modo ride no permitido", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/routes",
      headers: { "x-api-key": apiKey },
      payload: {
        origin: EL_ANGEL,
        destination: ZOCALO,
        departure_at: DEPART_AT_8AM_CDMX,
        allowed_modes: ["auto"], // el itinerario real usa metro/metrobus -- ninguno pasa el filtro
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeNull();
    expect(body.data.routes).toEqual([]);
  });

  it("arrival_at: agrega un warning explícito en meta -- el motor no soporta 'llegar antes de X'", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/routes",
      headers: { "x-api-key": apiKey },
      payload: {
        origin: EL_ANGEL,
        destination: ZOCALO,
        arrival_at: DEPART_AT_8AM_CDMX,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.meta.warnings)).toBe(true);
    expect(body.meta.warnings[0]).toMatch(/arrival_at/);
  });

  it("rechaza un body inválido (falta destination) con 400 VALIDATION_ERROR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/routes",
      headers: { "x-api-key": apiKey },
      payload: { origin: EL_ANGEL },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rechaza mandar departure_at y arrival_at juntos", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/routes",
      headers: { "x-api-key": apiKey },
      payload: {
        origin: EL_ANGEL,
        destination: ZOCALO,
        departure_at: "2026-08-16T10:00:00-06:00",
        arrival_at: "2026-08-16T11:00:00-06:00",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/stops/near (real contra Postgres, sin stub)", () => {
  it("encuentra la parada exacta usada como centro de búsqueda con distance_m ~0", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/stops/near?lat=${realStop.stop_lat}&lon=${realStop.stop_lon}&radius_m=50`,
      headers: { "x-api-key": apiKey },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeNull();
    const found = body.data.stops.find((s: { stop_id: string }) => s.stop_id === realStop.stop_id);
    expect(found).toBeTruthy();
    expect(found.distance_m).toBeLessThan(1);
  });
});

describe("POST /v1/trips + GET/PUT /v1/modes (real contra Postgres)", () => {
  it("inserta un viaje en trip_history y devuelve id/created_at", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/trips",
      headers: { "x-api-key": apiKey },
      payload: {
        user_id: testUserId,
        origin: { lat: 19.4326, lon: -99.1332 },
        destination: { lat: 19.436, lon: -99.14 },
        actual_duration_secs: 1200,
        modes_used: ["metro", "walk"],
        user_rating: 4,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.error).toBeNull();
    expect(typeof body.data.id).toBe("string");
    createdTripIds.push(body.data.id);
  });

  it("hace roundtrip PUT -> GET de modos", async () => {
    const putRes = await app.inject({
      method: "PUT",
      url: "/v1/modes",
      headers: { "x-api-key": apiKey },
      payload: {
        user_id: testUserId,
        modes: [
          { mode: "metro", is_enabled: true },
          { mode: "auto", is_enabled: true, tiene_auto: true, terminacion_placa: 7, holograma: "00" },
        ],
      },
    });
    expect(putRes.statusCode).toBe(200);

    const getRes = await app.inject({
      method: "GET",
      url: `/v1/modes?user_id=${testUserId}`,
      headers: { "x-api-key": apiKey },
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();
    expect(body.data.modes).toHaveLength(2);
    const auto = body.data.modes.find((m: { mode: string }) => m.mode === "auto");
    expect(auto.terminacion_placa).toBe(7);
  });
});

describe("StubRouterEngine (unit, sin Postgres -- ya no es el motor default de la app, pero sigue implementando RouterEngine)", () => {
  it("sigue devolviendo {options, meta} válido tras la evolución de la interfaz para el motor real", async () => {
    const { StubRouterEngine } = await import("../../src/api/engine/stub-router-engine.ts");
    const stub = new StubRouterEngine();
    const result = await stub.computeRoutes({
      origin: { lat: 19.4326, lon: -99.1332 },
      destination: { lat: 19.436, lon: -99.14 },
      departureAt: new Date(),
      arrivalAt: null,
      isArriveBy: false,
      allowedModes: null,
      maxResults: 3,
      userId: null,
    });
    expect(result.meta).toEqual({});
    expect(result.options.length).toBeGreaterThan(0);
    expect(result.options[0]!.legs[0]!.mode).toBe("walk");
    expect(result.options[0]!.legs[0]!.confidence).toBeLessThan(0.5);
  });
});
