/**
 * Precómputo de bike_edges: tramo ciclista real entre pares de estaciones
 * Ecobici dentro de un radio razonable para un viaje en bici (5,000m --
 * ver docs/handoff/02-grafo.md sección nueva para la evidencia real de
 * conteos a distintos radios y de percentiles de distancia de viajes
 * reales que llevaron a ese número; NO es el radio de 400m de
 * build-walk-edges.ts, que es para caminar).
 *
 * Distancia: geodésica en línea recta (ST_Distance sobre geography) x
 * WALK_CIRCUITY_FACTOR (1.3, la MISMA constante que ya usa
 * build-walk-edges.ts) -- se reutiliza para estimar la distancia real de
 * calle del tramo en bici a partir de la línea recta entre dos estaciones,
 * exactamente el mismo razonamiento que ya se aplica para caminata.
 *
 * Tiempo: esa distancia (ya con circuidad aplicada) / speed_mps_used,
 * donde speed_mps_used es median_speed_mps de la fila más reciente de
 * ecobici_speed_stats (datos-gtfs recomendó explícitamente la mediana
 * sobre el promedio porque la distribución de velocidades sigue sesgada a
 * la derecha incluso después del recorte de Tukey -- ver
 * docs/handoff/01-datos.md sección 7.4 -- se sigue esa recomendación:
 * la mediana representa mejor el viaje "típico" que el promedio, que un
 * puñado de viajes rápidos/largos infla).
 *
 * ADVERTENCIA IMPORTANTE sobre no aplicar la corrección de circuidad dos
 * veces: median_speed_mps se calculó dividiendo DISTANCIA RECTA real entre
 * TIEMPO real medido de viajes reales (ver
 * scripts/ecobici/compute-speed-stats.ts) -- es decir, esa velocidad YA
 * está neteando el circuito real de calle contra el tiempo real, del lado
 * contrario al que usa WALK_CIRCUITY_FACTOR aquí. Si esta velocidad se
 * multiplicara otra vez por un factor de circuidad, la corrección se
 * aplicaría dos veces sobre el mismo fenómeno. Por eso aquí:
 *   - WALK_CIRCUITY_FACTOR SÍ se aplica -- pero solo a la distancia
 *     estimada entre las DOS estaciones NUEVAS que conecta esta fila
 *     (nunca antes calculada, sin viajes reales que la midan).
 *   - median_speed_mps NUNCA se multiplica por WALK_CIRCUITY_FACTOR ni por
 *     ningún otro factor -- se usa tal cual sale de ecobici_speed_stats.
 *
 * Filtro de radio mínimo (100m): mismo umbral que ya usa
 * compute-speed-stats.ts (MIN_DISTANCE_M) -- pares más cercanos ya están
 * cubiertos por walk_edges (ecobici<->ecobici, radio 400m) y a esa escala
 * el ruido línea-recta-vs-calle-real domina cualquier señal útil de un
 * tramo en bici (nadie desanclaría una bici para pedalear 50m).
 *
 * Idempotente: ON CONFLICT sobre el índice único
 * (from_station_id, to_station_id) hace upsert.
 */
import "dotenv/config";
import { getPool, closePool } from "../db.ts";

const RADIUS_METERS = 5000;
const MIN_DISTANCE_METERS = 100;
const WALK_CIRCUITY_FACTOR = 1.3;

interface SpeedStatRow {
  id: number;
  median_speed_mps: number;
  computed_at: string;
}

async function main(): Promise<void> {
  const pool = getPool();

  const { rows: speedRows } = await pool.query<SpeedStatRow>(
    `SELECT id, median_speed_mps, computed_at
     FROM ecobici_speed_stats
     ORDER BY computed_at DESC
     LIMIT 1;`
  );
  const speedStat = speedRows[0];
  if (!speedStat) {
    throw new Error(
      "ecobici_speed_stats está vacía. Corre 'npm run etl:ecobici:trips' y " +
        "'npm run etl:ecobici:speed-stats' primero (ver docs/handoff/01-datos.md sección 7)."
    );
  }
  if (speedStat.median_speed_mps == null) {
    throw new Error(
      `ecobici_speed_stats.id=${speedStat.id} no tiene median_speed_mps calculada.`
    );
  }
  const speedMpsUsed = speedStat.median_speed_mps;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO bike_edges
        (from_station_id, to_station_id, distance_meters, duration_secs,
         speed_mps_used, speed_stat_id, is_network_distance, geom)
       SELECT
         a.station_id,
         b.station_id,
         ST_Distance(a.geom::geography, b.geom::geography) * $1 AS distance_meters,
         GREATEST(1, ROUND(
           (ST_Distance(a.geom::geography, b.geom::geography) * $1) / $2
         ))::INTEGER AS duration_secs,
         $2,
         $3,
         false,
         ST_MakeLine(a.geom, b.geom)
       FROM ecobici_stations a
       JOIN ecobici_stations b ON a.station_id <> b.station_id
       WHERE ST_DWithin(a.geom::geography, b.geom::geography, $4)
         AND ST_Distance(a.geom::geography, b.geom::geography) >= $5
       ON CONFLICT (from_station_id, to_station_id)
       DO UPDATE SET
         distance_meters = EXCLUDED.distance_meters,
         duration_secs = EXCLUDED.duration_secs,
         speed_mps_used = EXCLUDED.speed_mps_used,
         speed_stat_id = EXCLUDED.speed_stat_id,
         geom = EXCLUDED.geom,
         computed_at = now();`,
      [WALK_CIRCUITY_FACTOR, speedMpsUsed, speedStat.id, RADIUS_METERS, MIN_DISTANCE_METERS]
    );

    await client.query("COMMIT");

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM bike_edges;");
    console.log(
      `[graph:bike-edges] listo. speed_stat_id=${speedStat.id} median_speed_mps=${speedMpsUsed}. ` +
        `Filas insertadas/actualizadas=${result.rowCount}. Total en bike_edges=${rows[0].n}.`
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error("[graph:bike-edges] ERROR:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
