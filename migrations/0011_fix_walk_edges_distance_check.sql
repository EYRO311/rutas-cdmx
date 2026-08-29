-- Corrección encontrada corriendo scripts/graph/build-walk-edges.ts por
-- primera vez: hay pares de stop_id distintos (de agencias distintas, ej.
-- B_COREV1-RICARCASTRO / B_05121A0-RICARDCASTRO) en las MISMAS coordenadas
-- exactas -- la misma esquina física servida por dos sistemas con IDs GTFS
-- separados. distance_meters = 0 es un dato legítimo (transbordo
-- inmediato), no un error; el CHECK original (> 0) lo rechazaba.
ALTER TABLE walk_edges DROP CONSTRAINT walk_edges_distance_meters_check;
ALTER TABLE walk_edges ADD CONSTRAINT walk_edges_distance_meters_check
  CHECK (distance_meters >= 0);
