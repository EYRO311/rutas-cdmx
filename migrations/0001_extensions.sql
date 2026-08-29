-- PostGIS ya viene habilitado en la imagen postgis/postgis usada en local,
-- pero lo declaramos explícito e idempotente para que la migración funcione
-- igual en Supabase (producción) donde hay que habilitarlo a mano.
CREATE EXTENSION IF NOT EXISTS postgis;
