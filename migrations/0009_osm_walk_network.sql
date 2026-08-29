-- Red peatonal/ciclista de OSM (insumo crudo de Fase 1, ver
-- docs/handoff/01-datos.md sección 1.4 y 6: "modelo-grafo decide cómo
-- modelarlo"). Se carga tal cual (way/node de Overpass) para que quede
-- consultable espacialmente y disponible para un refinamiento futuro de
-- walk_edges (routing sobre la red real, no solo línea recta). Poblar estas
-- dos tablas es trabajo de scripts/osm/load-to-postgres.ts (Fase 2), no de
-- esta migración.
CREATE TABLE IF NOT EXISTS osm_nodes (
  osm_id BIGINT PRIMARY KEY,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  geom geometry(Point, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS osm_nodes_geom_gix ON osm_nodes USING GIST (geom);

CREATE TABLE IF NOT EXISTS osm_ways (
  osm_id BIGINT PRIMARY KEY,
  highway TEXT,
  name TEXT,
  tags JSONB NOT NULL,
  node_ids BIGINT[] NOT NULL,
  length_meters DOUBLE PRECISION,
  geom geometry(LineString, 4326)
);

CREATE INDEX IF NOT EXISTS osm_ways_geom_gix ON osm_ways USING GIST (geom);
CREATE INDEX IF NOT EXISTS osm_ways_highway_idx ON osm_ways (highway);

-- Aristas de caminata precalculadas entre "puntos de acceso" al grafo
-- (paradas GTFS y estaciones Ecobici) a radio 400m. Modo-agnóstica a
-- propósito: guarda distancia, no tiempo. El tiempo se deriva en tiempo de
-- consulta multiplicando por la velocidad de caminata/ciclismo de
-- user_preferences — así una arista sirve tanto para "caminar entre dos
-- paradas" como para "caminar hacia una estación de Ecobici" sin duplicar
-- filas por modo.
--
-- Ambos sentidos se guardan como filas independientes (from->to y to->from)
-- para que la consulta de vecinos de una parada sea un filtro directo por
-- from_node_id sin necesitar OR ni UNION.
CREATE TABLE IF NOT EXISTS walk_edges (
  id BIGSERIAL PRIMARY KEY,
  from_node_type TEXT NOT NULL CHECK (from_node_type IN ('gtfs_stop', 'ecobici_station')),
  from_node_id TEXT NOT NULL,
  to_node_type TEXT NOT NULL CHECK (to_node_type IN ('gtfs_stop', 'ecobici_station')),
  to_node_id TEXT NOT NULL,
  distance_meters DOUBLE PRECISION NOT NULL CHECK (distance_meters > 0),
  is_network_distance BOOLEAN NOT NULL DEFAULT false,
  geom geometry(LineString, 4326),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT walk_edges_no_self_loop CHECK (
    NOT (from_node_type = to_node_type AND from_node_id = to_node_id)
  )
);

-- La consulta caliente es "dame los vecinos de este nodo": índice compuesto
-- cubriente por el lado from_*. Simétrico del lado to_* por si algún
-- consumidor necesita "quién puede llegar caminando a X" sin escanear todo.
CREATE INDEX IF NOT EXISTS walk_edges_from_idx ON walk_edges (from_node_type, from_node_id);
CREATE INDEX IF NOT EXISTS walk_edges_to_idx ON walk_edges (to_node_type, to_node_id);
CREATE INDEX IF NOT EXISTS walk_edges_geom_gix ON walk_edges USING GIST (geom);

-- Evita duplicar la misma arista dirigida si el script de precómputo se
-- vuelve a correr.
CREATE UNIQUE INDEX IF NOT EXISTS walk_edges_unique_directed_pair
  ON walk_edges (from_node_type, from_node_id, to_node_type, to_node_id);
