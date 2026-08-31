/**
 * Parser de GTFS-RT (Protocol Buffers) para el feed de Metrobús.
 *
 * Usa el .proto oficial de la spec GTFS-Realtime (src/gtfs-rt/gtfs-realtime.proto,
 * bajado tal cual de https://github.com/google/transit — no reescrito a mano,
 * para no introducir errores de esquema) cargado dinámicamente con protobufjs.
 *
 * IMPORTANTE — estado de verificación: este parser se probó primero con un
 * FeedMessage sintético (ver tests/gtfs-rt-parse.test.ts), codificado y
 * decodificado con el mismo esquema (roundtrip correcto), y DESDE 2026-08-31
 * también contra el feed real de Metrobús (vía `auth.ts` + `fetch-and-store.ts`,
 * ver docs/handoff/01-datos.md sección 8): decodifica sin errores un feed real
 * de 845 `VehiclePosition` y 0 `TripUpdate`. El feed real solo ejercita el
 * bloque `vehicle` de la spec -- el bloque `tripUpdate`/`stopTimeUpdate` sigue
 * sin verificarse contra datos reales porque el feed de Metrobús no trae
 * ninguna entidad de ese tipo en las corridas de prueba hechas hasta ahora
 * (puede que Metrobús simplemente no publique trip updates, no es un bug de
 * este parser -- ver hallazgo en el handoff).
 */
import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(__dirname, "..", "..", "src", "gtfs-rt", "gtfs-realtime.proto");

let feedMessageType: protobuf.Type | undefined;

async function getFeedMessageType(): Promise<protobuf.Type> {
  if (!feedMessageType) {
    const root = await protobuf.load(PROTO_PATH);
    feedMessageType = root.lookupType("transit_realtime.FeedMessage");
  }
  return feedMessageType;
}

export interface ParsedVehiclePosition {
  vehicleId: string | null;
  tripId: string | null;
  routeId: string | null;
  lat: number | null;
  lon: number | null;
  bearing: number | null;
  speed: number | null;
  currentStopSequence: number | null;
  timestamp: Date | null;
}

export interface ParsedStopTimeUpdate {
  tripId: string | null;
  routeId: string | null;
  stopId: string | null;
  stopSequence: number | null;
  arrivalDelaySecs: number | null;
  arrivalTime: Date | null;
  departureDelaySecs: number | null;
  departureTime: Date | null;
  scheduleRelationship: string | null;
}

export interface ParsedFeed {
  headerTimestamp: Date | null;
  vehiclePositions: ParsedVehiclePosition[];
  tripUpdates: ParsedStopTimeUpdate[];
}

function tsToDate(ts: unknown): Date | null {
  if (ts === null || ts === undefined) return null;
  // protobufjs decodifica int64 como Long (objeto) salvo que se pida number;
  // aquí normalizamos a number vía String() -> Number() para evitar perder
  // precisión en la conversión directa de un Long grande.
  const n = Number(String(ts));
  if (Number.isNaN(n) || n === 0) return null;
  return new Date(n * 1000);
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v));
  return Number.isNaN(n) ? null : n;
}

/** Decodifica bytes crudos de un feed GTFS-RT (protobuf) a objetos planos. */
export async function parseGtfsRtFeed(buffer: Uint8Array): Promise<ParsedFeed> {
  const FeedMessage = await getFeedMessageType();
  const message = FeedMessage.decode(buffer);
  const obj = FeedMessage.toObject(message, {
    longs: String,
    enums: String,
    defaults: false,
  }) as any;

  const vehiclePositions: ParsedVehiclePosition[] = [];
  const tripUpdates: ParsedStopTimeUpdate[] = [];

  for (const entity of obj.entity ?? []) {
    if (entity.vehicle) {
      const v = entity.vehicle;
      vehiclePositions.push({
        vehicleId: v.vehicle?.id ?? null,
        tripId: v.trip?.tripId ?? null,
        routeId: v.trip?.routeId ?? null,
        lat: v.position?.latitude ?? null,
        lon: v.position?.longitude ?? null,
        bearing: v.position?.bearing ?? null,
        speed: v.position?.speed ?? null,
        currentStopSequence: toNum(v.currentStopSequence),
        timestamp: tsToDate(v.timestamp),
      });
    }
    if (entity.tripUpdate) {
      const tu = entity.tripUpdate;
      for (const stu of tu.stopTimeUpdate ?? []) {
        tripUpdates.push({
          tripId: tu.trip?.tripId ?? null,
          routeId: tu.trip?.routeId ?? null,
          stopId: stu.stopId ?? null,
          stopSequence: toNum(stu.stopSequence),
          arrivalDelaySecs: toNum(stu.arrival?.delay),
          arrivalTime: tsToDate(stu.arrival?.time),
          departureDelaySecs: toNum(stu.departure?.delay),
          departureTime: tsToDate(stu.departure?.time),
          scheduleRelationship: stu.scheduleRelationship ?? null,
        });
      }
    }
  }

  return {
    headerTimestamp: tsToDate(obj.header?.timestamp),
    vehiclePositions,
    tripUpdates,
  };
}
