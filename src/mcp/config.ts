/**
 * Configuración del servidor MCP. Todo por variable de entorno -- este
 * proceso es stateless entre invocaciones (Vercel serverless, ver
 * docs/handoff/06-mcp.md), así que no hay archivo de config propio que
 * leer en disco en producción.
 *
 * `RUTAS_API_URL`/`RUTAS_API_KEY`: cómo llega este servidor MCP a la API
 * HTTP real (`src/api/`) -- el envoltorio que es este agente NUNCA importa
 * código de `src/api/routes/*` directamente para calcular_ruta,
 * paradas_cercanas o registrar_viaje: siempre HTTP real, igual que
 * cualquier otro consumidor de la API.
 *
 * `DATABASE_URL`: reutilizada tal cual la usa el resto del proyecto
 * (mismo Postgres local puerto 5433 / mismo pooler de Supabase en
 * producción). Se usa SOLO para las dos cosas que hoy no tienen ningún
 * endpoint HTTP (`estado_ecobici` sobre `ecobici_stations`/
 * `ecobici_snapshots`, y resolver nombres de `saved_places` como "casa"/
 * "ESCOM") -- ver docs/handoff/06-mcp.md sección "Decisiones" para el
 * porqué de cada una. Nunca se usa para nada que ya tenga un endpoint
 * HTTP real (routes, stops/near, trips, modes).
 */
export interface McpConfig {
  apiBaseUrl: string;
  apiKey: string | undefined;
  databaseUrl: string | undefined;
  requestTimeoutMs: number;
}

export function loadConfig(): McpConfig {
  return {
    apiBaseUrl: (process.env["RUTAS_API_URL"] ?? "http://localhost:3000").replace(/\/+$/, ""),
    apiKey: process.env["RUTAS_API_KEY"] ?? process.env["API_KEY"],
    databaseUrl: process.env["DATABASE_URL"],
    requestTimeoutMs: Number(process.env["RUTAS_MCP_TIMEOUT_MS"] ?? 8000),
  };
}
