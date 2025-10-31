import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  renderSuggestionComment,
  sanitizeSuggestionReplacement,
} from "../src/suggestionRendering.js";

const fixturePath = path.join("tests", "fixtures", "sample.ts");

test("renderSuggestionComment removes original lines from replacement", () => {
  const rendered = renderSuggestionComment({
    file: fixturePath,
    startLine: 1,
    endLine: 3,
    comment: "Add tracking flag.",
    replacement: `export function sample(value: string): string {
  return value.trim();
}
const isTracked = true;
`,
  });

  assert.ok(rendered, "Expected rendered suggestion");
  assert.equal(rendered?.sanitizedReplacement, "const isTracked = true;");
  assert.match(rendered?.body ?? "", /```suggestion/);
  assert.match(rendered?.body ?? "", /const isTracked = true;/);
});

test("renderSuggestionComment returns null when replacement is whitespace-only", () => {
  const rendered = renderSuggestionComment({
    file: fixturePath,
    startLine: 1,
    endLine: 3,
    comment: "Whitespace only",
    replacement: "   \n  ",
  });

  assert.equal(rendered, null);
});

test("sanitizeSuggestionReplacement strips duplicated original fragments embedded in new lines", () => {
  const fixture = path.join("tests", "fixtures", "card.tsx");
  const sanitized = sanitizeSuggestionReplacement({
    file: fixture,
    startLine: 5,
    endLine: 12,
    comment: "Update CTA targets",
    replacement: `    theme="primary"
  },
  {
    to="/aftaler?kategori=ustoettet"
    label="unsupported"
    theme="secondary" theme: "secondary",
`,
  });

  assert.ok(sanitized.includes(`theme="primary"`));
  assert.ok(!sanitized.includes(`theme: "secondary"`));
  assert.ok(sanitized.includes(`theme="secondary"`));
});

test("sanitizeSuggestionReplacement preserves original comment lines when pairing with new code", () => {
  const fixture = path.join("tests", "fixtures", "hook.ts");
  const sanitized = sanitizeSuggestionReplacement({
    file: fixture,
    startLine: 1,
    endLine: 4,
    comment: "Ensure timeout storage remains environment agnostic",
    replacement: `/**
 * @param deps - Dependency array for the effect
 */
const timeoutIdsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
`,
  });

  assert.ok(sanitized.includes("@param deps"), "Expected JSDoc comment to be preserved");
  assert.ok(
    sanitized.includes("const timeoutIdsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());"),
    "Expected replacement to include new code line",
  );
});
