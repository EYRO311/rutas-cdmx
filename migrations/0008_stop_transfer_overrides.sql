-- Tablas propias de modelo-grafo (Fase 2), pendientes desde Fase 1 (ver
-- docs/handoff/01-datos.md, sección 5, punto 14, y CLAUDE.md decisión #5:
-- "overrides desde el día uno, porque el GTFS miente").
--
-- transfers.txt vino vacío de la fuente (0 filas) y stop_times.stop_id
-- referencia paradas cuya posición real a veces no coincide con GTFS
-- (parkeos, entradas cerradas, etc.). Estas dos tablas son el mecanismo de
-- corrección manual que consume el resto del sistema.

-- Corrección manual a una parada del GTFS. Se guarda como historial (varias
-- filas por stop_id posibles) en vez de UPDATE in-place para no perder el
-- valor original de GTFS ni el motivo del cambio; is_active + el índice
-- único parcial garantizan que a lo más una corrección esté vigente por
-- parada a la vez.
CREATE TABLE IF NOT EXISTS stop_overrides (
  id BIGSERIAL PRIMARY KEY,
  stop_id TEXT NOT NULL REFERENCES stops (stop_id),
  override_lat DOUBLE PRECISION,
  override_lon DOUBLE PRECISION,
  override_name TEXT,
  override_wheelchair_boarding SMALLINT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS stop_overrides_stop_id_idx ON stop_overrides (stop_id);

-- A lo más una corrección activa por parada.
CREATE UNIQUE INDEX IF NOT EXISTS stop_overrides_one_active_per_stop
  ON stop_overrides (stop_id)
  WHERE is_active;

-- Transbordos manuales. Mismo shape conceptual que GTFS transfers.txt
-- (transfer_type sigue la semántica del spec: 0 recomendado, 1 con tiempo
-- mínimo garantizado, 2 requiere min_transfer_time_secs, 3 no es posible)
-- pero con is_active + reason + auditoría porque, a diferencia del GTFS
-- estático, esta tabla se edita a mano y tiene que ser rastreable.
CREATE TABLE IF NOT EXISTS transfer_overrides (
  id BIGSERIAL PRIMARY KEY,
  from_stop_id TEXT NOT NULL REFERENCES stops (stop_id),
  to_stop_id TEXT NOT NULL REFERENCES stops (stop_id),
  transfer_type SMALLINT NOT NULL DEFAULT 2,
  min_transfer_time_secs INTEGER,
  is_walk_required BOOLEAN NOT NULL DEFAULT true,
  reason TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  CONSTRAINT transfer_overrides_no_self_loop CHECK (from_stop_id <> to_stop_id)
);

CREATE INDEX IF NOT EXISTS transfer_overrides_from_stop_idx
  ON transfer_overrides (from_stop_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS transfer_overrides_to_stop_idx
  ON transfer_overrides (to_stop_id) WHERE is_active;

-- A lo más un override activo por par ordenado (from, to). El transbordo
-- puede ser asimétrico (tiempo distinto por dirección), así que NO se
-- fuerza from < to.
CREATE UNIQUE INDEX IF NOT EXISTS transfer_overrides_one_active_per_pair
  ON transfer_overrides (from_stop_id, to_stop_id)
  WHERE is_active;
