/**
 * Convierte un horario GTFS "HH:MM:SS" a segundos desde medianoche del día
 * de servicio. GTFS permite HH >= 24 para servicio que cruza medianoche
 * (confirmado en esta fuente: frequencies.txt trae "24:00:00" y "29:00:00"),
 * por eso NO se puede usar el tipo TIME de Postgres tal cual.
 *
 * Devuelve null si el valor viene vacío o no matchea el formato — nunca
 * inventa un valor. El caller decide si eso es un hueco a documentar.
 */
export function gtfsTimeToSeconds(value: string | undefined | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}
