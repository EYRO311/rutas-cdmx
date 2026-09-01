import "dotenv/config";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

// Worker de campo, 100% local: vigila una cuenta de Gmail por IMAP, espera
// correos con formato "origen:"/"destino:"/"hora:", llama a la API de rutas
// que ya corre en esta misma máquina (`npm run dev:api`), y responde por
// correo con el itinerario calculado. Pensado para mandar el correo desde el
// celular mientras la laptop hace de servidor -- nada de esto toca Vercel ni
// Supabase.

const EMAIL_USER = requireEnv("EMAIL_USER");
const EMAIL_APP_PASSWORD = requireEnv("EMAIL_APP_PASSWORD");
const API_KEY = requireEnv("API_KEY");
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";
const SUBJECT_TAG = process.env.FIELD_TEST_SUBJECT_TAG ?? "RUTA";

// Header propio para marcar las respuestas del worker. Sin esto hay un loop
// real: el uso previsto es mandar el correo A LA MISMA cuenta que vigila el
// worker (ver README), así que la respuesta ("Re: RUTA", from=EMAIL_USER)
// cae en la MISMA bandeja, viene de un remitente de confianza (EMAIL_USER
// está en ALLOWED_SENDERS) y sigue trayendo "RUTA" en el asunto -- sin este
// header el worker se contesta a sí mismo indefinidamente (pasó de verdad:
// decenas de respuestas antes de detectarlo).
const WORKER_REPLY_HEADER = "x-rutas-cdmx-field-test-reply";

// Remitentes de confianza que pueden disparar un cómputo + respuesta.
// Por default solo la propia cuenta monitoreada, pero en la práctica el
// celular puede mandar desde OTRA cuenta de Gmail hacia esta bandeja (ej.
// varias cuentas configuradas en la app de Gmail) -- FIELD_TEST_ALLOWED_SENDERS
// (coma-separado) permite agregar esas cuentas sin abrir la bandeja a cualquiera.
const ALLOWED_SENDERS = (process.env.FIELD_TEST_ALLOWED_SENDERS ?? EMAIL_USER)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// CDMX abolió el horario de verano en 2022 -- offset fijo, no calculado.
// Mismo supuesto que ya usa `src/api/lib/cdmx-time.ts` (ver docs/handoff/05-api.md sección 9.1).
const CDMX_UTC_OFFSET = "-06:00";

// lon1,lat1,lon2,lat2 -- caja amplia sobre la ZMVM para sesgar el geocoder.
const CDMX_VIEWBOX = "-99.36,19.59,-98.94,19.13";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Falta ${name} en .env -- revisa el README de scripts/field-test/ antes de correr este worker.`,
    );
  }
  return value;
}

interface GeocodedPoint {
  lat: number;
  lon: number;
  displayName: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Acepta "lat,lon" directo (para pruebas donde ya tienes el pin de Google Maps)
 * o geocodifica texto libre contra Nominatim (OSM), sesgado a la ZMVM. */
async function geocode(query: string): Promise<GeocodedPoint> {
  const trimmed = query.trim();
  const directMatch = trimmed.match(
    /^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/,
  );
  if (directMatch) {
    return {
      lat: Number.parseFloat(directMatch[1]!),
      lon: Number.parseFloat(directMatch[2]!),
      displayName: trimmed,
    };
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("countrycodes", "mx");
  url.searchParams.set("viewbox", CDMX_VIEWBOX);
  url.searchParams.set("bounded", "1");
  url.searchParams.set("limit", "1");

  const res = await fetch(url, {
    headers: {
      // Nominatim exige un User-Agent identificable para uso personal de bajo volumen.
      "User-Agent": "rutas-cdmx-field-test-worker/1.0 (uso personal, no producción)",
    },
  });
  if (!res.ok) {
    throw new Error(`Nominatim respondió HTTP ${res.status} para "${trimmed}"`);
  }
  const results = (await res.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
  }>;
  if (results.length === 0) {
    throw new Error(`No se encontró la dirección: "${trimmed}"`);
  }
  const best = results[0]!;
  return {
    lat: Number.parseFloat(best.lat),
    lon: Number.parseFloat(best.lon),
    displayName: best.display_name,
  };
}

interface ParsedRequest {
  origenTexto: string;
  destinoTexto: string;
  hora: string | null; // "HH:MM" o null (== "ahora", o mediodía si hay "fecha" sin "hora")
  fecha: string | null; // "YYYY-MM-DD" o null (== hoy)
}

function parseBody(text: string): ParsedRequest {
  const origen = text.match(/^\s*origen\s*:\s*(.+)$/im);
  const destino = text.match(/^\s*destino\s*:\s*(.+)$/im);
  const hora = text.match(/^\s*hora\s*:\s*(\d{1,2}:\d{2})\s*$/im);
  const fecha = text.match(/^\s*fecha\s*:\s*(\d{4}-\d{2}-\d{2})\s*$/im);

  if (!origen || !destino) {
    throw new Error(
      'Formato no reconocido. Manda un correo con líneas "origen: ..." y ' +
        '"destino: ..." (y opcionalmente "hora: HH:MM" y "fecha: YYYY-MM-DD", hora CDMX).',
    );
  }
  return {
    origenTexto: origen[1]!.trim(),
    destinoTexto: destino[1]!.trim(),
    hora: hora ? hora[1]!.trim() : null,
    fecha: fecha ? fecha[1]!.trim() : null,
  };
}

// El GTFS cargado hoy vence casi por completo el 2025-12-31 (ver PLAN.md,
// deuda de Fase 2) -- pedir "ahora" (fecha real de hoy) da no_coverage por
// falta de servicio programado, no por un error del motor. Mientras no haya
// un feed 2026 vigente, "fecha:" deja fijar una fecha real dentro de la
// vigencia para poder seguir probando.
function buildDepartureAt(hora: string | null, fecha: string | null): string | undefined {
  if (!hora && !fecha) return undefined;
  const fechaEfectiva =
    fecha ??
    new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }); // YYYY-MM-DD
  const horaEfectiva = hora ?? "12:00"; // fecha sin hora -> mediodía, no "ahora" (no tendría sentido mezclar fecha fija con hora real del reloj)
  return `${fechaEfectiva}T${horaEfectiva}:00${CDMX_UTC_OFFSET}`;
}

interface RouteApiResponse {
  data: {
    routes: Array<{
      id: string;
      summary: {
        duration_s: number;
        cost_mxn: number;
        confidence: number;
        transfers: number;
        distance_m: number | null;
      };
      legs: Array<{
        mode: string;
        duration_s: number;
        from: { name: string | null };
        to: { name: string | null };
      }>;
    }>;
  } | null;
  meta: {
    engine?: {
      name?: string;
      plan_confidence?: string;
      expanded_node_count?: number;
      elapsed_ms?: number;
    };
    warnings?: string[];
  };
  error: { code: string; message: string } | null;
}

async function computeRoute(
  origin: GeocodedPoint,
  destination: GeocodedPoint,
  departureAt: string | undefined,
): Promise<RouteApiResponse> {
  const body: Record<string, unknown> = {
    origin: { lat: origin.lat, lon: origin.lon },
    destination: { lat: destination.lat, lon: destination.lon },
  };
  if (departureAt) body.departure_at = departureAt;

  const res = await fetch(`${API_BASE_URL}/v1/routes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as RouteApiResponse;
  if (!res.ok) {
    const message = json?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`La API de rutas respondió con error: ${message}`);
  }
  return json;
}

function formatReply(
  request: ParsedRequest,
  origin: GeocodedPoint,
  destination: GeocodedPoint,
  departureAt: string | undefined,
  response: RouteApiResponse,
): string {
  const routes = response.data?.routes ?? [];
  const engine = response.meta.engine ?? {};
  const lines: string[] = [];

  lines.push(`Origen: ${request.origenTexto}`);
  lines.push(`  -> geocodificado: ${origin.displayName} (${origin.lat}, ${origin.lon})`);
  lines.push(`Destino: ${request.destinoTexto}`);
  lines.push(`  -> geocodificado: ${destination.displayName} (${destination.lat}, ${destination.lon})`);
  lines.push(`Hora de salida: ${departureAt ?? "ahora"}`);
  lines.push(`Confianza del motor: ${engine.plan_confidence ?? "desconocida"}`);
  lines.push("");

  if (routes.length === 0) {
    lines.push(
      "Sin cobertura -- el motor no encontró ningún itinerario para este origen/destino/hora.",
    );
  } else {
    routes.forEach((route, i) => {
      const s = route.summary;
      lines.push(`--- Opción ${i + 1} ---`);
      lines.push(
        `Duración: ${Math.round(s.duration_s / 60)} min | Transbordos: ${s.transfers} | Costo: $${s.cost_mxn} MXN | Confianza: ${s.confidence}`,
      );
      for (const leg of route.legs) {
        lines.push(
          `  [${leg.mode}] ${leg.from.name ?? "?"} -> ${leg.to.name ?? "?"} (${Math.round(leg.duration_s / 60)} min)`,
        );
      }
      lines.push("");
    });
  }

  if (response.meta.warnings?.length) {
    lines.push(`Avisos del motor: ${response.meta.warnings.join("; ")}`);
  }
  lines.push("");
  lines.push(
    `[diagnóstico] motor=${engine.name ?? "?"} elapsed_ms=${engine.elapsed_ms ?? "?"} expansiones=${engine.expanded_node_count ?? "?"}`,
  );
  if (engine.plan_confidence === "degraded_long_distance") {
    lines.push(
      "[diagnóstico] tier de distancia larga activo -- esta respuesta tardó ~20-25s a propósito, ver docs/handoff/03-algoritmo.md sección 12.",
    );
  }
  return lines.join("\n");
}

async function handleMessage(
  transporter: nodemailer.Transporter,
  msg: FetchMessageObject,
): Promise<void> {
  const parsed = await simpleParser(msg.source!);
  const fromAddress = parsed.from?.value[0]?.address?.toLowerCase() ?? "";
  const subject = parsed.subject ?? "";

  const isTrustedSender = ALLOWED_SENDERS.includes(fromAddress);
  const hasTag = subject.toUpperCase().includes(SUBJECT_TAG.toUpperCase());
  const isOwnReply = parsed.headers.has(WORKER_REPLY_HEADER);

  // Solo procesamos correos de un remitente de confianza con el asunto
  // marcado -- evita que spam o correos ajenos disparen cómputo y
  // respuestas. Esto es defensa extra: el filtro principal ya corrió del
  // lado del servidor IMAP en processUnseen (from + subject), esto solo
  // cubre falsos positivos de esa búsqueda (ej. coincidencia parcial de
  // subject, o el "from" del SEARCH siendo un substring match de IMAP).
  // isOwnReply corta el loop real de contestarse a sí mismo -- ver
  // WORKER_REPLY_HEADER arriba.
  if (!isTrustedSender || !hasTag || isOwnReply) {
    return;
  }

  console.log(`[email-worker] Procesando "${subject}" de ${fromAddress}...`);
  const bodyText = parsed.text ?? "";

  let replyBody: string;
  try {
    const request = parseBody(bodyText);
    const departureAt = buildDepartureAt(request.hora, request.fecha);

    const [origin, destination] = await Promise.all([
      geocode(request.origenTexto),
      // Nominatim pide max ~1 req/seg; con dos en paralelo ya vamos holgados
      // para uso personal, pero espaciamos la segunda por si acaso.
      sleep(1100).then(() => geocode(request.destinoTexto)),
    ]);

    console.log(
      `[email-worker] ${origin.displayName} -> ${destination.displayName}, calculando ruta...`,
    );
    const response = await computeRoute(origin, destination, departureAt);
    replyBody = formatReply(request, origin, destination, departureAt, response);
  } catch (err) {
    replyBody = `No se pudo calcular la ruta:\n\n${(err as Error).message}`;
    console.error("[email-worker] Error procesando el correo:", err);
  }

  await transporter.sendMail({
    from: EMAIL_USER,
    to: fromAddress,
    subject: subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`,
    inReplyTo: parsed.messageId,
    references: parsed.messageId ? [parsed.messageId] : undefined,
    text: replyBody,
    headers: { [WORKER_REPLY_HEADER]: "1" },
  });
  console.log("[email-worker] Respuesta enviada.");
}

async function processUnseen(
  client: ImapFlow,
  transporter: nodemailer.Transporter,
): Promise<void> {
  // Filtra en el SERVIDOR por remitente(s) + asunto antes de traer el
  // cuerpo completo de cada mensaje -- sin esto, una cuenta con miles de
  // correos viejos sin leer (newsletters, notificaciones) obliga a
  // descargar el `source` completo de cada uno solo para descartarlo
  // client-side, que es lento y termina pareciendo "no llegó nada".
  // `isTrustedSender`/`hasTag` en handleMessage se quedan como defensa
  // extra, no como el único filtro (IMAP SEARCH FROM/SUBJECT son
  // substring match, no igualdad exacta).
  const senderFilter =
    ALLOWED_SENDERS.length === 1
      ? { from: ALLOWED_SENDERS[0]! }
      : { or: ALLOWED_SENDERS.map((from) => ({ from })) };

  let messages: FetchMessageObject[];
  const lock = await client.getMailboxLock("INBOX");
  try {
    messages = await client.fetchAll(
      { seen: false, subject: SUBJECT_TAG, ...senderFilter },
      { source: true, envelope: true, uid: true },
    );
    if (messages.length > 0) {
      // Se marca \Seen ANTES de calcular la ruta y mandar la respuesta,
      // no después. Geocodificar + calcular ruta puede tardar hasta 20-25s
      // (tier de distancia larga) con el socket IMAP sin actividad -- si
      // el socket muere a media espera (pasó de verdad: "Socket timeout"
      // en producción), reconectar y volver a buscar "no leídos" encontraba
      // el MISMO correo otra vez y lo reprocesaba, mandando una respuesta
      // duplicada por cada reconexión. Marcar seen primero, aunque el
      // proceso truene después, es preferible a un bucle de reenvíos.
      await client.messageFlagsAdd(
        messages.map((m) => m.uid),
        ["\\Seen"],
        { uid: true },
      );
    }
  } finally {
    lock.release();
  }

  // El trabajo lento (geocodificar, llamar la API de rutas, mandar el
  // correo) corre DESPUÉS de soltar el lock del mailbox y sin ningún
  // stream de IMAP a medio consumir -- así una respuesta tardada nunca
  // vuelve a poner en riesgo la conexión IMAP.
  for (const msg of messages) {
    try {
      await handleMessage(transporter, msg);
    } catch (err) {
      console.error("[email-worker] Fallo procesando un mensaje, se sigue con el resto:", err);
    }
  }
}

let shuttingDown = false;

/** Una sola sesión IMAP: conecta, vigila, y termina (lanzando) en cuanto
 * la conexión se cae por cualquier razón (timeout de socket, red, etc.).
 * `main()` decide si vale la pena reconectar. */
async function runSession(transporter: nodemailer.Transporter): Promise<void> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
    logger: false,
  });

  // ImapFlow emite 'error' para fallos de socket (timeout, reset, etc.) --
  // sin este listener, Node trata 'error' sin oyentes como excepción no
  // capturada y tumba el proceso completo (lo que pasó la primera vez:
  // un timeout de socket durante `idle()` mató el worker sin avisar).
  const connectionError = new Promise<never>((_, reject) => {
    client.on("error", (err: Error) => reject(err));
  });

  await client.connect();
  await client.mailboxOpen("INBOX");
  console.log(
    `[email-worker] Conectado como ${EMAIL_USER}. Vigilando INBOX por correos con asunto "${SUBJECT_TAG}"...`,
  );
  console.log(`[email-worker] API de rutas: ${API_BASE_URL}`);

  const shutdown = async () => {
    shuttingDown = true;
    console.log("\n[email-worker] Cerrando conexión IMAP...");
    await client.logout();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const watchLoop = (async () => {
    // Revisa lo que ya esté sin leer al arrancar, luego se queda esperando
    // avisos del servidor (IMAP IDLE) en vez de hacer polling a ciegas.
    await processUnseen(client, transporter);
    for (;;) {
      await client.idle();
      await processUnseen(client, transporter);
    }
  })();

  // La que truene primero (el loop de vigilancia o un error de socket)
  // decide -- así una caída de red no queda como una promesa colgada.
  await Promise.race([watchLoop, connectionError]);
}

async function main(): Promise<void> {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
  });

  let backoffMs = 5000;
  for (;;) {
    try {
      await runSession(transporter);
    } catch (err) {
      if (shuttingDown) return;
      console.error(
        `[email-worker] Conexión IMAP caída (${(err as Error).message}). Reintentando en ${backoffMs / 1000}s...`,
      );
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
      continue;
    }
    // runSession solo retorna limpio si watchLoop terminara (nunca debería
    // pasar, es un for(;;) infinito) -- por si acaso, no lo tratamos como
    // fatal, se reintenta igual que un error real.
    backoffMs = 5000;
  }
}

// Red flaky de verdad (pasó hoy): un ECONNRESET durante el handshake TLS de
// `client.connect()`, antes de que ImapFlow termine de conectar su propio
// listener de 'error', llega como excepción no capturada a nivel de proceso
// -- el `client.on("error", ...)` de runSession() no la ve, y sin este
// manejador tumba TODO el worker (main() nunca llega a reintentar). Con
// esto, ese tipo de error solo se registra; el loop de reintentos de main()
// sigue siendo el único que decide reconectar.
process.on("uncaughtException", (err) => {
  console.error("[email-worker] Excepción no capturada (probablemente un socket viejo cayéndose tarde) -- se ignora, main() sigue reintentando:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[email-worker] Promesa rechazada sin capturar -- se ignora:", err);
});

main().catch((err) => {
  console.error("[email-worker] Error fatal:", err);
  process.exit(1);
});
