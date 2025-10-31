import assert from "node:assert/strict";
import test from "node:test";

import { parseUnifiedDiff } from "../src/git.js";
import { filterFileDiffs, shouldIgnoreFile } from "../src/ignore.js";

const SAMPLE_DIFF = `diff --git a/src/utils/math.ts b/src/utils/math.ts
index 1111111..2222222 100644
--- a/src/utils/math.ts
+++ b/src/utils/math.ts
@@ -1,14 +1,46 @@
-export function average(nums: number[]): number {
-  if (!nums.length) {
-    throw new Error("Cannot take average of empty list");
-  }
-  const total = nums.reduce((sum, value) => sum + value, 0);
-  return total / nums.length;
-}
-
-export function max(nums: number[]): number {
-  return Math.max(...nums);
-}
+export function average(nums: number[]): number {
+  const total = nums.reduce((sum, value) => sum + value, 0);
+  return Math.round((total / nums.length) * 100) / 100;
+}
+
+export function max(nums: number[]): number {
+  return Math.max(...nums);
+}

diff --git a/src/api/userService.ts b/src/api/userService.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/api/userService.ts
@@ -0,0 +1,10 @@
+import fetch from "node-fetch";
+
+export async function fetchUserProfile(userId: string): Promise<unknown> {
+  const response = await fetch(\`https://example.com/users/\${userId}\`);
+  return response.json();
+}

diff --git a/tests/math.test.ts b/tests/math.test.ts
index 4444444..5555555 100644
--- a/tests/math.test.ts
+++ b/tests/math.test.ts
@@ -1,12 +1,21 @@
-import { average, clamp, max } from "../src/utils/math";
+import { average, clamp, max, median } from "../src/utils/math";

diff --git a/docs/usage.md b/docs/usage.md
index 6666666..7777777 100644
--- a/docs/usage.md
+++ b/docs/usage.md
@@ -12,6 +12,13 @@ npm run start

 The service will start listening on port 3000 by default.

+### Tracking user sessions
+
+\`\`\`ts
+import { fetchUserProfile } from "../src/api/userService";
+\`\`\`
+
 ### Running tests`;

test("shouldIgnoreFile matches test files with **/*.test.ts pattern", () => {
	const result = shouldIgnoreFile("tests/math.test.ts", ["**/*.test.ts"]);
	assert.equal(result, true);
});

test("shouldIgnoreFile matches documentation with docs/** pattern", () => {
	const result = shouldIgnoreFile("docs/usage.md", ["docs/**"]);
	assert.equal(result, true);
});

test("shouldIgnoreFile does not match source files with test pattern", () => {
	const result = shouldIgnoreFile("src/utils/math.ts", ["**/*.test.ts"]);
	assert.equal(result, false);
});

test("shouldIgnoreFile returns false when no patterns provided", () => {
	const result = shouldIgnoreFile("src/utils/math.ts", undefined);
	assert.equal(result, false);
});

test("shouldIgnoreFile returns false when empty patterns array", () => {
	const result = shouldIgnoreFile("src/utils/math.ts", []);
	assert.equal(result, false);
});

test("shouldIgnoreFile matches with multiple patterns", () => {
	const patterns = ["**/*.test.ts", "docs/**", "**/*.md"];
	assert.equal(shouldIgnoreFile("tests/math.test.ts", patterns), true);
	assert.equal(shouldIgnoreFile("docs/usage.md", patterns), true);
	assert.equal(shouldIgnoreFile("README.md", patterns), true);
	assert.equal(shouldIgnoreFile("src/utils/math.ts", patterns), false);
});

test("shouldIgnoreFile normalizes paths with leading ./ prefix", () => {
	const result = shouldIgnoreFile("./tests/math.test.ts", ["tests/**"]);
	assert.equal(result, true);
});

test("shouldIgnoreFile normalizes backslash paths to forward slashes", () => {
	const result = shouldIgnoreFile("tests\\math.test.ts", ["tests/**"]);
	assert.equal(result, true);
});

test("filterFileDiffs excludes test files from parsed diff", () => {
	const fileDiffs = parseUnifiedDiff(SAMPLE_DIFF);
	assert.equal(fileDiffs.length, 4);

	const filtered = filterFileDiffs(fileDiffs, ["**/*.test.ts"]);
	assert.equal(filtered.length, 3);

	const paths = filtered.map((f) => f.path);
	assert.deepEqual(paths, ["src/utils/math.ts", "src/api/userService.ts", "docs/usage.md"]);
});

test("filterFileDiffs excludes documentation from parsed diff", () => {
	const fileDiffs = parseUnifiedDiff(SAMPLE_DIFF);

	const filtered = filterFileDiffs(fileDiffs, ["docs/**", "**/*.md"]);
	assert.equal(filtered.length, 3);

	const paths = filtered.map((f) => f.path);
	assert.deepEqual(paths, ["src/utils/math.ts", "src/api/userService.ts", "tests/math.test.ts"]);
});

test("filterFileDiffs excludes multiple patterns from parsed diff", () => {
	const fileDiffs = parseUnifiedDiff(SAMPLE_DIFF);

	const filtered = filterFileDiffs(fileDiffs, ["**/*.test.ts", "docs/**", "**/*.md"]);
	assert.equal(filtered.length, 2);

	const paths = filtered.map((f) => f.path);
	assert.deepEqual(paths, ["src/utils/math.ts", "src/api/userService.ts"]);
});

test("filterFileDiffs excludes specific file path", () => {
	const fileDiffs = parseUnifiedDiff(SAMPLE_DIFF);

	const filtered = filterFileDiffs(fileDiffs, ["src/api/userService.ts"]);
	assert.equal(filtered.length, 3);

	const paths = filtered.map((f) => f.path);
	assert.equal(paths.includes("src/api/userService.ts"), false);
});

test("filterFileDiffs excludes entire directory with pattern", () => {
	const fileDiffs = parseUnifiedDiff(SAMPLE_DIFF);

	const filtered = filterFileDiffs(fileDiffs, ["tests/**"]);
	assert.equal(filtered.length, 3);

	const paths = filtered.map((f) => f.path);
	assert.equal(paths.includes("tests/math.test.ts"), false);
});

test("filterFileDiffs returns all diffs when no patterns provided", () => {
	const fileDiffs = parseUnifiedDiff(SAMPLE_DIFF);

	const filtered = filterFileDiffs(fileDiffs, undefined);
	assert.equal(filtered.length, 4);
});

test("filterFileDiffs returns all diffs when empty patterns array", () => {
	const fileDiffs = parseUnifiedDiff(SAMPLE_DIFF);

	const filtered = filterFileDiffs(fileDiffs, []);
	assert.equal(filtered.length, 4);
});

test("filterFileDiffs preserves diff content for non-ignored files", () => {
	const fileDiffs = parseUnifiedDiff(SAMPLE_DIFF);

	const filtered = filterFileDiffs(fileDiffs, ["**/*.test.ts", "docs/**", "**/*.md"]);
	assert.equal(filtered.length, 2);

	const mathFile = filtered.find((f) => f.path === "src/utils/math.ts");
	assert.ok(mathFile);
	assert.ok(mathFile.diff.includes("export function average"));
	assert.ok(mathFile.diff.includes("Math.round"));
});

test("filterFileDiffs excludes files matching glob star patterns", () => {
	const fileDiffs = parseUnifiedDiff(SAMPLE_DIFF);

	const filtered = filterFileDiffs(fileDiffs, ["**/userService.ts"]);
	assert.equal(filtered.length, 3);

	const paths = filtered.map((f) => f.path);
	assert.equal(paths.includes("src/api/userService.ts"), false);
});

test("filterFileDiffs handles complex nested patterns", () => {
	const fileDiffs = parseUnifiedDiff(SAMPLE_DIFF);

	const filtered = filterFileDiffs(fileDiffs, ["src/api/**"]);
	assert.equal(filtered.length, 3);

	const paths = filtered.map((f) => f.path);
	assert.equal(paths.includes("src/api/userService.ts"), false);
	assert.equal(paths.includes("src/utils/math.ts"), true);
});

test("shouldIgnoreFile matches dot files when dot option is enabled", () => {
	const result = shouldIgnoreFile(".github/workflows/ci.yml", [".github/**"]);
	assert.equal(result, true);
});
