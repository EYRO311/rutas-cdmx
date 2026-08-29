-- Tabla genérica de datos crudos. Regla dura del agente datos-gtfs:
-- "Todo dato crudo se conserva en tabla _raw antes de normalizar."
--
-- Una sola tabla genérica (en vez de una tabla _raw por archivo GTFS) para no
-- multiplicar DDL: cada fila cruda de cada archivo fuente se guarda como JSONB
-- con su origen y su número de fila. Sirve tanto para GTFS estático (un row
-- por línea de cada .txt) como para snapshots de feeds (GBFS, GTFS-RT).
CREATE TABLE IF NOT EXISTS _raw (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,        -- p.ej. 'cdmx-gtfs', 'ecobici-gbfs', 'metrobus-gtfs-rt'
  file_name TEXT NOT NULL,     -- p.ej. 'stops.txt', 'station_status.json'
  row_number INTEGER,          -- posición dentro del archivo fuente (NULL si no aplica)
  row_data JSONB NOT NULL,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS _raw_source_file_idx ON _raw (source, file_name);
