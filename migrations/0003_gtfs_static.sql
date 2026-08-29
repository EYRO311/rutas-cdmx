-- Tablas GTFS estático normalizadas. Nombres y columnas siguen el spec GTFS
-- (https://gtfs.org/schedule/reference/) para que cualquier herramienta o
-- agente que ya conozca GTFS no tenga que reaprender nombres.
--
-- Nota sobre horarios: GTFS permite horas >= 24:00:00 para servicio que cruza
-- medianoche (ej. "29:00:00" en frequencies.txt de esta fuente). El tipo TIME
-- de Postgres no soporta eso, así que arrival_time/departure_time/start_time/
-- end_time se guardan en dos formas: el texto crudo tal cual viene en la
-- fuente (arrival_time) y los segundos desde medianoche del día de servicio
-- ya calculados (arrival_time_secs), que es lo que un motor de ruteo va a
-- querer usar directamente.

CREATE TABLE IF NOT EXISTS agency (
  agency_id TEXT PRIMARY KEY,
  agency_name TEXT NOT NULL,
  agency_url TEXT,
  agency_timezone TEXT,
  agency_lang TEXT
);

CREATE TABLE IF NOT EXISTS calendar (
  service_id TEXT PRIMARY KEY,
  monday BOOLEAN NOT NULL,
  tuesday BOOLEAN NOT NULL,
  wednesday BOOLEAN NOT NULL,
  thursday BOOLEAN NOT NULL,
  friday BOOLEAN NOT NULL,
  saturday BOOLEAN NOT NULL,
  sunday BOOLEAN NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL
);

-- La fuente actual (cdmx-gtfs) NO trae calendar_dates.txt. La tabla se crea
-- de todas formas porque es parte del contrato GTFS y algún día puede haber
-- una fuente que sí la traiga. Sin FK a calendar: el spec GTFS permite que
-- calendar_dates defina un service_id que no exista en calendar.txt.
CREATE TABLE IF NOT EXISTS calendar_dates (
  service_id TEXT NOT NULL,
  date DATE NOT NULL,
  exception_type SMALLINT NOT NULL,
  PRIMARY KEY (service_id, date)
);

CREATE TABLE IF NOT EXISTS routes (
  route_id TEXT PRIMARY KEY,
  agency_id TEXT REFERENCES agency (agency_id),
  route_short_name TEXT,
  route_long_name TEXT,
  route_type INTEGER NOT NULL,
  route_color TEXT,
  route_text_color TEXT
);

CREATE INDEX IF NOT EXISTS routes_agency_id_idx ON routes (agency_id);

CREATE TABLE IF NOT EXISTS stops (
  stop_id TEXT PRIMARY KEY,
  stop_name TEXT NOT NULL,
  stop_lat DOUBLE PRECISION NOT NULL,
  stop_lon DOUBLE PRECISION NOT NULL,
  zone_id TEXT,
  wheelchair_boarding SMALLINT,
  geom geometry(Point, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS stops_geom_gix ON stops USING GIST (geom);

CREATE TABLE IF NOT EXISTS shapes (
  shape_id TEXT NOT NULL,
  shape_pt_sequence INTEGER NOT NULL,
  shape_pt_lat DOUBLE PRECISION NOT NULL,
  shape_pt_lon DOUBLE PRECISION NOT NULL,
  shape_dist_traveled DOUBLE PRECISION,
  geom geometry(Point, 4326) NOT NULL,
  PRIMARY KEY (shape_id, shape_pt_sequence)
);

CREATE INDEX IF NOT EXISTS shapes_shape_id_idx ON shapes (shape_id);
CREATE INDEX IF NOT EXISTS shapes_geom_gix ON shapes USING GIST (geom);

CREATE TABLE IF NOT EXISTS trips (
  trip_id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes (route_id),
  service_id TEXT NOT NULL REFERENCES calendar (service_id),
  shape_id TEXT,
  trip_headsign TEXT,
  trip_short_name TEXT,
  direction_id SMALLINT
);

CREATE INDEX IF NOT EXISTS trips_route_id_idx ON trips (route_id);
CREATE INDEX IF NOT EXISTS trips_service_id_idx ON trips (service_id);
CREATE INDEX IF NOT EXISTS trips_shape_id_idx ON trips (shape_id);

CREATE TABLE IF NOT EXISTS stop_times (
  trip_id TEXT NOT NULL REFERENCES trips (trip_id),
  stop_sequence INTEGER NOT NULL,
  stop_id TEXT NOT NULL REFERENCES stops (stop_id),
  arrival_time TEXT,
  arrival_time_secs INTEGER,
  departure_time TEXT,
  departure_time_secs INTEGER,
  timepoint SMALLINT,
  PRIMARY KEY (trip_id, stop_sequence)
);

CREATE INDEX IF NOT EXISTS stop_times_stop_id_idx ON stop_times (stop_id);

CREATE TABLE IF NOT EXISTS frequencies (
  trip_id TEXT NOT NULL REFERENCES trips (trip_id),
  start_time TEXT NOT NULL,
  start_time_secs INTEGER NOT NULL,
  end_time TEXT NOT NULL,
  end_time_secs INTEGER NOT NULL,
  headway_secs INTEGER NOT NULL,
  exact_times SMALLINT,
  PRIMARY KEY (trip_id, start_time)
);

CREATE INDEX IF NOT EXISTS frequencies_trip_id_idx ON frequencies (trip_id);

-- La fuente actual NO trae transfers.txt. Tabla vacía a la espera de una
-- fuente que la traiga o de que transfer_overrides la alimente manualmente.
CREATE TABLE IF NOT EXISTS transfers (
  from_stop_id TEXT NOT NULL REFERENCES stops (stop_id),
  to_stop_id TEXT NOT NULL REFERENCES stops (stop_id),
  transfer_type SMALLINT,
  min_transfer_time INTEGER,
  PRIMARY KEY (from_stop_id, to_stop_id)
);
