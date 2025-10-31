import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

import { ReviewError } from "./errors.js";
import { maskSecret } from "./utils.js";

const integerFromString = z.coerce.number().int();

export const ArgsSchema = z.object({
  prId: z.coerce
    .number()
    .int("pr-id must be an integer")
    .positive("pr-id must be positive")
    .optional(),
  organization: z.string().trim().min(1, "organization cannot be empty").optional(),
  project: z.string().trim().min(1, "project cannot be empty").optional(),
  repository: z.string().trim().min(1, "repository cannot be empty").optional(),
  repositoryId: z.string().trim().uuid("repository-id must be a valid UUID").optional(),
  maxFiles: z.coerce
    .number()
    .int("max-files must be an integer")
    .positive("max-files must be positive")
    .max(100, "max-files cannot exceed 100")
    .default(20),
  maxDiffChars: z.coerce
    .number()
    .int("max-diff-chars must be an integer")
    .positive("max-diff-chars must be positive")
    .default(16000),
  dryRun: z.coerce.boolean().default(false),
  debug: z.coerce.boolean().default(false),
  outputJson: z.string().trim().optional(),
  codexResponseFile: z.string().trim().optional(),
  reviewTimeBudget: z.coerce
    .number()
    .int("review-time-budget must be an integer")
    .positive("review-time-budget must be positive")
    .max(120, "review-time-budget cannot exceed 120 minutes")
    .optional(),
  azureToken: z.string().trim().min(1, "azure-token cannot be empty").optional(),
  openaiApiKey: z.string().trim().min(1, "openai-api-key cannot be empty").optional(),
  ignoreFiles: z.array(z.string().trim().min(1)).optional().default([]),
  prompt: z.string().trim().optional(),
});

export type CliOptions = z.infer<typeof ArgsSchema>;

function envInt(name: string): number | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseArgs(): CliOptions {
  const argv = yargs(hideBin(process.argv))
    .option("pr-id", {
      type: "number",
      description: "Azure DevOps pull request ID.",
      default: envInt("SYSTEM_PULLREQUEST_PULLREQUESTID"),
    })
    .option("prompt", {
      type: "string",
      description: "Override the default instruction shown to the review agent (use with caution).",
    })
    .option("organization", {
      type: "string",
      description: "Azure DevOps organization URL (https://dev.azure.com/contoso).",
      default: process.env.AZURE_DEVOPS_ORG_URL ?? process.env.SYSTEM_COLLECTIONURI,
    })
    .option("project", {
      type: "string",
      description: "Azure DevOps project name.",
      default: process.env.AZURE_DEVOPS_PROJECT ?? process.env.SYSTEM_TEAMPROJECT,
    })
    .option("repository", {
      type: "string",
      description: "Azure DevOps repository name.",
      default: process.env.BUILD_REPOSITORY_NAME,
    })
    .option("repository-id", {
      type: "string",
      description: "Azure DevOps repository ID.",
      default: process.env.BUILD_REPOSITORY_ID,
    })
    .option("max-files", {
      type: "number",
      description: "Maximum number of files to include in the Codex prompt.",
      default: 20,
    })
    .option("max-diff-chars", {
      type: "number",
      description: "Maximum total diff characters to include in the prompt.",
      default: 16000,
    })
    .option("dry-run", {
      type: "boolean",
      description: "Skip posting comments; log output only.",
      default: false,
    })
    .option("debug", {
      type: "boolean",
      description: "Enable verbose logging.",
      default: false,
    })
    .option("output-json", {
      type: "string",
      description: "Write the raw Codex response JSON to this path.",
    })
    .option("codex-response-file", {
      type: "string",
      description:
        "Path to a Codex JSON response to reuse instead of calling the agent (for local testing).",
    })
    .option("review-time-budget", {
      type: "number",
      description:
        "Optional time budget (in minutes) to remind Codex to stay within. Omit for no reminder.",
    })
    .option("azure-token", {
      type: "string",
      description:
        "Azure DevOps Personal Access Token (defaults to AZURE_DEVOPS_PAT or SYSTEM_ACCESSTOKEN).",
      default: process.env.AZURE_DEVOPS_PAT ?? process.env.SYSTEM_ACCESSTOKEN,
    })
    .option("openai-api-key", {
      type: "string",
      description: "OpenAI API key to use for Codex (defaults to OPENAI_API_KEY env var).",
      default: process.env.OPENAI_API_KEY,
    })
    .option("ignore-files", {
      type: "string",
      array: true,
      description:
        "Glob patterns for files to ignore during review (repeatable). Matches are excluded from analysis.",
      default: [],
    })
    .help()
    .parseSync();

  const parsed = ArgsSchema.safeParse(argv);

  if (parsed.success) {
    return parsed.data;
  }

  const message = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new ReviewError(`Invalid CLI arguments: ${message}`);
}

export function redactOptions(options: CliOptions): Record<string, unknown> {
  const { azureToken, openaiApiKey, ...rest } = options;
  return {
    ...rest,
    azureToken: maskSecret(azureToken),
    openaiApiKey: maskSecret(openaiApiKey),
  };
}
