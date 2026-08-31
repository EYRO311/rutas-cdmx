/**
 * Login contra la API de Sonda (proveedor real de metrobus-gtfs.sinopticoplus.com)
 * para obtener las URLs firmadas (S3, tipo presigned URL) del feed GTFS-RT y
 * del GTFS estático de Metrobús.
 *
 * Flujo confirmado leyendo `manual_integracion_gtfs.pdf` (Sonda S.A., v1.0,
 * 2023-03-01) y verificado en vivo el 2026-08-31 (ver docs/handoff/01-datos.md
 * sección 8):
 *
 *   POST {METROBUS_GTFS_PARTNER_VALIDATION_URL}
 *   body: { "usuario": ..., "senha": ... }
 *   -> { expirationDateTime, generationDateTime, urlRealTime, urlStatic }
 *
 * No hay un "token" separado en el sentido de un Bearer que se reutilice: la
 * respuesta de este login ES directamente las URLs para descargar los feeds
 * (S3 presigned URLs con firma AWS4-HMAC-SHA256 incrustada en el query
 * string). No hace falta ni tiene sentido cachear un Authorization header —
 * el "token" de este esquema son las URLs mismas, que ya expiran solas.
 *
 * Discrepancia real encontrada entre el PDF y el comportamiento observado:
 * el manual dice "las URLs siempre caducan después de 10 minutos de su
 * generación" (sección 2.2), pero la respuesta real medida trae
 * `X-Amz-Expires=10799` segundos (~3 horas) y
 * `expirationDateTime - generationDateTime` = exactamente 3 horas en la
 * corrida de prueba. No se asume el PDF ni el valor observado como una
 * garantía contractual — la decisión de diseño de abajo no depende de cuál
 * de los dos sea el correcto.
 *
 * Decisión de refresco (documentada, no supuesta): se llama a
 * `partnerValidation` en CADA corrida de `fetch-and-store.ts`, nunca se
 * persiste ni reutiliza una URL entre corridas. Motivo: el costo de este
 * login es una sola llamada HTTP barata, y cachear obligaría a confiar en
 * cuál de los dos valores de expiración (10 min documentados vs. ~3h
 * observadas) es el real -- innecesario cuando pedir una URL fresca cada vez
 * es más simple y siempre correcto.
 */

export interface MetrobusFeedUrls {
  urlRealTime: string;
  urlStatic: string;
  generationDateTime: string;
  expirationDateTime: string;
}

export async function getMetrobusFeedUrls(): Promise<MetrobusFeedUrls> {
  const validationUrl = process.env["METROBUS_GTFS_PARTNER_VALIDATION_URL"];
  const usuario = process.env["METROBUS_GTFS_API_USER"];
  const senha = process.env["METROBUS_GTFS_API_PASSWORD"];

  if (!validationUrl || !usuario || !senha) {
    throw new Error(
      "[gtfs-rt:metrobus] Faltan credenciales en .env: se necesitan " +
        "METROBUS_GTFS_PARTNER_VALIDATION_URL, METROBUS_GTFS_API_USER y " +
        "METROBUS_GTFS_API_PASSWORD (ver docs/handoff/01-datos.md sección 8)."
    );
  }

  const res = await fetch(validationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, senha }),
  });

  if (!res.ok) {
    throw new Error(
      `[gtfs-rt:metrobus] partnerValidation respondió ${res.status} ${res.statusText}`
    );
  }

  const body = (await res.json()) as Partial<MetrobusFeedUrls>;

  if (!body.urlRealTime || !body.urlStatic) {
    throw new Error(
      "[gtfs-rt:metrobus] partnerValidation respondió 200 pero sin urlRealTime/urlStatic. " +
        "Respuesta inesperada -- revisar si Sonda cambió el contrato de la API."
    );
  }

  return {
    urlRealTime: body.urlRealTime,
    urlStatic: body.urlStatic,
    generationDateTime: body.generationDateTime ?? "",
    expirationDateTime: body.expirationDateTime ?? "",
  };
}
