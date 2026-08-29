/**
 * Formato en lenguaje natural, compacto, en español de CDMX. Regla dura
 * del brief (.claude/agents/mcp-asistente.md): "los tiempos van en
 * lenguaje natural ('32 min, 1 transbordo'), no en segundos crudos" y
 * "una ruta completa cabe en menos de 500 tokens de respuesta". Nada de
 * lo que devuelve una herramienta de este servidor es JSON crudo del
 * envelope de la API -- todo pasa por aquí primero.
 */

const MODE_LABELS: Record<string, string> = {
  metro: "Metro",
  metrobus: "Metrobús",
  rtp: "RTP",
  cc: "Corredor Concesionado",
  trole: "Trolebús",
  cablebus: "Cablebús",
  pumabus: "Pumabús",
  tren_ligero: "Tren Ligero",
  suburbano: "Suburbano",
  interurbano: "Interurbano",
  ecobici: "Ecobici",
  walk: "caminando",
  auto: "auto",
  transfer: "transbordo a pie",
  transit: "transporte (agencia no identificada en los datos)",
};

export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

export function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return "menos de 1 min";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatTransfers(n: number): string {
  if (n <= 0) return "sin transbordos";
  if (n === 1) return "1 transbordo";
  return `${n} transbordos`;
}

export function formatMoney(mxn: number): string {
  if (mxn <= 0) return "gratis";
  const rounded = Math.round(mxn * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded} MXN` : `$${rounded.toFixed(2)} MXN`;
}

export function formatDistance(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined) return null;
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Etiqueta cualitativa + si vale la pena advertir al usuario explícitamente (regla dura del brief). */
export function describeConfidence(value: number): { label: "alta" | "media" | "baja"; shouldWarn: boolean } {
  if (value >= 0.8) return { label: "alta", shouldWarn: false };
  if (value >= 0.5) return { label: "media", shouldWarn: false };
  return { label: "baja", shouldWarn: true };
}

export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin <= 0) return "justo ahora";
  if (diffMin === 1) return "hace 1 min";
  if (diffMin < 60) return `hace ${diffMin} min`;
  const h = Math.floor(diffMin / 60);
  return h === 1 ? "hace 1 h" : `hace ${h} h`;
}

/** Hora local CDMX legible ("08:00", "lun 16 jun 08:00") a partir de un ISO string / Date. */
export function formatClockCdmx(dateIso: string | Date, includeDate = false): string {
  const d = typeof dateIso === "string" ? new Date(dateIso) : dateIso;
  const opts: Intl.DateTimeFormatOptions = includeDate
    ? { timeZone: "America/Mexico_City", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }
    : { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit", hour12: false };
  return new Intl.DateTimeFormat("es-MX", opts).format(d);
}
