/**
 * Valida `generated/openapi.json` (generado por `npm run openapi:generate`)
 * contra el JSON Schema oficial de OpenAPI 3.1 usando
 * @seriousme/openapi-schema-validator. Falla (exit 1) si el documento no
 * es un OpenAPI 3.1 válido -- criterio de terminado de este agente
 * (.claude/agents/api-http.md: "La spec OpenAPI valida").
 */
import { Validator } from "@seriousme/openapi-schema-validator";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.resolve(__dirname, "..", "generated", "openapi.json");

async function main(): Promise<void> {
  const validator = new Validator();
  const result = await validator.validate(SPEC_PATH);

  if (!result.valid) {
    console.error("[openapi:validate] La spec NO es válida:");
    console.error(JSON.stringify(result.errors, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(`[openapi:validate] OK -- válida como OpenAPI ${validator.version}.`);
}

main().catch((err) => {
  console.error("[openapi:validate] ERROR:", err);
  process.exitCode = 1;
});
