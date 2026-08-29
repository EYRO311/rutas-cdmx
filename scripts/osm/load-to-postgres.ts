/**
 * Carga el extracto crudo de OSM (Overpass, ver
 * data/raw/osm/cdmx-pedestrian-cycling.json, generado por
 * scripts/osm/fetch-cdmx-extract.ts en Fase 1) a las tablas osm_nodes /
 * osm_ways (migración 0009_osm_walk_network.sql).
 *
 * Decisión de modelo-grafo: se carga la red tal cual viene de Overpass
 * (nodos y ways con su geometría reconstruida), sin construir todavía un
 * grafo topológico ruteable (eso requeriría snapping + un motor tipo
 * pgRouting o un Dijkstra propio sobre ~274k nodos, que es una pieza de
 * ingeniería más grande de lo que pide el entregable de esta fase — ver
 * docs/handoff/02-grafo.md, sección de limitaciones). Cargar la red aquí
 * deja el insumo listo y consultable espacialmente para cuando alguien
 * decida construir esa capa.
 *
 * No es un job de cron: se corre una vez (o cada vez que se re-descargue el
 * extracto de Overpass). Idempotente por PK (osm_id) con upsert.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../db.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OSM_FILE = path.resolve(
  __dirname,
  "..",
  "..",
  "data",
  "raw",
  "osm",
  "cdmx-pedestrian-cycling.json"
);

interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
}

interface OsmWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

type OsmElement = OsmNode | OsmWay;

const BATCH_SIZE = 2000;

function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function main(): Promise<void> {
  console.log(`[osm:load] leyendo ${OSM_FILE} ...`);
  const raw = await readFile(OSM_FILE, "utf8");
  const data = JSON.parse(raw) as { elements: OsmElement[] };

  const nodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  for (const el of data.elements) {
    if (el.type === "node") nodes.set(el.id, el);
    else if (el.type === "way") ways.push(el);
  }
  console.log(`[osm:load] parseado: ${nodes.size} nodes, ${ways.length} ways.`);

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // --- nodes, en batches ---
    let nodeRows = 0;
    const nodeArr = [...nodes.values()];
    for (let i = 0; i < nodeArr.length; i += BATCH_SIZE) {
      const batch = nodeArr.slice(i, i + BATCH_SIZE);
      const values: string[] = [];
      const params: unknown[] = [];
      batch.forEach((n, idx) => {
        const base = idx * 3;
        values.push(
          `($${base + 1},$${base + 2},$${base + 3},ST_SetSRID(ST_MakePoint($${base + 3},$${base + 2}),4326))`
        );
        params.push(n.id, n.lat, n.lon);
      });
      await client.query(
        `INSERT INTO osm_nodes (osm_id, lat, lon, geom) VALUES ${values.join(",")}
         ON CONFLICT (osm_id) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, geom = EXCLUDED.geom;`,
        params
      );
      nodeRows += batch.length;
    }
    console.log(`[osm:load] osm_nodes: ${nodeRows} filas upserteadas.`);

    // --- ways, en batches. Geometría reconstruida a partir de los nodos
    // referenciados; ways cuyos nodos no estén todos en el extracto se
    // guardan sin geom (Fase 1 reportó 0 referencias rotas, pero no se
    // asume, se verifica en tiempo de carga). ---
    let wayRows = 0;
    let wayRowsNoGeom = 0;
    for (let i = 0; i < ways.length; i += BATCH_SIZE) {
      const batch = ways.slice(i, i + BATCH_SIZE);
      const values: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 0;
      for (const w of batch) {
        const coords: [number, number][] = [];
        let complete = true;
        for (const nid of w.nodes) {
          const n = nodes.get(nid);
          if (!n) {
            complete = false;
            break;
          }
          coords.push([n.lat, n.lon]);
        }
        let lengthMeters: number | null = null;
        let wkt: string | null = null;
        if (complete && coords.length >= 2) {
          lengthMeters = 0;
          for (let k = 1; k < coords.length; k++) {
            lengthMeters += haversineMeters(coords[k - 1]!, coords[k]!);
          }
          wkt = `SRID=4326;LINESTRING(${coords.map(([lat, lon]) => `${lon} ${lat}`).join(",")})`;
        } else {
          wayRowsNoGeom++;
        }

        const p1 = ++paramIdx;
        const p2 = ++paramIdx;
        const p3 = ++paramIdx;
        const p4 = ++paramIdx;
        const p5 = ++paramIdx;
        const p6 = ++paramIdx;
        const geomExpr = wkt ? `ST_GeomFromEWKT($${++paramIdx})` : "NULL";
        values.push(
          `($${p1},$${p2},$${p3},$${p4}::jsonb,$${p5},$${p6},${geomExpr})`
        );
        params.push(
          w.id,
          w.tags?.highway ?? null,
          w.tags?.name ?? null,
          JSON.stringify(w.tags ?? {}),
          w.nodes,
          lengthMeters
        );
        if (wkt) params.push(wkt);
      }
      await client.query(
        `INSERT INTO osm_ways (osm_id, highway, name, tags, node_ids, length_meters, geom)
         VALUES ${values.join(",")}
         ON CONFLICT (osm_id) DO UPDATE SET
           highway = EXCLUDED.highway, name = EXCLUDED.name, tags = EXCLUDED.tags,
           node_ids = EXCLUDED.node_ids, length_meters = EXCLUDED.length_meters, geom = EXCLUDED.geom;`,
        params
      );
      wayRows += batch.length;
    }
    console.log(
      `[osm:load] osm_ways: ${wayRows} filas upserteadas (${wayRowsNoGeom} sin geometría por nodos faltantes).`
    );

    await client.query("COMMIT");
    console.log("[osm:load] listo.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error("[osm:load] ERROR:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
