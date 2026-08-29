/**
 * Factory del servidor MCP. Un `McpServer` NUEVO por invocación en el
 * entrypoint serverless (`api/mcp.ts`) -- no hay estado de conversación ni
 * resultados de ambigüedad guardados en memoria de proceso (brief: "es
 * stateless entre invocaciones... si una herramienta necesita recordar
 * algo entre llamadas, eso lo sostiene el asistente que llama al MCP, no
 * el servidor"). El entrypoint local (`src/mcp/local-stdio.ts`) construye
 * uno también, para una sesión larga por stdio -- da igual, cada llamada a
 * una tool sigue sin depender de una llamada anterior.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCalcularRuta } from "./tools/calcular-ruta.js";
import { registerParadasCercanas } from "./tools/paradas-cercanas.js";
import { registerRegistrarViaje } from "./tools/registrar-viaje.js";
import { registerEstadoEcobici } from "./tools/estado-ecobici.js";
import { registerPuedeCircularHoy } from "./tools/puede-circular-hoy.js";

export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "rutas-cdmx",
    version: "1.0.0",
  });

  registerCalcularRuta(server);
  registerParadasCercanas(server);
  registerRegistrarViaje(server);
  registerEstadoEcobici(server);
  registerPuedeCircularHoy(server);

  return server;
}
