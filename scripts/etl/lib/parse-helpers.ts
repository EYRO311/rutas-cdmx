export function nullable(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function toInt(value: string | undefined): number | null {
  const v = nullable(value);
  if (v === null) return null;
  // Algunos campos numéricos vienen como "1.0" en vez de "1" en esta fuente
  // (visto en trips.direction_id y frequencies.exact_times). Se truncan.
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.trunc(n);
}

export function toFloat(value: string | undefined): number | null {
  const v = nullable(value);
  if (v === null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export function toBool(value: string | undefined): boolean | null {
  const v = nullable(value);
  if (v === null) return null;
  return v === "1";
}

/** "20260101" -> "2026-01-01" para que Postgres lo castee a DATE sin ambigüedad. */
export function gtfsDateToIso(value: string | undefined): string | null {
  const v = nullable(value);
  if (v === null) return null;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (!match) return null;
  const [, y, m, d] = match;
  return `${y}-${m}-${d}`;
}
