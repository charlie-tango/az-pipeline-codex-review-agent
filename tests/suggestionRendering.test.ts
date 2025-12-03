import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  renderSuggestionComment,
  sanitizeSuggestionReplacement,
} from "../src/suggestionRendering.js";

const fixturePath = path.join("tests", "fixtures", "sample.ts");

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

test("sanitizeSuggestionReplacement leaves clean replacements untouched", () => {
  const sanitized = sanitizeSuggestionReplacement({
    file: fixturePath,
    startLine: 1,
    endLine: 3,
    comment: "Add tracking flag.",
    replacement: "const isTracked = true;",
  });

  assert.equal(sanitized, "const isTracked = true;");
});

test("sanitizeSuggestionReplacement normalizes line endings", () => {
  const sanitized = sanitizeSuggestionReplacement({
    file: fixturePath,
    startLine: 1,
    endLine: 3,
    comment: "Test normalization",
    replacement: "line1\r\nline2\rline3\n",
  });

  assert.equal(sanitized, "line1\nline2\nline3");
});
