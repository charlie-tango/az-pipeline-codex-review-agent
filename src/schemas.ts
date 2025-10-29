import { z } from "zod";

import { normalizeJsonSchema } from "./utils.js";

export const integerFromString = z.coerce.number().int();

export const SuggestionDetailsSchema = z.object({
  file: z.string(),
  start_line: integerFromString,
  end_line: integerFromString.optional(),
  comment: z.string(),
  replacement: z.string(),
});

export const SuggestionInstructionSchema = z.object({
  file: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  comment: z.string(),
  replacement: z.string(),
});

export const FindingInstructionSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  title: z.string(),
  details: z.string(),
  suggestion: SuggestionInstructionSchema.nullable(),
});

export const CodexInstructionSchema = z.object({
  summary: z.string(),
  findings: z.array(FindingInstructionSchema),
  suggestions: z.array(SuggestionInstructionSchema),
});

export const FindingSchema = z
  .object({
    file: z.string().optional(),
    line: integerFromString.optional(),
    title: z.string().optional(),
    details: z.string().optional(),
    suggestion: z
      .union([SuggestionDetailsSchema, z.null()])
      .optional()
      .default(null),
  })
  .passthrough();

export const SuggestionSchema = z.object({
  file: z.string(),
  start_line: integerFromString,
  end_line: integerFromString.optional(),
  comment: z.string(),
  replacement: z.string(),
});

export const ReviewSchema = z.object({
  summary: z.string().optional().default(""),
  findings: z.array(FindingSchema).optional().default([]),
  suggestions: z.array(SuggestionSchema).optional().default([]),
});

export const CODEX_OUTPUT_SCHEMA = normalizeJsonSchema(
  z.toJSONSchema(CodexInstructionSchema, {
    target: "openapi-3.0",
  }) as Record<string, unknown>,
);

