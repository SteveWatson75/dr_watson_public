# Security

## Supported versions

No versions are currently receiving security updates. Report issues against the latest `main` branch.

## Reporting a vulnerability

Please do not open a public issue for security concerns. Contact the maintainer directly (via GitHub) with details of the vulnerability and steps to reproduce.

We will acknowledge receipt and work with you on a fix and disclosure timeline.

## GitHub PR review trust boundaries

Implemented controls:

- `pull_request_target` runs **only the trusted main/base SHA**, never the PR checkout.
  Same-repository, owner-authored, non-draft PRs targeting main only; forks cannot enter analysis.
  PR title/body, API metadata, source, comments, docs, CI labels and model output are untrusted.
  No PR code, install hooks, scripts, symlinks, plugins or configuration are executed or loaded.
- Deterministic GitHub API reads provide bounded diff text; paths/encoding/schema/size are
  checked. Filenames never enter shell commands. There is no head filesystem to traverse.
  Sensitive files are excluded, configured keys and common credential patterns redacted.
- OpenCode V2 runs from an empty temporary location with an isolated home and a whitelisted
  environment: no provider key, GitHub credential, or Actions runtime token. All tools denied;
  one agent step. The local API ignores client prompts/policy/tools and supplies the trusted
  review policy and sanitized evidence itself. Upstream requests have **no tools**; tool-call
  responses are rejected. There is no tool dispatcher or model-driven GitHub operation.
- Analysis has contents/PR/checks read permissions. Publication has contents read and PR write,
  but no provider key and no LLM process. Checkout credentials are not persisted. Neither uses
  the old PAT (`OPENCODE_GH_TOKEN`), whose configured Contents/Issues/PR write access exceeds
  reviewer needs; actual secret scopes cannot be verified from repository code.
- Strict output schema rejects commands/extra fields, uninspected paths/lines, malformed output,
  oversized responses and wrong SHAs. Publishing is always a `COMMENT` review with the exact
  inspected `commit_id`, never `APPROVE`, merge, push or remediation. Head/base are rechecked.
  Policy/workflow/configuration changes require human review and cannot receive automatic approval.
- Only sanitized result/manifest/allowlisted diagnostics are retained, not prompts, provider
  bodies, environment dumps or OpenCode logs. Model text is escaped in a plain-text report.

Operational assumptions and limitations:

- Main branch, runner, pinned OpenCode distribution, npm dependencies, GitHub Actions/artifacts
  and maintainers are trusted. Protect main and workflow changes with human review.
- Keep Go **Use balance / Extra Usage off**. Zero-dollar ledger limits prevent paid route
  fallback, but cannot control billing settings in the Go account. No settings are changed here.
- Credential-pattern redaction is best effort, not a universal secret detector. Do not put
  credentials in source; rotate any accidentally committed credentials. Unknown sensitive
  source values may require human inspection. Analysis sends selected public diff text to Go.
- Permissions/no upstream tools prevent model-requested operations, but this is **not an OS
  sandbox** and does not make model judgments immune to prompt injection. A manipulated model
  can miss a defect or request Incomplete; CI and human QA remain independent.
- Runner termination, cancellation, GitHub outage, installation failure or disabled token review
  permissions can prevent publication. Missing publication is never approval. Do not fall back
  to a broader PAT to bypass settings. Current-run artifacts are trusted workflow output, not
  accepted from PRs or external workflows.
- Future hardening: dependency/action digest pinning, independent secret scanning, stronger runner
  egress isolation. These are not implemented guarantees.

See [review operations and troubleshooting](docs/agents/github-review.md).
