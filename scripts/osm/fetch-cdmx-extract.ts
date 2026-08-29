/**
 * Extracto OSM de la red peatonal y ciclista de CDMX.
 *
 * DECISIÓN: Geofabrik no publica un extracto a nivel ciudad para CDMX, solo
 * a nivel país (mexico-latest.osm.pbf, ~varios cientos de MB) — descargarlo
 * completo y filtrarlo requeriría osmium-tool o osmconvert, ninguno de los
 * dos instalado en esta máquina, y añadir esa dependencia de sistema
 * (no-npm) está fuera de lo que este agente puede instalar de forma
 * confiable en Windows sin intervención manual.
 *
 * En su lugar se usa la Overpass API (overpass-api.de) para pedir
 * directamente las vías peatonales/ciclistas dentro de un bounding box que
 * cubre CDMX + la zona conurbada que ya toca el GTFS cargado (Interurbano
 * llega hasta Zinacantepec, RTP/CC cruzan hacia Edomex). El resultado es
 * JSON (formato "Overpass JSON", no PBF) — más grande que un PBF equivalente
 * pero no requiere herramientas de conversión adicionales, y protobufjs no
 * sirve para PBF de OSM (es un esquema binario distinto al de GTFS-RT).
 *
 * Trade-off documentado: Overpass tiene límites de uso (rate limiting, un
 * timeout de servidor) pensados para queries puntuales, no para descargas
 * masivas repetidas — esto es apto para un extracto inicial que arma la
 * base del grafo peatonal/ciclista (fase 2, modelo-grafo), NO para correrlo
 * en cada ETL. Si más adelante se necesita más cobertura o refrescos
 * frecuentes, la alternativa es descargar mexico-latest.osm.pbf de
 * Geofabrik e instalar osmium-tool para filtrar por bbox localmente.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "..", "data", "raw", "osm");
const OUT_FILE = path.join(OUT_DIR, "cdmx-pedestrian-cycling.json");

// Cubre las 16 alcaldías de CDMX más el margen hacia Edomex que ya pisa el
// GTFS cargado (Interurbano, RTP y Corredores Concesionados cruzan el
// límite). Verificado contra el bbox real de stops.txt cargado en Postgres:
// lat 19.133–19.667, lon -99.695–-98.953. Este bbox le da margen extra.
const BBOX = {
  south: 19.03,
  west: -99.72,
  north: 19.7,
  east: -98.9,
};

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

function buildQuery(): string {
  const bbox = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
  // Nota: se probó primero con una versión más amplia que además incluía
  // `way["highway"]["foot"~"yes|designated"]` y el equivalente para
  // bicycle sobre CUALQUIER highway (no solo los tipos dedicados). Esa
  // versión le pide a Overpass una fracción enorme de la red vial completa
  // de CDMX (casi toda calle permite caminarla) y el servidor respondió
  // 504 Gateway Timeout de forma consistente. Se acotó a los tipos de vía
  // dedicados a peatones/bicis, que es lo que realmente hace falta para el
  // grafo de "última milla" (fase 2), y así sí responde (~36 MB, ~10-15s
  // en las pruebas de este agente).
  return `
[out:json][timeout:120];
(
  way["highway"~"^(footway|path|pedestrian|steps|living_street|cycleway)$"](${bbox});
);
out body;
>;
out skel qt;
`.trim();
}

async function fetchWithRetry(query: string, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      // Overpass (Apache) devuelve 406 Not Acceptable si el User-Agent es
      // genérico o no viene seteado (fetch de Node no manda uno por default).
      // La política de uso de Overpass pide identificar al cliente:
      // https://wiki.openstreetmap.org/wiki/Overpass_API#Introduction
      const res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "rutas-cdmx-etl/1.0 (+https://github.com/; contacto: ruiz.oropeza.emiliano.yahel@gmail.com)",
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (res.ok) return res;
      // 504 en las pruebas de este agente fue intermitente (backend
      // compartido de overpass-api.de) — reintentar sirvió en la práctica.
      if (res.status === 504 && i < attempts) {
        console.warn(`[osm] intento ${i}/${attempts}: 504 Gateway Timeout, reintentando...`);
        continue;
      }
      const text = await res.text();
      throw new Error(`Overpass respondió ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    } catch (err) {
      lastErr = err;
      if (i === attempts) throw err;
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const query = buildQuery();
  console.log(`[osm] consultando Overpass API, bbox=${JSON.stringify(BBOX)} ...`);
  console.log("[osm] esto puede tardar minutos; Overpass es best-effort y puede dar timeout.");

  const res = await fetchWithRetry(query);
  const json = (await res.json()) as { elements: unknown[] };
  await writeFile(OUT_FILE, JSON.stringify(json));

  const nodeCount = json.elements.filter((e) => (e as any).type === "node").length;
  const wayCount = json.elements.filter((e) => (e as any).type === "way").length;
  console.log(
    `[osm] guardado en ${OUT_FILE}: ${json.elements.length} elementos (${wayCount} ways, ${nodeCount} nodes).`
  );
}

main().catch((err) => {
  console.error("[osm] ERROR:", err);
  process.exitCode = 1;
});
