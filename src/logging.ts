export type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export function createLogger(debugEnabled: boolean): Logger {
  return {
    debug: (...args: unknown[]) => {
      if (debugEnabled) {
        console.debug("[DEBUG]", ...args);
      }
    },
    info: (...args: unknown[]) => {
      console.log("[INFO]", ...args);
    },
    warn: (...args: unknown[]) => {
      console.warn("[WARN]", ...args);
    },
    error: (...args: unknown[]) => {
      console.error("[ERROR]", ...args);
    },
  };
}

let activeLogger: Logger = createLogger(false);

export function setLogger(logger: Logger): void {
  activeLogger = logger;
}

export function getLogger(): Logger {
  return activeLogger;
}