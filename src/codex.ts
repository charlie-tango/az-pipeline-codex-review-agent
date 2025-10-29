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

  if (
    typeof options.timeBudgetMinutes === "number" &&
    options.timeBudgetMinutes > 0
  ) {
    instructions.push({
      type: "text" as const,
      text: `Work efficiently and limit your analysis to what you can cover in at most ${options.timeBudgetMinutes} minutes; prioritize the most important issues first.`,
    });
  }

  instructions.push(
    {
      type: "text" as const,
      text: "Analyze the provided unified diff for a pull request and respond in JSON that conforms to the supplied schema.",
    },
    {
      type: "text" as const,
      text: `When emitting suggestion replacement text, include only the new lines exactly as they should appear in the file—do not repeat the original/removed code inside the suggestion block.`,
    },
    {
      type: "text" as const,
      text: prompt,
    },
  );

  logger.debug(
    "Codex Prompt:",
    instructions.map((instruction) => instruction.text).join("\n"),
  );

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

  logger.debug("Raw model output:", rawOutput);
  return rawOutput;
}
