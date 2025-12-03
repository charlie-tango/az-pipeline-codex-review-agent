import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  renderSuggestionComment,
  sanitizeSuggestionReplacement,
} from "../src/suggestionRendering.js";

const fixturePath = path.join("tests", "fixtures", "sample.ts");

test("renderSuggestionComment removes trailing original block appended by the model", () => {
  const rendered = renderSuggestionComment({
    file: fixturePath,
    startLine: 1,
    endLine: 3,
    comment: "Add tracking flag.",
    replacement: `const isTracked = true;
export function sample(value: string): string {
  return value.trim();
}
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

test("sanitizeSuggestionReplacement leaves already-clean replacements untouched", () => {
  const sanitized = sanitizeSuggestionReplacement({
    file: fixturePath,
    startLine: 1,
    endLine: 3,
    comment: "Add tracking flag.",
    replacement: "const isTracked = true;",
  });

  assert.equal(sanitized, "const isTracked = true;");
});

test("sanitizeSuggestionReplacement removes empty output after stripping original block", () => {
  const sanitized = sanitizeSuggestionReplacement({
    file: fixturePath,
    startLine: 1,
    endLine: 3,
    comment: "Add tracking flag.",
    replacement: `export function sample(value: string): string {
  return value.trim();
}
`,
  });

  assert.equal(sanitized, "");
});
