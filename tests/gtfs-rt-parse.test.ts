import { describe, it, expect } from "vitest";
import protobuf from "protobufjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseGtfsRtFeed } from "../scripts/gtfs-rt/parse.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "..",
  "src",
  "gtfs-rt",
  "gtfs-realtime.proto"
);

/**
 * No tenemos el token de metrobus-gtfs.sinopticoplus.com (bloqueo conocido),
 * así que no hay forma de probar el parser contra el feed real. Esta prueba
 * codifica un FeedMessage sintético con el MISMO esquema oficial y lo pasa
 * por parseGtfsRtFeed para verificar que la lógica de mapeo (protobuf ->
 * objetos planos) es correcta. No prueba que el feed real de Metrobús
 * respete este esquema al pie de la letra.
 */
describe("parseGtfsRtFeed", () => {
  it("decodifica VehiclePosition y TripUpdate de un FeedMessage sintético", async () => {
    const root = await protobuf.load(PROTO_PATH);
    const FeedMessage = root.lookupType("transit_realtime.FeedMessage");

    const nowSecs = Math.floor(Date.now() / 1000);

    const payload = {
      header: {
        gtfsRealtimeVersion: "2.0",
        incrementality: 0,
        timestamp: nowSecs,
      },
      entity: [
        {
          id: "vp-1",
          vehicle: {
            trip: { tripId: "MB_TRIP_1", routeId: "MB_ROUTE_1" },
            position: { latitude: 19.4326, longitude: -99.1332, bearing: 90, speed: 8.3 },
            currentStopSequence: 4,
            vehicle: { id: "MB-0042" },
            timestamp: nowSecs,
          },
        },
        {
          id: "tu-1",
          tripUpdate: {
            trip: { tripId: "MB_TRIP_1", routeId: "MB_ROUTE_1" },
            stopTimeUpdate: [
              {
                stopSequence: 5,
                stopId: "MB_STOP_5",
                arrival: { delay: 120, time: nowSecs + 60 },
                departure: { delay: 90, time: nowSecs + 90 },
                scheduleRelationship: 0,
              },
            ],
          },
        },
      ],
    };

    const errMsg = FeedMessage.verify(payload);
    expect(errMsg).toBeNull();

    const message = FeedMessage.create(payload);
    const buffer = FeedMessage.encode(message).finish();

    const parsed = await parseGtfsRtFeed(buffer);

    expect(parsed.headerTimestamp).not.toBeNull();
    expect(parsed.vehiclePositions).toHaveLength(1);
    // lat/lon en GTFS-RT son `float` (32 bits), no `double`: el roundtrip
    // pierde precisión más allá de ~6 decimales, por diseño del formato.
    expect(parsed.vehiclePositions[0]).toMatchObject({
      vehicleId: "MB-0042",
      tripId: "MB_TRIP_1",
      routeId: "MB_ROUTE_1",
      currentStopSequence: 4,
    });
    expect(parsed.vehiclePositions[0]?.lat).toBeCloseTo(19.4326, 4);
    expect(parsed.vehiclePositions[0]?.lon).toBeCloseTo(-99.1332, 4);

    expect(parsed.tripUpdates).toHaveLength(1);
    expect(parsed.tripUpdates[0]).toMatchObject({
      tripId: "MB_TRIP_1",
      routeId: "MB_ROUTE_1",
      stopId: "MB_STOP_5",
      stopSequence: 5,
      arrivalDelaySecs: 120,
      departureDelaySecs: 90,
    });
    expect(parsed.tripUpdates[0]?.arrivalTime).not.toBeNull();
  });

  it("devuelve listas vacías para un FeedMessage sin entidades", async () => {
    const root = await protobuf.load(PROTO_PATH);
    const FeedMessage = root.lookupType("transit_realtime.FeedMessage");
    const message = FeedMessage.create({
      header: { gtfsRealtimeVersion: "2.0", incrementality: 0, timestamp: 0 },
      entity: [],
    });
    const buffer = FeedMessage.encode(message).finish();
    const parsed = await parseGtfsRtFeed(buffer);
    expect(parsed.vehiclePositions).toHaveLength(0);
    expect(parsed.tripUpdates).toHaveLength(0);
  });
});
