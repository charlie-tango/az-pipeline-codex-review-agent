# Codex Azure Review Agent

Run the reviewer straight from npm with:

```bash
npx @charlietango/az-pipeline-codex-review-agent
```

When run inside an Azure Pipelines PR validation build, the CLI picks up the pull-request ID, organization URL, project, repository, and branch refs from the standard environment variables. It then gathers the diff, asks the Codex agent for a structured review, and posts the summary plus inline suggestions back to Azure DevOps.

## Prerequisites

- Node.js 20+ (matches the runtime used in the Azure Pipelines template).
- `OPENAI_API_KEY` for the Codex agent.
- An Azure DevOps PAT with Code (Read & Write) scope, exposed as `AZURE_DEVOPS_PAT` or `SYSTEM_ACCESSTOKEN`.

## Typical Azure Pipelines usage

```yaml
- script: |
    set -euxo pipefail
    npx @charlietango/az-pipeline-codex-review-agent --review-time-budget 20
  env:
    OPENAI_API_KEY: $(OPENAI_API_KEY)
    AZURE_DEVOPS_PAT: $(System.AccessToken)
```

The CLI auto-detects the PR metadata and source/target branches from Azure DevOps variables. No arguments are required unless you want to override the defaults (for example, rerunning against a different PR).

## Helpful flags

- `--dry-run` – output findings without posting any comments.
- `--diff-file mock.diff` – supply a local diff for testing instead of hitting Azure DevOps.
- `--review-time-budget 20` – hint to Codex to prioritize its review within ~20 minutes.
- `--debug` – enable verbose logs for troubleshooting.
- `--openai-api-key sk-...` – provide the OpenAI key explicitly when the environment variable is unavailable.
- `--pr-id 123` (and related flags like `--organization`) – override the detected Azure DevOps context when running outside a PR build.

See `npx @charlietango/az-pipeline-codex-review-agent --help` for the full list.
