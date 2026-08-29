/**
 * Confirma que el documento OpenAPI generado desde los schemas Zod (no
 * escrito a mano) es realista y válido como 3.1. La validación completa
 * contra el JSON Schema oficial vive en `npm run openapi:validate`
 * (usa @seriousme/openapi-schema-validator sobre generated/openapi.json);
 * aquí se prueba en proceso, sin depender de que ese archivo exista en
 * disco, para que corra igual en cualquier checkout.
 */
import type { FastifyInstance } from "fastify";
import { Validator } from "@seriousme/openapi-schema-validator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.ts";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("OpenAPI 3.1", () => {
  it("expone los 5 endpoints núcleo", () => {
    const spec = app.swagger() as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths).sort()).toEqual(
      ["/health", "/v1/modes", "/v1/routes", "/v1/stops/near", "/v1/trips"].sort()
    );
  });

  it("valida contra el JSON Schema oficial de OpenAPI 3.1", async () => {
    const spec = app.swagger();
    const validator = new Validator();
    const result = await validator.validate(spec as Parameters<Validator["validate"]>[0]);
    if (!result.valid) {
      console.error(JSON.stringify(result.errors, null, 2));
    }
    expect(result.valid).toBe(true);
    expect(validator.version).toBe("3.1");
  });
});
