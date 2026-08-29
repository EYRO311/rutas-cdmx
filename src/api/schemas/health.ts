import { z } from "zod";
import { successEnvelope } from "./envelope.js";

const healthResponseDataSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["ok", "error"]),
  uptime_s: z.number().nonnegative(),
  version: z.string(),
});

export const healthResponseSchema = successEnvelope(healthResponseDataSchema);
