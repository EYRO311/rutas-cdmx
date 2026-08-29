-- Mecanismo de corrección manual para `routes`, mismo patrón que
-- `stop_overrides`/`transfer_overrides` (migrations/0008), CLAUDE.md
-- decisión #5 ("overrides desde el día uno, porque el GTFS miente").
--
-- Resuelve el hallazgo abierto desde Fase 1 (docs/handoff/01-datos.md
-- sección 5 punto 1, sección 6): `routes.agency_id = 'SEMOVI'` para la
-- ruta `TR13` no existe en `agency.txt` (10 agencias declaradas, ninguna
-- 'SEMOVI') -- el FK se relajó en migrations/0007 en vez de adivinar el
-- valor, "no se corrigió el dato" a propósito. Evidencia real reunida
-- ahora para decidir esto (no una suposición nueva, las mismas 3 señales
-- ya apuntadas en la sección 6 del handoff, verificadas contra Postgres
-- real): TR13 tiene `route_type = 11` (Trolebús, GTFS Extended Route
-- Types, campo de la MISMA fuente -- no inferido del nombre) y
-- `route_short_name = '13'`, que encaja en la numeración real de las
-- otras 10 rutas TROLE confirmadas (short_name '1' a '10'). Afecta
-- exactamente 1 ruta y 1 trip -- blast radius mínimo.
CREATE TABLE IF NOT EXISTS route_overrides (
  id BIGSERIAL PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes (route_id),
  override_agency_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS route_overrides_route_id_idx ON route_overrides (route_id);

-- A lo más una corrección activa por ruta (mismo criterio que stop_overrides).
CREATE UNIQUE INDEX IF NOT EXISTS route_overrides_one_active_per_route
  ON route_overrides (route_id)
  WHERE is_active;

INSERT INTO route_overrides (route_id, override_agency_id, reason, created_by)
VALUES (
  'TR13',
  'TROLE',
  'agency_id original (SEMOVI) no existe en agency.txt. route_type=11 (Trolebús, campo real del feed) + route_short_name=13 consistente con la numeración de las otras 10 rutas TROLE (1-10) confirman que es una ruta real de Trolebús mal etiquetada, no un dato inventado.',
  'orquestador (docs/handoff/01-datos.md secciones 5.1 y 6)'
)
ON CONFLICT DO NOTHING;
