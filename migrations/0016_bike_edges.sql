-- Entregable agregado (2026-08-22): aristas reales de bici (Ecobici).
-- Hasta ahora "tramo ciclista" en el grafo (docs/handoff/02-grafo.md
-- sección 2) solo modelaba caminar hacia/desde una estación via walk_edges
-- -- nunca el trayecto pedaleado entre dos estaciones. Con datos-gtfs
-- habiendo calculado velocidad real medida (ecobici_speed_stats, ver
-- docs/handoff/01-datos.md sección 7), ahora sí se modela el tramo
-- completo.
--
-- Radio: 5,000m (ver docs/handoff/02-grafo.md sección nueva para la
-- evidencia real de conteos a distintos radios y de percentiles de
-- distancia de viajes reales que justifican este número -- no es el
-- radio de 400m de walk_edges, que es para CAMINAR, no para pedalear).
--
-- Distancia: geodésica en línea recta (ST_Distance sobre geography) x
-- WALK_CIRCUITY_FACTOR (1.3, la MISMA constante que ya usa
-- scripts/graph/build-walk-edges.ts para estimar distancia real de
-- caminata a partir de línea recta) -- reutilizada aquí para estimar la
-- distancia real de CALLE del tramo en bici entre dos estaciones nuevas,
-- nunca antes calculada. is_network_distance = false en todas las filas
-- (misma limitación que walk_edges: no hay pgRouting disponible, ver
-- docs/handoff/02-grafo.md sección 7 punto 1).
--
-- Tiempo: distance_meters (YA con el factor de circuidad aplicado arriba)
-- dividido entre speed_mps_used, que es media_speed_mps de la fila más
-- reciente de ecobici_speed_stats -- NUNCA se le aplica un factor de
-- circuidad adicional a esa velocidad: esa velocidad ya se calculó con
-- distancia geodésica en línea recta / tiempo real medido, así que ya
-- neta la circuidad real de calle contra el tiempo real del lado
-- contrario (ver docs/handoff/01-datos.md sección 7.4 y el comentario de
-- cabecera de scripts/graph/build-bike-edges.ts para el detalle completo
-- de por qué aplicar el factor dos veces sería un error). speed_stat_id
-- referencia la fila exacta de ecobici_speed_stats usada, para
-- reproducibilidad si se agregan más meses de histórico en el futuro y el
-- número cambia.
--
-- Filtro de distancia mínima (100m): mismo umbral que ya usa
-- scripts/ecobici/compute-speed-stats.ts (MIN_DISTANCE_M) para excluir
-- pares de estaciones casi colocalizadas, donde el ruido de "línea recta
-- vs. calle real" domina cualquier señal -- reutilizado aquí por
-- consistencia, no un número nuevo inventado. Pares más cercanos que eso
-- ya están cubiertos por walk_edges (ecobici<->ecobici, radio 400m).
CREATE TABLE IF NOT EXISTS bike_edges (
  id BIGSERIAL PRIMARY KEY,
  from_station_id TEXT NOT NULL REFERENCES ecobici_stations (station_id),
  to_station_id TEXT NOT NULL REFERENCES ecobici_stations (station_id),
  distance_meters DOUBLE PRECISION NOT NULL CHECK (distance_meters > 0),
  duration_secs INTEGER NOT NULL CHECK (duration_secs > 0),
  speed_mps_used DOUBLE PRECISION NOT NULL,
  speed_stat_id INTEGER REFERENCES ecobici_speed_stats (id),
  is_network_distance BOOLEAN NOT NULL DEFAULT false,
  geom geometry(LineString, 4326),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bike_edges_no_self_loop CHECK (from_station_id <> to_station_id)
);

-- La consulta caliente es "dame los vecinos en bici de esta estación":
-- índice por from_station_id, simétrico del lado to_station_id por si
-- algún consumidor necesita el sentido inverso.
CREATE INDEX IF NOT EXISTS bike_edges_from_idx ON bike_edges (from_station_id);
CREATE INDEX IF NOT EXISTS bike_edges_to_idx ON bike_edges (to_station_id);
CREATE INDEX IF NOT EXISTS bike_edges_geom_gix ON bike_edges USING GIST (geom);

-- Evita duplicar la misma arista dirigida si el script de precómputo se
-- vuelve a correr (mismo patrón que walk_edges_unique_directed_pair).
CREATE UNIQUE INDEX IF NOT EXISTS bike_edges_unique_directed_pair
  ON bike_edges (from_station_id, to_station_id);

-- Gap exacto documentado por algoritmo-ruteo en
-- docs/handoff/03-algoritmo.md sección 8 punto 1: "graph_stop_neighbors
-- solo expande vecinos DESDE una parada GTFS, nunca desde una estación
-- Ecobici -- no hay forma de seguir explorando el grafo después de llegar
-- a una sin una función SQL adicional que el contrato actual no ofrece."
--
-- Se decidió una función NUEVA en vez de extender graph_stop_neighbors
-- porque su firma (p_service_date, p_from_secs, p_window_secs) existe
-- para expandir aristas que dependen de horario de servicio (ride) --
-- ninguna arista que sale de una estación Ecobici depende de eso (bike y
-- walk son estáticas, igual que ya lo es 'walk' en graph_stop_neighbors).
-- Forzar los mismos 4 parámetros a una función que no los usa habría sido
-- una firma engañosa. graph_bike_station_neighbors expande:
--   - 'bike': bike_edges, el tramo pedaleado real hacia otra estación.
--   - 'walk': walk_edges donde from_node_type = 'ecobici_station' --
--     acceso a pie hacia paradas GTFS u otras estaciones Ecobici cercanas
--     (ya existía en walk_edges desde Fase 2, sección 3.3, simplemente no
--     había ninguna función que lo expusiera partiendo de una estación).
-- No incluye 'ride'/'transfer': no tienen sentido partiendo de un nodo que
-- no es una parada de transporte.
--
-- Disponibilidad de bicis/docks: NO se filtra aquí (decisión ya tomada en
-- el handoff original de esta fase, ver docs/handoff/02-grafo.md sección
-- 2) -- se consulta ecobici_snapshots en tiempo de consulta, responsabilidad
-- de quien use esta función (algoritmo-ruteo).
CREATE OR REPLACE FUNCTION graph_bike_station_neighbors(
  p_station_id TEXT
) RETURNS TABLE (
  edge_type TEXT,
  to_node_type TEXT,
  to_node_id TEXT,
  distance_meters DOUBLE PRECISION,
  duration_secs INTEGER
) LANGUAGE sql STABLE AS $$
  SELECT 'bike', 'ecobici_station', b.to_station_id, b.distance_meters, b.duration_secs
  FROM bike_edges b
  WHERE b.from_station_id = p_station_id

  UNION ALL

  SELECT 'walk', w.to_node_type, w.to_node_id, w.distance_meters, NULL::INTEGER
  FROM walk_edges w
  WHERE w.from_node_type = 'ecobici_station' AND w.from_node_id = p_station_id
$$;
