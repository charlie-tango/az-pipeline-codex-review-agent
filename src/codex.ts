import process from "node:process";

import { Codex } from "@openai/codex-sdk";

import { ReviewError } from "./errors.js";
import { getLogger } from "./logging.js";
import { CODEX_OUTPUT_SCHEMA } from "./schemas.js";

export async function callCodex(
  prompt: string,
  options: {
    timeBudgetMinutes?: number;
    apiKey?: string;
    instructionOverride?: string;
  } = {},
): Promise<string> {
  const logger = getLogger();
  const codexOptions = options.apiKey ? { apiKey: options.apiKey } : undefined;
  const codex = new Codex(codexOptions);
  const threadOptions: Parameters<Codex["startThread"]>[0] = {
    workingDirectory: process.cwd(),
    skipGitRepoCheck: true,
  };
  const thread = codex.startThread(threadOptions);

  logger.info("Requesting review from Codex agent");
  const instructions = [
    {
      type: "text" as const,
      text:
        options.instructionOverride?.trim() ||
        "You are an autonomous code-review assistant focused on actionable feedback.",
    },
  ];

  if (typeof options.timeBudgetMinutes === "number" && options.timeBudgetMinutes > 0) {
    instructions.push({
      type: "text" as const,
      text: `you SHOULD work efficiently and limit your analysis to what you can cover in at most ${options.timeBudgetMinutes} minutes; prioritize the most important issues first.`,
    });
  }

  instructions.push(
    {
      type: "text" as const,
      text: "Analyze the provided unified diff for a pull request and respond in JSON that conforms to the supplied schema.",
    },
    {
      type: "text" as const,
      text: "Feel free to open and read any repository files you need for context; you SHOULD not limit yourself to the provided diff.",
    },
    {
      type: "text" as const,
      text: "When creating suggestions: The `replacement` field MUST contain ONLY the corrected code - nothing else. Azure DevOps will DELETE lines start_line through end_line and replace them with your replacement text. Do NOT include any original code, context, or explanations in the replacement field. Common mistake: including the last line of the original code at the end of the replacement - don't do this.",
    },
    {
      type: "text" as const,
      text: "Pull request metadata and existing feedback are provided in TOON (Token-Oriented Object Notation) blocks below. Treat TOON exactly like JSON—it encodes the same objects using fewer tokens.",
    },
    {
      type: "text" as const,
      text: prompt,
    },
  );

  logger.debug("Codex Prompt:", instructions.map((instruction) => instruction.text).join("\n"));

  const turn = await thread.run(instructions, {
    outputSchema: CODEX_OUTPUT_SCHEMA,
  });

  const rawOutput =
    typeof turn.finalResponse === "string"
      ? turn.finalResponse
      : JSON.stringify(turn.finalResponse ?? {});
  if (!rawOutput.trim()) {
    throw new ReviewError("Codex response was empty.");
  }

  const usage = turn.usage
    ? `inputTokens=${turn.usage.input_tokens ?? "?"}, cachedInputTokens=${
        turn.usage.cached_input_tokens ?? "?"
      }, outputTokens=${turn.usage.output_tokens ?? "?"}`
    : "usage unavailable";
  logger.debug("Codex usage:", usage);

  logger.debug("Raw model output:", rawOutput);
  return rawOutput;
}
