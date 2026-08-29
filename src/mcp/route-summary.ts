/**
 * Compacta la respuesta cruda de `POST /v1/routes` a texto legible. Regla
 * dura del brief: "una ruta completa cabe en menos de 500 tokens...
 * Resume tramos, no vuelques el grafo."
 *
 * El motor real expande tramos por SALTO del grafo, no por
 * abordaje/viaje completo -- la evidencia real en docs/handoff/05-api.md
 * sección 9.3 lo documenta tal cual: un solo viaje en Metrobús aparece
 * como "metrobus×6" (6 legs consecutivos, un salto GTFS a la vez), no
 * como un tramo. Volcar eso leg por leg en una respuesta de MCP
 * reventaría el presupuesto de tokens en cualquier viaje real con más de
 * un par de paradas -- así que esta capa colapsa corridas consecutivas de
 * legs con el mismo `mode` + `route_id` en un solo "tramo" antes de
 * formatear texto.
 */
import { modeLabel, formatDuration, formatMoney, describeConfidence, formatClockCdmx } from "./format.js";

export interface ApiStopRef {
  stop_id: string | null;
  name: string | null;
  lat: number;
  lon: number;
}

export interface ApiRouteLeg {
  mode: string;
  duration_s: number;
  cost_mxn: number;
  confidence: number;
  from: ApiStopRef;
  to: ApiStopRef;
  route_id?: string | null;
  trip_id?: string | null;
  departure_at?: string | null;
  arrival_at?: string | null;
}

export interface ApiRouteOption {
  id: string;
  summary: {
    duration_s: number;
    cost_mxn: number;
    confidence: number;
    transfers: number;
    distance_m?: number | null;
  };
  legs: ApiRouteLeg[];
}

interface Segment {
  mode: string;
  routeId: string | null;
  from: ApiStopRef;
  to: ApiStopRef;
  durationS: number;
  costMxn: number;
  confidence: number;
  departureAt: string | null;
  arrivalAt: string | null;
}

function stopLabel(ref: ApiStopRef): string {
  return ref.name ?? (ref.stop_id ? `parada ${ref.stop_id}` : `(${ref.lat.toFixed(4)}, ${ref.lon.toFixed(4)})`);
}

function collapseLegs(legs: ApiRouteLeg[]): Segment[] {
  const segments: Segment[] = [];
  for (const leg of legs) {
    const last = segments.at(-1);
    const sameRun = last && last.mode === leg.mode && (last.routeId ?? null) === (leg.route_id ?? null);
    if (sameRun && last) {
      last.to = leg.to;
      last.durationS += leg.duration_s;
      last.costMxn += leg.cost_mxn;
      last.confidence = Math.min(last.confidence, leg.confidence);
      last.arrivalAt = leg.arrival_at ?? last.arrivalAt;
    } else {
      segments.push({
        mode: leg.mode,
        routeId: leg.route_id ?? null,
        from: leg.from,
        to: leg.to,
        durationS: leg.duration_s,
        costMxn: leg.cost_mxn,
        confidence: leg.confidence,
        departureAt: leg.departure_at ?? null,
        arrivalAt: leg.arrival_at ?? null,
      });
    }
  }
  return segments;
}

/** Línea de texto compacta por tramo, ej: "2. Metrobús Línea 4: Buenavista -> Hospital General, 14 min". */
function renderSegment(seg: Segment, index: number): string {
  const label = modeLabel(seg.mode);
  const dur = formatDuration(seg.durationS);
  if (seg.mode === "walk" || seg.mode === "transfer") {
    return `${index}. Camina ${dur} (${stopLabel(seg.from)} -> ${stopLabel(seg.to)})`;
  }
  return `${index}. ${label}: ${stopLabel(seg.from)} -> ${stopLabel(seg.to)}, ${dur}`;
}

export function renderRouteOption(option: ApiRouteOption, index: number): string {
  const s = option.summary;
  const conf = describeConfidence(s.confidence);
  const segments = collapseLegs(option.legs);

  const header =
    `Ruta ${index}: ${formatDuration(s.duration_s)}, ${s.transfers === 0 ? "sin transbordos" : s.transfers === 1 ? "1 transbordo" : `${s.transfers} transbordos`}, ` +
    `${formatMoney(s.cost_mxn)}, confianza ${conf.label}` +
    (conf.shouldWarn ? " -- OJO, dato poco confiable, adviértele al usuario" : "");

  const lines = segments.map((seg, i) => renderSegment(seg, i + 1));

  const firstDep = segments.find((s2) => s2.departureAt)?.departureAt;
  const timeLine = firstDep ? `Sale ${formatClockCdmx(firstDep)} hora CDMX.` : null;

  return [header, ...(timeLine ? [timeLine] : []), ...lines].join("\n");
}
