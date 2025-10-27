# Codex Azure Review Agent

CLI that diffs a branch, asks Codex for a structured review, and posts summary + inline `suggestion` comments back to Azure DevOps.

## Usage

```bash
pnpm exec codex-azure-review \
  --target-branch refs/heads/main \
  --pr-id 123 \
  --organization https://dev.azure.com/my-org \
  --project MyProject \
  --repository MyRepo
```

Key flags:
- `--diff-file patch.diff` run locally against mocked changes
- `--review-time-budget 20` remind Codex to wrap within ~20 minutes
- `--dry-run` only log results; skip Azure comments

Local dry run:
```bash
pnpm run review:local
```

## Codex contract

Codex returns JSON matching this schema (enforced with Zod):
```json
{
  "summary": "...",
  "findings": [{
    "severity": "major",
    "file": "src/file.ts",
    "line": 12,
    "title": "Issue title",
    "details": "Explanation",
    "suggestion": {
      "file": "src/file.ts",
      "start_line": 10,
      "end_line": 14,
      "comment": "Context",
      "replacement": "New code"
    }
  }],
  "suggestions": [{
    "file": "src/file.ts",
    "start_line": 20,
    "end_line": 22,
    "comment": "Context",
    "replacement": "New code"
  }]
}
```

Each finding suggestion (and top-level suggestion) becomes a PR comment with a `suggestion` block, so fixes can be applied inline.

## Notes
- Requires `OPENAI_API_KEY` (for Codex) and an Azure DevOps PAT (`AZURE_DEVOPS_PAT` or `SYSTEM_ACCESSTOKEN`).
- Runs as ESM (`moduleResolution: NodeNext`); use `pnpm exec tsx` locally.
- Biome + husky/lint-staged keep formatting/linting consistent.
