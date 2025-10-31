## Azure Pipelines Runtime

This reviewer currently targets Azure Pipelines pull-request runs exclusively. The build
environment is expected to provide:

- `SYSTEM_PULLREQUEST_PULLREQUESTID`, `SYSTEM_COLLECTIONURI`, `SYSTEM_TEAMPROJECT`,
  `BUILD_REPOSITORY_NAME`, and `BUILD_REPOSITORY_ID` for PR context.
- `SYSTEM_PULLREQUEST_TARGETBRANCH` (or equivalent Azure DevOps PR metadata) so the agent can
  resolve the base branch without any manual overrides.
- `SYSTEM_ACCESSTOKEN` or `AZURE_DEVOPS_PAT` with Code (Read & Write) scope so we can query PR
  details and post review comments.

The CLI no longer accepts manual diff overrides (e.g., `--diff-file`, `--target-branch`, or
`--source-ref`). Instead, it always fetches the diff between the PR head checked out by the build
and the target branch reported by Azure DevOps. If the REST API or Azure CLI cannot provide the
target branch, the reviewer falls back to `SYSTEM_PULLREQUEST_TARGETBRANCH`.

Because the tool depends on that hosted agent context, local runs are only reliable when you supply
the same environment variables yourself. For most scenarios we recommend exercising it through Azure
Pipelines so the agent can automatically infer the necessary metadata.
