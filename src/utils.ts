export function formatElapsed(ms: number): string {
  const totalSeconds = ms / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds - hours * 3600 - minutes * 60;

  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }

  if (hours > 0 || minutes > 0) {
    const wholeSeconds = Math.floor(seconds);
    parts.push(`${wholeSeconds}s`);
  } else {
    const roundedSeconds = Math.round(seconds * 10) / 10;
    parts.push(`${roundedSeconds.toFixed(1)}s`);
  }

  return parts.join(" ");
}

export function maskSecret(secret?: string): string | undefined {
  if (!secret) {
    return undefined;
  }
  if (secret.length <= 4) {
    return "***";
  }
  return `${secret.slice(0, 2)}***${secret.slice(-2)}`;
}

export function normalizeJsonSchema<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((item) => normalizeJsonSchema(item)) as unknown as T;
  }

  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;

    for (const key of Object.keys(record)) {
      if (key === "additionalProperties" && record[key] === false) {
        if (typeof record.type !== "string") {
          record.type = "object";
        }
        continue;
      }

      record[key] = normalizeJsonSchema(record[key]);
    }

    return record as unknown as T;
  }

  return input;
}