/**
 * Calcula la velocidad real de bici (m/s) a partir de ecobici_trips_historical
 * + ecobici_stations.geom, y guarda el resultado en ecobici_speed_stats.
 * Entregable agregado (2026-08-22) — esto es lo que modelo-grafo consume
 * para las aristas de bici, en vez de una constante inventada.
 *
 * Distancia: ST_Distance(geom::geography, geom::geography) entre la
 * estación de retiro y la de arribo — es geodésica en LÍNEA RECTA, no
 * distancia real de calle (no hay routing real sobre la red ciclista en
 * este agente, ver docs/handoff/01-datos.md). Consecuencia importante para
 * quien consuma esto: la distancia real recorrida en calle es >= a esta
 * distancia recta, así que la velocidad "real" de pedaleo es en todo caso
 * MAYOR a la que se calcula aquí — este número ya neteando parte del
 * circuito real de calle contra el tiempo real, parecido en espíritu al
 * WALK_CIRCUITY_FACTOR que modelo-grafo ya aplica en build-walk-edges.ts
 * para caminata. Si modelo-grafo multiplica esta velocidad por un factor
 * de circuidad adicional para estimar distancia real, hay que tener
 * cuidado de no aplicar la corrección dos veces (ver handoff).
 *
 * Criterios de exclusión de outliers, todos documentados con su porqué en
 * docs/handoff/01-datos.md (no se esconden, regla dura del agente):
 *  1. Ambas estaciones deben resolver a una fila real y vigente de
 *     ecobici_stations (si no, no hay geometría con la que calcular
 *     distancia).
 *  2. start_station_id <> end_station_id: un viaje redondo a la misma
 *     estación tiene distancia recta 0 -> no aporta señal de velocidad.
 *  3. duration_seconds BETWEEN 60 AND 7200: <60s son probablemente
 *     "falsos arranques" (0.02% de los viajes con estaciones resueltas);
 *     >7200s (2h) incluye viajes claramente no continuos (mandados,
 *     bicis "perdidas" que aparecen reconciliadas meses o años después —
 *     se encontraron 2 filas así en el CSV real, con duración de hasta
 *     ~3.77 años). El corte de 7200s cae cerca del percentil 99.9 de la
 *     duración real observada.
 *  4. distance_m >= 100: excluye pares de estaciones prácticamente
 *     colocalizadas (p.ej. cicloestaciones pareadas físicamente, como los
 *     códigos compuestos "107-108" del CSV crudo, que ya se excluyen en la
 *     normalización, pero también hay pares de station_id DISTINTOS a
 *     <100m de distancia real). A esa escala el ruido de "línea recta vs.
 *     calle real" domina cualquier señal de velocidad.
 *  5. Recorte estadístico final por rango intercuartílico de Tukey
 *     (Q1 - 1.5*IQR, Q3 + 1.5*IQR) sobre la velocidad ya calculada de los
 *     viajes que pasan los filtros 1-4. Se prefirió este método (estándar,
 *     nombrado, reproducible) sobre un tope "físicamente plausible"
 *     elegido a mano, porque explorar los datos mostró que un corte fijo
 *     tipo "máximo 8-10 m/s" habría descartado 25-45% de los viajes
 *     válidos — CDMX tiene distancias entre estaciones relativamente
 *     largas (mediana ~3.9km en línea recta) y usuarios de Ecobici son en
 *     buena parte abonados que se desplazan a diario, no turistas
 *     casuales, así que ritmos de 15-20 km/h sostenidos NO son un error
 *     obvio de dato. El límite superior de Tukey sí descarta las colas
 *     físicamente imposibles (se observaron "velocidades" de hasta 155
 *     m/s = 560 km/h antes de este recorte, producto casi seguro de
 *     relojes desincronizados o datos corruptos, no de pedaleo real).
 *
 * La distribución resultante sigue sesgada a la derecha incluso después
 * del recorte de Tukey (mediana < promedio) — se guardan AMBOS valores en
 * ecobici_speed_stats. No se decide aquí cuál debe usar modelo-grafo para
 * las aristas; se documenta el trade-off en el handoff y se deja la
 * decisión al agente que sí diseña el grafo.
 */
import "dotenv/config";
import { getPool, closePool } from "../db.ts";

const MIN_DURATION_S = 60;
const MAX_DURATION_S = 7200;
const MIN_DISTANCE_M = 100;
const SOURCE_MONTHS = "2026-07";

interface CandidateStats {
  candidate_count: string;
}

interface QuartileRow {
  q1: number;
  q3: number;
}

interface FinalStats {
  sample_size_used: string;
  avg_speed_mps: number;
  median_speed_mps: number;
  stddev_speed_mps: number;
  min_speed_mps: number;
  max_speed_mps: number;
}

const CANDIDATE_CTE = `
  WITH candidate AS (
    SELECT
      ST_Distance(a.geom::geography, b.geom::geography) AS distance_m,
      t.duration_seconds,
      ST_Distance(a.geom::geography, b.geom::geography) / t.duration_seconds AS speed_mps
    FROM ecobici_trips_historical t
    JOIN ecobici_stations a ON a.station_id = t.start_station_id
    JOIN ecobici_stations b ON b.station_id = t.end_station_id
    WHERE t.start_station_id IS NOT NULL
      AND t.end_station_id IS NOT NULL
      AND t.start_station_id <> t.end_station_id
      AND t.duration_seconds BETWEEN ${MIN_DURATION_S} AND ${MAX_DURATION_S}
      AND ST_Distance(a.geom::geography, b.geom::geography) >= ${MIN_DISTANCE_M}
  )
`;

async function main(): Promise<void> {
  const pool = getPool();

  const { rows: totalRows } = await pool.query<{ count: string }>(
    "SELECT count(*)::text FROM ecobici_trips_historical;"
  );
  const totalLoaded = Number(totalRows[0]!.count);

  const { rows: resolvedRows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text FROM ecobici_trips_historical
     WHERE start_station_id IS NOT NULL AND end_station_id IS NOT NULL;`
  );
  const bothResolved = Number(resolvedRows[0]!.count);

  const { rows: candRows } = await pool.query<CandidateStats>(
    CANDIDATE_CTE + "SELECT count(*)::text AS candidate_count FROM candidate;"
  );
  const candidateCount = Number(candRows[0]!.candidate_count);

  const { rows: quartileRows } = await pool.query<QuartileRow>(
    CANDIDATE_CTE +
      `SELECT
         percentile_cont(0.25) WITHIN GROUP (ORDER BY speed_mps) AS q1,
         percentile_cont(0.75) WITHIN GROUP (ORDER BY speed_mps) AS q3
       FROM candidate;`
  );
  const { q1, q3 } = quartileRows[0]!;
  const iqr = q3 - q1;
  const lowerBound = Math.max(q1 - 1.5 * iqr, 0);
  const upperBound = q3 + 1.5 * iqr;

  const { rows: finalRows } = await pool.query<FinalStats>(
    CANDIDATE_CTE +
      `SELECT
         count(*)::text AS sample_size_used,
         avg(speed_mps) AS avg_speed_mps,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY speed_mps) AS median_speed_mps,
         stddev(speed_mps) AS stddev_speed_mps,
         min(speed_mps) AS min_speed_mps,
         max(speed_mps) AS max_speed_mps
       FROM candidate
       WHERE speed_mps BETWEEN $1 AND $2;`,
    [lowerBound, upperBound]
  );
  const final = finalRows[0]!;
  const sampleSizeUsed = Number(final.sample_size_used);

  const notes = JSON.stringify({
    total_rows_loaded: totalLoaded,
    both_stations_resolved: bothResolved,
    structural_candidate_count: candidateCount,
    tukey_q1: q1,
    tukey_q3: q3,
    tukey_iqr: iqr,
    tukey_lower_bound_mps: lowerBound,
    tukey_upper_bound_mps: upperBound,
    filters: {
      min_duration_s: MIN_DURATION_S,
      max_duration_s: MAX_DURATION_S,
      min_distance_m: MIN_DISTANCE_M,
      excludes_same_station_pairs: true,
      excludes_unresolved_stations: true,
      final_trim: "Tukey IQR fences (Q1-1.5*IQR, Q3+1.5*IQR) on speed_mps",
    },
    distance_note:
      "distance_m es geodésica en línea recta entre estaciones (ST_Distance sobre geography), no distancia de calle real. Ver comentario de cabecera en compute-speed-stats.ts.",
    skew_note:
      "median_speed_mps < avg_speed_mps: la distribución sigue sesgada a la derecha tras el recorte de Tukey. modelo-grafo decide cuál usar para las aristas de bici.",
  });

  await pool.query(
    `INSERT INTO ecobici_speed_stats
      (source_months, sample_size_total, sample_size_used, avg_speed_mps,
       median_speed_mps, stddev_speed_mps, min_duration_threshold_s,
       max_duration_threshold_s, min_distance_threshold_m, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);`,
    [
      SOURCE_MONTHS,
      totalLoaded,
      sampleSizeUsed,
      final.avg_speed_mps,
      final.median_speed_mps,
      final.stddev_speed_mps,
      MIN_DURATION_S,
      MAX_DURATION_S,
      MIN_DISTANCE_M,
      notes,
    ]
  );

  console.log("[ecobici:speed-stats] listo.");
  console.log(`  total cargado: ${totalLoaded}`);
  console.log(`  ambas estaciones resueltas: ${bothResolved} (${((bothResolved / totalLoaded) * 100).toFixed(1)}%)`);
  console.log(`  candidatos tras filtros estructurales: ${candidateCount}`);
  console.log(`  Tukey bounds: [${lowerBound.toFixed(3)}, ${upperBound.toFixed(3)}] m/s`);
  console.log(`  muestra final usada: ${sampleSizeUsed}`);
  console.log(`  avg_speed_mps: ${final.avg_speed_mps}`);
  console.log(`  median_speed_mps: ${final.median_speed_mps}`);
  console.log(`  stddev_speed_mps: ${final.stddev_speed_mps}`);
}

main()
  .catch((err) => {
    console.error("[ecobici:speed-stats] ERROR:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
