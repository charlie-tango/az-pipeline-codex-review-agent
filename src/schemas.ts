import { z } from "zod";

import { normalizeJsonSchema } from "./utils.js";

export const integerFromString = z.coerce.number().int();

export const FindingInstructionSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  title: z.string(),
  details: z.string(),
});

export const CodexInstructionSchema = z.object({
  summary: z.string(),
  findings: z.array(FindingInstructionSchema),
});

export const FindingSchema = z
  .object({
    file: z.string().optional(),
    line: integerFromString.optional(),
    title: z.string().optional(),
    details: z.string().optional(),
  })
  .passthrough();

export const ReviewSchema = z.object({
  summary: z.string().optional().default(""),
  findings: z.array(FindingSchema).optional().default([]),
});

export const CODEX_OUTPUT_SCHEMA = normalizeJsonSchema(
  z.toJSONSchema(CodexInstructionSchema, {
    target: "openapi-3.0",
  }) as Record<string, unknown>,
);
