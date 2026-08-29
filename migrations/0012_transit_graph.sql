-- Grafo time-expanded (nodo = (parada, tiempo), arista = tramo de viaje |
-- transbordo | caminata). No se materializa como filas por-instante: con
-- 1,203/1,205 trips definidos por frequencies (headway, no horario fijo,
-- ver docs/handoff/01-datos.md sección 5 punto 7), materializar cada
-- salida real durante meses de vigencia de calendar sería ilimitado. En su
-- lugar: la TOPOLOGÍA (qué parada sigue a cuál dentro de un trip, con qué
-- offset relativo) SÍ se materializa (es estática, viene de stop_times) y
-- el TIEMPO se expande en la consulta, acotado a la ventana pedida
-- (generate_series de rango acotado, no por todo el día).
--
-- trip_stop_offsets: offset de cada parada dentro de su trip relativo a la
-- salida de la primera parada del trip. Vista (no tabla): solo la usa el
-- rebuild de trip_hops, no está en la ruta caliente de queries.
CREATE OR REPLACE VIEW trip_stop_offsets AS
SELECT
  st.trip_id,
  st.stop_sequence,
  st.stop_id,
  first_st.departure_time_secs AS trip_base_secs,
  st.departure_time_secs - first_st.departure_time_secs AS departure_offset_secs,
  st.arrival_time_secs - first_st.departure_time_secs AS arrival_offset_secs
FROM stop_times st
JOIN (
  SELECT DISTINCT ON (trip_id) trip_id, departure_time_secs
  FROM stop_times
  ORDER BY trip_id, stop_sequence
) first_st ON first_st.trip_id = st.trip_id;

-- trip_hops: TABLA (no vista) con una fila por cada "salto" consecutivo
-- (parada i -> parada i+1) dentro de un trip. Materializada a propósito:
-- un prototipo con esto como VIEW medía ~97ms por consulta porque Postgres
-- no puede empujar el filtro por from_stop_id antes de calcular la función
-- de ventana (LEAD) sobre las 42,789 filas de stop_times. Como tabla con
-- índice por from_stop_id, la misma consulta bajó a <1ms medido (ver
-- docs/handoff/02-grafo.md).
CREATE TABLE IF NOT EXISTS trip_hops (
  trip_id TEXT NOT NULL,
  trip_base_secs INTEGER NOT NULL,
  from_stop_id TEXT NOT NULL,
  from_stop_sequence INTEGER NOT NULL,
  from_departure_offset_secs INTEGER NOT NULL,
  to_stop_id TEXT NOT NULL,
  to_stop_sequence INTEGER NOT NULL,
  to_arrival_offset_secs INTEGER NOT NULL
);

-- Rebuild completo: TRUNCATE + re-poblar. Se llama a mano después de correr
-- el ETL de GTFS (npm run etl) si stop_times cambió — trip_hops NO se
-- mantiene sincronizada automáticamente vía trigger a propósito (los datos
-- GTFS no cambian en cada request, cambian cuando se re-corre el ETL; un
-- trigger fila-por-fila sería costo innecesario en cada carga masiva).
CREATE OR REPLACE FUNCTION refresh_trip_hops() RETURNS void AS $$
BEGIN
  TRUNCATE trip_hops;
  INSERT INTO trip_hops
  SELECT
    trip_id, trip_base_secs, from_stop_id, from_stop_sequence, from_departure_offset_secs,
    to_stop_id, to_stop_sequence, to_arrival_offset_secs
  FROM (
    SELECT
      trip_id,
      trip_base_secs,
      stop_id AS from_stop_id,
      stop_sequence AS from_stop_sequence,
      departure_offset_secs AS from_departure_offset_secs,
      LEAD(stop_id)      OVER w AS to_stop_id,
      LEAD(stop_sequence) OVER w AS to_stop_sequence,
      LEAD(arrival_offset_secs) OVER w AS to_arrival_offset_secs
    FROM trip_stop_offsets
    WINDOW w AS (PARTITION BY trip_id ORDER BY stop_sequence)
  ) expanded
  WHERE to_stop_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql;

SELECT refresh_trip_hops();

CREATE INDEX IF NOT EXISTS trip_hops_from_stop_idx ON trip_hops (from_stop_id);
CREATE INDEX IF NOT EXISTS trip_hops_trip_id_idx ON trip_hops (trip_id);

-- service_id activos para una fecha de servicio: día de semana en calendar,
-- ajustado por excepciones de calendar_dates (fuente actual la trae vacía,
-- pero se implementa completo para cuando exista una fuente que sí la
-- traiga -- ver docs/handoff/01-datos.md sección 5 punto 3).
CREATE OR REPLACE FUNCTION active_service_ids(p_service_date DATE)
RETURNS TABLE (service_id TEXT) LANGUAGE sql STABLE AS $$
  SELECT c.service_id
  FROM calendar c
  WHERE p_service_date BETWEEN c.start_date AND c.end_date
    AND (
      (EXTRACT(DOW FROM p_service_date) = 0 AND c.sunday) OR
      (EXTRACT(DOW FROM p_service_date) = 1 AND c.monday) OR
      (EXTRACT(DOW FROM p_service_date) = 2 AND c.tuesday) OR
      (EXTRACT(DOW FROM p_service_date) = 3 AND c.wednesday) OR
      (EXTRACT(DOW FROM p_service_date) = 4 AND c.thursday) OR
      (EXTRACT(DOW FROM p_service_date) = 5 AND c.friday) OR
      (EXTRACT(DOW FROM p_service_date) = 6 AND c.saturday)
    )
    AND NOT EXISTS (
      SELECT 1 FROM calendar_dates cd
      WHERE cd.service_id = c.service_id AND cd.date = p_service_date AND cd.exception_type = 2
    )
  UNION
  SELECT cd.service_id FROM calendar_dates cd
  WHERE cd.date = p_service_date AND cd.exception_type = 1;
$$;

-- Aristas de viaje (ride edges): salidas concretas desde p_stop_id dentro
-- de [p_from_secs, p_from_secs + p_window_secs), expandidas desde
-- trip_hops + frequencies (mayoría de trips) o directo desde el offset
-- literal (los 2/1205 trips sin frequencies). generate_series se acota al
-- rango de k relevante para la ventana pedida -- NO genera todas las
-- salidas del día para luego filtrar.
CREATE OR REPLACE FUNCTION graph_ride_departures(
  p_stop_id TEXT,
  p_service_date DATE,
  p_from_secs INTEGER,
  p_window_secs INTEGER DEFAULT 1800
) RETURNS TABLE (
  trip_id TEXT,
  route_id TEXT,
  from_stop_id TEXT,
  to_stop_id TEXT,
  depart_secs INTEGER,
  arrive_secs INTEGER
) LANGUAGE sql STABLE AS $$
  WITH hops AS (
    SELECT h.*, t.route_id
    FROM trip_hops h
    JOIN trips t ON t.trip_id = h.trip_id
    WHERE h.from_stop_id = p_stop_id
      AND t.service_id IN (SELECT service_id FROM active_service_ids(p_service_date))
  )
  SELECT
    hops.trip_id, hops.route_id, hops.from_stop_id, hops.to_stop_id,
    (f.start_time_secs + gs.k * f.headway_secs + hops.from_departure_offset_secs)::INTEGER,
    (f.start_time_secs + gs.k * f.headway_secs + hops.to_arrival_offset_secs)::INTEGER
  FROM hops
  JOIN frequencies f ON f.trip_id = hops.trip_id
  CROSS JOIN LATERAL generate_series(
    GREATEST(0, CEIL((p_from_secs - hops.from_departure_offset_secs - f.start_time_secs)::NUMERIC / f.headway_secs))::INTEGER,
    FLOOR((LEAST(f.end_time_secs, p_from_secs + p_window_secs) - hops.from_departure_offset_secs - f.start_time_secs)::NUMERIC / f.headway_secs)::INTEGER
  ) AS gs(k)

  UNION ALL

  SELECT
    hops.trip_id, hops.route_id, hops.from_stop_id, hops.to_stop_id,
    (hops.trip_base_secs + hops.from_departure_offset_secs)::INTEGER,
    (hops.trip_base_secs + hops.to_arrival_offset_secs)::INTEGER
  FROM hops
  WHERE NOT EXISTS (SELECT 1 FROM frequencies f WHERE f.trip_id = hops.trip_id)
    AND (hops.trip_base_secs + hops.from_departure_offset_secs)
        BETWEEN p_from_secs AND p_from_secs + p_window_secs
$$;

-- Vecinos de una parada: la consulta que consumirá algoritmo-ruteo (Fase 3)
-- para expandir un nodo del grafo. Une las 3 clases de arista del brief que
-- dependen de tiempo/parada (ride, transbordo) + caminata (no depende de
-- tiempo, es estática). NO incluye tramo ciclista como arista de "viaje"
-- porque Ecobici no tiene rutas fijas: la disponibilidad de bicis/docks es
-- responsabilidad de algoritmo-ruteo consultando ecobici_snapshots en el
-- momento del request, no de este grafo estático.
CREATE OR REPLACE FUNCTION graph_stop_neighbors(
  p_stop_id TEXT,
  p_service_date DATE,
  p_from_secs INTEGER,
  p_window_secs INTEGER DEFAULT 1800
) RETURNS TABLE (
  edge_type TEXT,
  to_node_type TEXT,
  to_node_id TEXT,
  trip_id TEXT,
  route_id TEXT,
  depart_secs INTEGER,
  arrive_secs INTEGER,
  distance_meters DOUBLE PRECISION
) LANGUAGE sql STABLE AS $$
  SELECT 'ride', 'gtfs_stop', d.to_stop_id, d.trip_id, d.route_id, d.depart_secs, d.arrive_secs, NULL::DOUBLE PRECISION
  FROM graph_ride_departures(p_stop_id, p_service_date, p_from_secs, p_window_secs) d

  UNION ALL

  SELECT 'transfer', 'gtfs_stop', tr.to_stop_id, NULL, NULL,
         NULL::INTEGER, tr.min_transfer_time_secs, NULL::DOUBLE PRECISION
  FROM transfer_overrides tr
  WHERE tr.from_stop_id = p_stop_id AND tr.is_active

  UNION ALL

  SELECT 'walk', w.to_node_type, w.to_node_id, NULL, NULL,
         NULL::INTEGER, NULL::INTEGER, w.distance_meters
  FROM walk_edges w
  WHERE w.from_node_type = 'gtfs_stop' AND w.from_node_id = p_stop_id
$$;
