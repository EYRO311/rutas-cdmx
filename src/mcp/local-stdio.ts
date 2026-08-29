#!/usr/bin/env node
/**
 * Entrypoint local por stdio -- para conectar este servidor MCP a un
 * cliente de escritorio (Claude Desktop, Claude Code, etc.) durante
 * desarrollo, sin pasar por Vercel. `npm run mcp:stdio`.
 *
 * Requiere las mismas variables de entorno que la API HTTP
 * (`RUTAS_API_URL`, `RUTAS_API_KEY`, `DATABASE_URL`) -- ver
 * docs/handoff/06-mcp.md para el instructivo completo de conexión.
 */
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./server.js";

async function main(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error("[mcp-asistente] servidor MCP conectado por stdio.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[mcp-asistente] error fatal:", err);
  process.exit(1);
});
