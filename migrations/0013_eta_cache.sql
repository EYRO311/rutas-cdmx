-- Cache de ETA de modo AUTO por (origen, destino, ventana de 15 min),
-- persistida en Postgres a propósito -- NO en memoria de proceso. En
-- serverless (Vercel, CLAUDE.md decisión #6) cada invocación puede
-- arrancar en frío sin nada de lo que la anterior tenía en RAM: un cache
-- en un Map de JS no cachea nada en la práctica entre requests reales.
-- Ver src/modes/auto/eta-cache.ts para el bucketing de tiempo (redondeo a
-- ventanas de 15 min) y de coordenadas (5 decimales) -- esa lógica vive en
-- TypeScript, no aquí, para poder probarla sin Postgres.
--
-- Restricción de licencia de Google Maps Platform (detalle completo en
-- docs/handoff/04-auto.md): los Términos de Servicio de Maps Platform
-- prohíben pre-fetch/cache/storage de "Content" salvo excepciones
-- explícitas (lat/lng hasta 30 días, place_id indefinidamente). La
-- duración/ETA de una ruta no cae claramente en esa excepción de
-- geocodes. Por eso el TTL efectivo aquí es de 15 minutos (muy por debajo
-- de cualquier límite de los Términos) y este diseño se documenta como
-- aceptable solo para uso personal de un único usuario beta (CLAUDE.md
-- decisión #4) -- si esta API se abre a terceros, revisar contra los
-- Términos vigentes en ese momento antes de reusar esta tabla tal cual.
CREATE TABLE IF NOT EXISTS eta_cache (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google-routes', 'osrm')),
  origin_lat DOUBLE PRECISION NOT NULL,
  origin_lon DOUBLE PRECISION NOT NULL,
  destination_lat DOUBLE PRECISION NOT NULL,
  destination_lon DOUBLE PRECISION NOT NULL,
  -- Ventana de 15 minutos a la que pertenece la salida planeada del
  -- request original, ya truncada por la aplicación (no por SQL).
  window_start TIMESTAMPTZ NOT NULL,
  duration_secs INTEGER NOT NULL CHECK (duration_secs > 0),
  static_duration_secs INTEGER,
  distance_meters INTEGER NOT NULL CHECK (distance_meters >= 0),
  polyline TEXT,
  toll_mxn DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, origin_lat, origin_lon, destination_lat, destination_lon, window_start)
);

-- No hay índice extra además del que ya crea el UNIQUE de arriba: el
-- lookup de eta-cache.ts filtra exactamente por esas 6 columnas, así que
-- el índice del constraint único ya cubre la consulta caliente.

-- Sin purga automática de filas viejas en esta fase (uso personal, volumen
-- bajo: un usuario, rutas repetidas). Si esto crece o se abre a terceros,
-- hace falta un job que borre filas con window_start más viejo que N días
-- -- pendiente explícito, no resuelto aquí.
