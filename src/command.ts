import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ReviewError } from "./errors.js";
import { getLogger } from "./logging.js";

const execFileAsync = promisify(execFile);

export async function runCommand(
  command: string[],
  options: {
    allowFailure?: boolean;
    env?: NodeJS.ProcessEnv;
    suppressFailureLog?: boolean;
  } = {},
): Promise<string> {
  const [file, ...args] = command;
  const logger = getLogger();
  logger.debug("Running command:", command.join(" "));
  try {
    const { stdout } = await execFileAsync(file, args, {
      env: options.env ?? process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    const stderr = err.stderr ?? "";
    if (options.allowFailure) {
      if (!options.suppressFailureLog) {
        logger.warn("Command allowed to fail:", stderr.trim());
      } else {
        logger.debug("Command allowed to fail (suppressed log):", command.join(" "));
      }
      return err.stdout ?? "";
    }
    logger.error("Command failed:", stderr.trim());
    throw new ReviewError(`Command ${command.join(" ")} failed: ${stderr.trim() || err.message}`);
  }
}
