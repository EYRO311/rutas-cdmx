-- Ecobici (GBFS). station_information cambia poco (se upsertea), station_status
-- es la serie de tiempo que alimenta el snapshot cada 5 min desde GitHub Actions.

CREATE TABLE IF NOT EXISTS ecobici_stations (
  station_id TEXT PRIMARY KEY,
  name TEXT,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  capacity INTEGER,
  geom geometry(Point, 4326),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ecobici_stations_geom_gix ON ecobici_stations USING GIST (geom);

CREATE TABLE IF NOT EXISTS ecobici_snapshots (
  id BIGSERIAL PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES ecobici_stations (station_id),
  num_bikes_available INTEGER,
  num_docks_available INTEGER,
  is_renting BOOLEAN,
  is_returning BOOLEAN,
  last_reported TIMESTAMPTZ,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ecobici_snapshots_station_captured_idx
  ON ecobici_snapshots (station_id, captured_at);
