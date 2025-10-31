import assert from "node:assert/strict";
import test from "node:test";

import { parseReview } from "../src/reviewProcessing.js";

test("parseReview deduplicates duplicate suggestions and trims content", () => {
  const raw = JSON.stringify({
    summary: " Automated summary ",
    findings: [
      {
        file: "src/a.ts",
        line: 10,
        title: "Missing guard",
        details: "Handle undefined input.",
        suggestion: {
          file: "src/a.ts",
          start_line: 10,
          end_line: 11,
          comment: "Add guard clause.",
          replacement: "if (!value) {\n  return;\n}\n",
        },
      },
    ],
    suggestions: [
      {
        file: "src/a.ts",
        start_line: 10,
        end_line: 11,
        comment: "Add guard clause.",
        replacement: "if (!value) {\n  return;\n}\n",
      },
    ],
  });

  const review = parseReview(raw);
  assert.equal(review.summary, "Automated summary");
  assert.equal(review.suggestions.length, 1);
  const suggestion = review.suggestions[0];
  assert.equal(suggestion.file, "src/a.ts");
  assert.equal(suggestion.startLine, 10);
  assert.equal(suggestion.endLine, 11);
  assert.equal(suggestion.comment, "Add guard clause.");
  assert.equal(suggestion.replacement, "if (!value) {\n  return;\n}");
  assert.equal(suggestion.originFinding, undefined);
});

test("parseReview fills missing suggestion fields from finding context", () => {
  const raw = JSON.stringify({
    summary: "",
    findings: [
      {
        file: "src/b.ts",
        line: 5,
        title: "Title",
        details: "Details",
        suggestion: {
          file: "src/b.ts",
          start_line: 5,
          comment: "Use strict equality",
          replacement: "if (value === expected) {\n  return true;\n}",
        },
      },
    ],
    suggestions: [],
  });

  const review = parseReview(raw);
  assert.equal(review.summary, "");
  assert.equal(review.suggestions.length, 1);
  const suggestion = review.suggestions[0];
  assert.equal(suggestion.file, "src/b.ts");
  assert.equal(suggestion.startLine, 5);
  assert.equal(suggestion.endLine, 5);
  assert.equal(suggestion.comment, "Use strict equality");
  assert.equal(suggestion.replacement, "if (value === expected) {\n  return true;\n}");
  assert.deepEqual(suggestion.originFinding, {
    title: "Title",
    details: "Details",
  });
});
