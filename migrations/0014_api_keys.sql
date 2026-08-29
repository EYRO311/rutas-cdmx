-- API keys para autenticar la capa HTTP (.claude/agents/api-http.md,
-- regla dura: "Auth por API key desde el día uno, aunque el único usuario
-- seas tú"). Runner propio (scripts/migrate.ts), no `prisma migrate` --
-- ver CLAUDE.md / docs/handoff/02-grafo.md sección 1 para el porqué.
--
-- Se guarda el hash SHA-256 (hex) de la key, nunca el valor en claro: si
-- esta tabla se filtra, las keys no son reutilizables directamente. El
-- valor en claro solo existe una vez, en el momento en que se genera
-- (scripts/seed-api-key.ts imprime la key por stdout); no se persiste en
-- ningún otro lado del repo.
--
-- user_id es TEXT libre sin FK, igual que el resto de las tablas de
-- usuario de Fase 2 (docs/handoff/02-grafo.md sección 3.4) -- no existe
-- todavía un sistema de cuentas. NULL = key "de servicio" sin dueño
-- explícito (ej. el asistente MCP, un job).
--
-- Deliberadamente esta tabla NO se agrega a prisma/schema.prisma (no se
-- corre `prisma db pull` / `prisma generate` después de esta migración):
-- esta fase corre en paralelo con algoritmo-ruteo y modo-auto, que pueden
-- estar corriendo sus propias migraciones al mismo tiempo -- reintrospeccionar
-- y regenerar el cliente completo arriesga pisar (o pelearse por) cambios
-- que ellos metan al mismo prisma/schema.prisma mientras tanto. La capa
-- HTTP consulta esta tabla con `$queryRaw`/`$executeRaw` desde
-- src/api/db/prisma.ts, el mismo patrón que el proyecto ya usa para
-- columnas `geometry` que Prisma tampoco puede tipar.
CREATE TABLE IF NOT EXISTS api_keys (
  id BIGSERIAL PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  user_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys (user_id);
