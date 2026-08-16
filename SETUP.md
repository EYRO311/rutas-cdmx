# Arranque desde cero

Dos entornos, no los mezcles:
- **Local:** Docker, Postgres+PostGIS en el puerto **5433** (el 5432 lo ocupa un Postgres nativo de Windows en esta máquina).
- **Producción:** Supabase (Postgres/PostGIS gestionado) + Vercel (API HTTP y MCP, serverless) + GitHub Actions (ETL y cron de Ecobici).

## 1. Repo e infra base
```bash
mkdir rutas-cdmx && cd rutas-cdmx
git init
npm init -y
npm i -D typescript tsx @types/node vitest dotenv
npm i fastify zod @prisma/client protobufjs
npx tsc --init
npx prisma init --datasource-provider postgresql
```

**Prisma no carga `.env` solo.** Depende de `import "dotenv/config"` como primera línea de `prisma.config.ts`. No lo borres ni lo "limpies" en un refactor — sin eso Prisma no ve `DATABASE_URL` y falla en silencio o apunta a la URL equivocada.

## 2. Postgres con PostGIS (local)
**Ya está corriendo en esta máquina en el puerto 5433 — este paso ya está hecho, no hace falta repetirlo.** Se deja documentado por si hay que reinstalar desde cero:
```yaml
# docker-compose.yml
services:
  db:
    image: postgis/postgis:16-3.4
    environment:
      POSTGRES_DB: rutas_cdmx
      POSTGRES_PASSWORD: dev
    ports: ["5433:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes:
  pgdata:
```

```bash
docker compose up -d
```

## 3. Colocar los agentes
Copia la carpeta `.claude/` completa a la raíz del repo. Verifica con `/agents` en Claude Code.

## 4. .env
Ambos entornos van en el mismo archivo de ejemplo, comentados — nunca los dos activos a la vez.

```bash
# --- LOCAL (Docker, puerto 5433) ---
DATABASE_URL=postgresql://postgres:dev@localhost:5433/rutas_cdmx

# --- PRODUCCIÓN (Supabase — usar el pooler, no la conexión directa) ---
# DATABASE_URL=postgresql://<user>:<password>@<supabase-pooler-host>:6543/postgres?pgbouncer=true

GOOGLE_ROUTES_API_KEY=
METROBUS_GTFS_TOKEN=
API_KEY=
```

## 5. Primer commit antes de lanzar agentes
```bash
echo "node_modules/\n.env\n*.pbf\ndist/" > .gitignore
git add . && git commit -m "chore: scaffold + agentes"
```

Commitea **antes** del primer agente. Vas a querer poder revertir.

## 6. Lanzar la Fase 1
En Claude Code, desde la raíz del repo:
```
Actúa como el orquestador definido en CLAUDE.md. Lanza la Fase 1.
```
