import assert from "node:assert/strict";
import test from "node:test";

import { parseReview } from "../src/reviewProcessing.js";

test("parseReview trims summary and preserves findings", () => {
  const raw = JSON.stringify({
    summary: " Automated summary ",
    findings: [
      {
        file: "src/a.ts",
        line: 10,
        title: "Missing guard",
        details: "Handle undefined input.",
        severity: "high",
      },
    ],
  });

  const review = parseReview(raw);
  assert.equal(review.summary, "Automated summary");
  assert.equal(review.findings.length, 1);
  const finding = review.findings[0];
  assert.equal(finding.file, "src/a.ts");
  assert.equal(finding.line, 10);
  assert.equal(finding.title, "Missing guard");
  assert.equal(finding.details, "Handle undefined input.");
  assert.equal(finding.severity, "high");
});

test("parseReview tolerates missing optional finding fields", () => {
  const raw = JSON.stringify({
    summary: "",
    findings: [
      {
        file: "src/b.ts",
        line: 5,
      },
    ],
  });

  const review = parseReview(raw);
  assert.equal(review.summary, "");
  assert.equal(review.findings.length, 1);
  const finding = review.findings[0];
  assert.equal(finding.file, "src/b.ts");
  assert.equal(finding.line, 5);
  assert.equal(finding.title, undefined);
  assert.equal(finding.details, undefined);
});
