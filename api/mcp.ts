/**
 * Handler serverless de Vercel para el servidor MCP (`src/mcp/`).
 * Vercel enruta `/api/mcp` a esta función (ver vercel.json: se agregó una
 * regla específica para `/mcp` ANTES del catch-all que ya usaba
 * `api/index.ts`, para no interceptar este path).
 *
 * Transporte Streamable HTTP en modo STATELESS (`sessionIdGenerator:
 * undefined`) -- no session tracking, cada request HTTP es independiente,
 * coherente con la regla dura del brief ("es stateless entre
 * invocaciones... si una herramienta necesita recordar algo entre
 * llamadas, eso lo sostiene el asistente que llama al MCP, no el
 * servidor") y con CLAUDE.md decisión #7 (sin estado de proceso entre
 * invocaciones serverless). Se crea un `McpServer` + transporte NUEVOS
 * por request (no un singleton a nivel de módulo, a diferencia de
 * `api/index.ts`/`buildApp()`) porque el ejemplo oficial del SDK
 * (`simpleStatelessStreamableHttp.ts`) documenta que un transporte
 * stateless no debe compartirse entre requests concurrentes -- construir
 * uno por request es barato (no toca Postgres hasta que una tool
 * realmente lo necesita).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildMcpServer } from "../src/mcp/server.js";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. Este endpoint MCP solo acepta POST (Streamable HTTP)." },
        id: null,
      })
    );
    return;
  }

  const server = buildMcpServer();
  try {
    // `sessionIdGenerator` se omite (no se manda `undefined` explícito) porque
    // `exactOptionalPropertyTypes` (tsconfig.json) no acepta `undefined` como
    // valor de una propiedad opcional tipada sin `| undefined` -- omitir la
    // clave logra exactamente el mismo modo stateless (ver
    // WebStandardStreamableHTTPServerTransportOptions.sessionIdGenerator,
    // que ya es opcional y no tiene default distinto de "sin generador").
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => {
      transport.close();
      server.close();
    });
    // El cast es puramente de tipos: `StreamableHTTPServerTransport` es un
    // `Transport` real en runtime. La incompatibilidad que reporta `tsc`
    // (getter/setter de `onclose`/`onerror` con `| undefined` vs sin él) es
    // fricción conocida entre `exactOptionalPropertyTypes: true` (deliberado
    // en este repo) y cómo el SDK de MCP declara esos accessors -- mismo tipo
    // de fricción que ya existe en `prisma.config.ts` con otra librería
    // externa, no algo introducido por este archivo.
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[mcp-asistente] error manejando request MCP:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null })
      );
    }
  }
}
