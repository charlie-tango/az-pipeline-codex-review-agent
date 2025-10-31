import assert from "node:assert/strict";
import test from "node:test";

import { assembleReviewPrompt, buildPullRequestContext } from "../src/prompt.js";

test("assembleReviewPrompt prefixes diff with pull request metadata when available", () => {
  const metadata = {
    title: "Add timeout hook",
    description: "Ensure the hook works in both Node and browser runtimes.",
    sourceRefName: "refs/heads/feature/use-timeout",
    targetRefName: "refs/heads/main",
  };

  const prompt = assembleReviewPrompt(
    "File: src/hooks/useTimeout.ts\n```diff\n+const timeoutIdsRef = new Set();\n```",
    [],
    undefined,
    metadata,
  );

  const sections = prompt.split("\n\n---\n\n");
  assert.equal(sections.length, 2, "Expected PR context and diff sections");
  assert.match(sections[0], /Pull request context \(from Azure DevOps\):/);
  assert.match(sections[0], /Title: Add timeout hook/);
  assert.match(sections[0], /Branches: refs\/heads\/feature\/use-timeout -> refs\/heads\/main/);
  assert.match(sections[0], /Ensure the hook works in both Node and browser runtimes\./);
  assert.match(sections[1], /File: src\/hooks\/useTimeout\.ts/);
});

test("buildPullRequestContext truncates long descriptions", () => {
  const longDescription = "A".repeat(2100);
  const context = buildPullRequestContext({
    title: "Update hook",
    description: longDescription,
  });

  assert.ok(context, "Expected context to be generated");
  assert.ok(context?.includes("Description:"));
  const descriptionLine = context?.split("Description:\n")[1] ?? "";
  assert.equal(descriptionLine.length, 2001); // 2000 characters plus ellipsis
  assert.ok(descriptionLine.endsWith("?"));
});

test("assembleReviewPrompt skips metadata section when not available", () => {
  const summaries = [
    {
      content: "Investigate flaky timeout logic.",
      rawContent: "Investigate flaky timeout logic.",
      reviewHeadSha: "abcdef1234567890",
    },
  ];

  const prompt = assembleReviewPrompt(
    "File: src/hooks/useTimeout.ts\n```diff\n+const timeoutIdsRef = new Set();\n```",
    summaries,
    "abcdef1234567890",
    undefined,
  );

  const sections = prompt.split("\n\n---\n\n");
  assert.equal(sections.length, 2, "Expected existing feedback and diff sections only");
  assert.match(sections[0], /Existing PR feedback already posted/);
  assert.doesNotMatch(sections[0], /Pull request context/);
});
