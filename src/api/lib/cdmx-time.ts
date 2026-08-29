/**
 * Conversión entre `Date` (instante UTC, lo que maneja la capa HTTP) y el
 * par `(serviceDate, secondsSinceMidnight)` que espera `PlanRequest` de
 * `algoritmo-ruteo` (docs/handoff/03-algoritmo.md sección 9): "fecha de
 * SERVICIO, no incluye hora" + "segundos desde medianoche". Esos dos
 * campos son inherentemente hora LOCAL de Ciudad de México, no UTC -- el
 * GTFS/`calendar` de este proyecto está en huso horario de CDMX, y
 * `graph_stop_neighbors` (docs/handoff/02-grafo.md sección 3.5) espera
 * `p_from_secs` en esos términos.
 *
 * Usa `Intl.DateTimeFormat` con `timeZone: "America/Mexico_City"` en vez
 * de un offset fijo hardcodeado (`-06:00`): México abolió el horario de
 * verano en la mayor parte del país desde 2022, así que hoy el offset SÍ
 * es fijo, pero apoyarse en la base de datos de zonas horarias de ICU
 * (que Node ya trae) es correcto también para fechas históricas dentro de
 * la vigencia real del `calendar` de este proyecto (~2024-12-01 a
 * ~2025-12-31, ver docs/handoff/02-grafo.md sección 5) sin tener que
 * asumir a ciegas que el offset nunca cambió en ese rango -- se calcula
 * en runtime, no se asume.
 */

const CDMX_TIME_ZONE = "America/Mexico_City";
const SECS_PER_DAY = 86_400;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Convierte un instante UTC (`Date`) a `{ serviceDate, secs }` en hora
 * local de CDMX. `secs` siempre está en `[0, 86400)` -- si el instante
 * cae después de medianoche local, ya viene reflejado en `serviceDate`
 * (no hay overflow de "25:30:00" en esta dirección).
 */
export function dateToCdmxServiceDateAndSecs(date: Date): { serviceDate: string; secs: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: CDMX_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const year = Number(parts["year"]);
  const month = Number(parts["month"]);
  const day = Number(parts["day"]);
  // Intl con hour12:false representa medianoche como "24", no "00" -- normalizar.
  const hour = Number(parts["hour"]) % 24;
  const minute = Number(parts["minute"]);
  const second = Number(parts["second"]);

  return {
    serviceDate: `${pad(year, 4)}-${pad(month)}-${pad(day)}`,
    secs: hour * 3600 + minute * 60 + second,
  };
}

/**
 * Inversa de `dateToCdmxServiceDateAndSecs`: dado un `serviceDate`
 * (YYYY-MM-DD) y segundos desde medianoche LOCAL de CDMX (puede ser
 * >= 86400 -- GTFS permite horarios "25:30:00" para servicio que cruza
 * medianoche, y `graph_ride_departures`/`trip_hops` pueden producir
 * `arrive_secs` así), devuelve el instante UTC real.
 *
 * Técnica estándar sin librería de zonas horarias: se arma un `Date`
 * tratando los componentes locales COMO SI fueran UTC (`asIfUtc`), se
 * formatea ese instante en la zona de CDMX para ver qué offset implica, y
 * se corrige una vez. Con un offset fijo (post-2022) esto converge exacto
 * en una sola pasada -- no hace falta iterar.
 */
export function cdmxServiceDateAndSecsToDate(serviceDate: string, secs: number): Date {
  const [yStr, mStr, dStr] = serviceDate.split("-");
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);

  const extraDays = Math.floor(secs / SECS_PER_DAY);
  const secsInDay = ((secs % SECS_PER_DAY) + SECS_PER_DAY) % SECS_PER_DAY;
  const hour = Math.floor(secsInDay / 3600);
  const minute = Math.floor((secsInDay % 3600) / 60);
  const second = secsInDay % 60;

  const asIfUtcMs = Date.UTC(year, month - 1, day + extraDays, hour, minute, second);

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: CDMX_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(asIfUtcMs)).map((p) => [p.type, p.value]));
  const displayedAsUtcMs = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]) % 24,
    Number(parts["minute"]),
    Number(parts["second"])
  );

  const offsetMs = displayedAsUtcMs - asIfUtcMs;
  return new Date(asIfUtcMs - offsetMs);
}
