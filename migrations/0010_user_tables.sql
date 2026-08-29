-- Tablas propias de modelo-grafo orientadas al usuario. No existe todavía un
-- sistema de autenticación/usuarios en el proyecto (no es responsabilidad de
-- esta fase), así que user_id es un TEXT libre sin FK a una tabla `users` —
-- cuando exista auth (Fase 3+), quien la construya decide si migra esto a
-- una FK real. Por ahora "el usuario es el beta" (CLAUDE.md decisión #4) y
-- en la práctica hay un único usuario real.

-- Modos de transporte que el usuario tiene disponibles. AUTO es el único
-- modo con columnas propias porque .claude/agents/modelo-grafo.md las pide
-- explícitas (tiene_auto, rendimiento_km_l, costo_combustible,
-- tolerancia_estacionamiento, terminacion_placa, holograma, evita_casetas).
-- Quedan NULL para cualquier modo que no sea 'auto'.
CREATE TABLE IF NOT EXISTS user_modes (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  -- Específico de AUTO (CLAUDE.md decisión #3: AUTO es modo terminal, solo
  -- como ruta completa o primer tramo park & ride, nunca intercalado).
  tiene_auto BOOLEAN,
  rendimiento_km_l DOUBLE PRECISION,
  costo_combustible DOUBLE PRECISION,
  tolerancia_estacionamiento_min INTEGER,
  terminacion_placa SMALLINT CHECK (terminacion_placa BETWEEN 0 AND 9),
  holograma TEXT,
  evita_casetas BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, mode)
);

CREATE INDEX IF NOT EXISTS user_modes_user_id_idx ON user_modes (user_id);

-- Preferencias de ruteo del usuario. Deliberadamente NO se usan para
-- precalcular walk_edges/bike times (esas tablas guardan distancia, no
-- tiempo) para poder cambiar la velocidad de caminata sin recalcular nada.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  walking_speed_mps DOUBLE PRECISION NOT NULL DEFAULT 1.4,
  cycling_speed_mps DOUBLE PRECISION NOT NULL DEFAULT 4.2,
  max_transfers SMALLINT NOT NULL DEFAULT 3 CHECK (max_transfers >= 0),
  crowding_tolerance SMALLINT NOT NULL DEFAULT 3 CHECK (crowding_tolerance BETWEEN 1 AND 5),
  -- Pesos del trade-off tiempo vs costo. No se fuerza weight_time+weight_cost=1
  -- con un CHECK por precisión de punto flotante; algoritmo-ruteo normaliza.
  weight_time DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  weight_cost DOUBLE PRECISION NOT NULL DEFAULT 0.3,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lugares frecuentes del usuario (casa, ESCOM, trabajo, ...).
CREATE TABLE IF NOT EXISTS saved_places (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  geom geometry(Point, 4326) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, label)
);

CREATE INDEX IF NOT EXISTS saved_places_user_id_idx ON saved_places (user_id);
CREATE INDEX IF NOT EXISTS saved_places_geom_gix ON saved_places USING GIST (geom);

-- Viajes reales con tiempos medidos. Insumo del agente aprendizaje-beta
-- (Fase 5) — se documenta tal cual pide .claude/agents/modelo-grafo.md.
-- route_taken guarda el itinerario completo (tramos, modos, paradas) como
-- snapshot JSONB porque su forma exacta la define algoritmo-ruteo (Fase 3),
-- que todavía no existe; no tiene caso normalizarlo a tablas ahora.
CREATE TABLE IF NOT EXISTS trip_history (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  origin_lat DOUBLE PRECISION NOT NULL,
  origin_lon DOUBLE PRECISION NOT NULL,
  origin_geom geometry(Point, 4326) NOT NULL,
  destination_lat DOUBLE PRECISION NOT NULL,
  destination_lon DOUBLE PRECISION NOT NULL,
  destination_geom geometry(Point, 4326) NOT NULL,
  planned_departure_at TIMESTAMPTZ,
  actual_departure_at TIMESTAMPTZ,
  actual_arrival_at TIMESTAMPTZ,
  planned_duration_secs INTEGER,
  actual_duration_secs INTEGER,
  modes_used TEXT[],
  route_taken JSONB,
  user_rating SMALLINT CHECK (user_rating BETWEEN 1 AND 5),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_history_user_id_idx ON trip_history (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trip_history_origin_geom_gix ON trip_history USING GIST (origin_geom);
CREATE INDEX IF NOT EXISTS trip_history_destination_geom_gix ON trip_history USING GIST (destination_geom);
