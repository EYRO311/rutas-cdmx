-- Almacenamiento para GTFS-RT de Metrobús. El parser (scripts/gtfs-rt/) está
-- escrito y probado con datos sintéticos, pero el token de
-- metrobus-gtfs.sinopticoplus.com sigue pendiente de registro (ver
-- docs/handoff/01-datos.md), así que estas tablas nunca se han llenado con
-- datos reales todavía.

CREATE TABLE IF NOT EXISTS metrobus_vehicle_positions (
  id BIGSERIAL PRIMARY KEY,
  vehicle_id TEXT,
  trip_id TEXT,
  route_id TEXT,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  bearing REAL,
  speed REAL,
  current_stop_sequence INTEGER,
  vehicle_timestamp TIMESTAMPTZ,
  geom geometry(Point, 4326),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS metrobus_vehicle_positions_geom_gix
  ON metrobus_vehicle_positions USING GIST (geom);
CREATE INDEX IF NOT EXISTS metrobus_vehicle_positions_trip_idx
  ON metrobus_vehicle_positions (trip_id);

CREATE TABLE IF NOT EXISTS metrobus_trip_updates (
  id BIGSERIAL PRIMARY KEY,
  trip_id TEXT,
  route_id TEXT,
  stop_id TEXT,
  stop_sequence INTEGER,
  arrival_delay_secs INTEGER,
  arrival_time TIMESTAMPTZ,
  departure_delay_secs INTEGER,
  departure_time TIMESTAMPTZ,
  schedule_relationship TEXT,
  update_timestamp TIMESTAMPTZ,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS metrobus_trip_updates_trip_idx
  ON metrobus_trip_updates (trip_id);
