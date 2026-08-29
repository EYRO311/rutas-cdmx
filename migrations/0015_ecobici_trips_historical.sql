-- Entregable agregado (2026-08-22): histórico real de viajes Ecobici.
-- Fuente: CSV mensual de "datos abiertos" publicado por Ecobici CDMX
-- (ecobici.cdmx.gob.mx/wp-content/uploads/...), NO el GBFS en vivo que ya
-- se usa en ecobici_stations/ecobici_snapshots (ese no trae duración de
-- viaje). Ver docs/handoff/01-datos.md sección nueva para el detalle.
--
-- start_station_id / end_station_id son NULLABLE y SIN foreign key: la
-- fuente trae códigos de estación "sucios" (compuestos tipo "266-267",
-- literal "Temporal 1/2/3", o estaciones ya dadas de baja que no existen
-- en el snapshot actual de ecobici_stations). Forzar una FK habría hecho
-- fallar la carga completa por un porcentaje minoritario de filas sucias.
-- En su lugar: el valor crudo siempre se conserva en *_station_raw, y la
-- columna normalizada solo se llena cuando el id resuelve a una fila real
-- y vigente de ecobici_stations (regla dura del agente: no inventar datos).
CREATE TABLE IF NOT EXISTS ecobici_trips_historical (
  id BIGSERIAL PRIMARY KEY,
  source_file TEXT NOT NULL,
  bike_id TEXT,
  user_gender TEXT,
  user_age SMALLINT,
  start_station_raw TEXT NOT NULL,
  start_station_id TEXT REFERENCES ecobici_stations (station_id),
  start_at TIMESTAMP NOT NULL,
  end_station_raw TEXT NOT NULL,
  end_station_id TEXT REFERENCES ecobici_stations (station_id),
  end_at TIMESTAMP NOT NULL,
  duration_seconds INTEGER NOT NULL,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ecobici_trips_historical_source_file_idx
  ON ecobici_trips_historical (source_file);
CREATE INDEX IF NOT EXISTS ecobici_trips_historical_stations_idx
  ON ecobici_trips_historical (start_station_id, end_station_id);

-- Tabla pequeña de resultado: lo que consume modelo-grafo para las aristas
-- de bici. Se guarda como serie histórica (una fila por corrida de
-- cómputo, no upsert de una sola fila) para poder comparar si el cálculo
-- cambia cuando se agreguen más meses en el futuro, igual que
-- ecobici_snapshots es serie de tiempo y no un solo estado.
CREATE TABLE IF NOT EXISTS ecobici_speed_stats (
  id SERIAL PRIMARY KEY,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_months TEXT NOT NULL,
  sample_size_total INTEGER NOT NULL,
  sample_size_used INTEGER NOT NULL,
  avg_speed_mps DOUBLE PRECISION NOT NULL,
  median_speed_mps DOUBLE PRECISION,
  stddev_speed_mps DOUBLE PRECISION,
  min_duration_threshold_s INTEGER NOT NULL,
  max_duration_threshold_s INTEGER NOT NULL,
  min_distance_threshold_m DOUBLE PRECISION NOT NULL,
  notes TEXT
);
