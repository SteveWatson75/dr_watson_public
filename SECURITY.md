# Security

## Supported versions

No versions are currently receiving security updates. Report issues against the latest `main` branch.

## Reporting a vulnerability

Please do not open a public issue for security concerns. Contact the maintainer directly (via GitHub) with details of the vulnerability and steps to reproduce.

We will acknowledge receipt and work with you on a fix and disclosure timeline.

## Local operation and owner authorization

- Keep credentials in ignored local `.env` or GitHub Actions secrets, never source,
  prompts, logs or workflow YAML. Preserve owner-specific settings; rotate exposed keys.
  No cloud, hosting, billing-console or deployment access is needed for local setup.
  If a task needs human service access, stop and give exact steps rather than act.
- The CLI can send project context, conversation history and durable memory to the
  selected hosted provider. Use `LLM_PROVIDER=ollama` for local-only operation.
  Built-in agents have no filesystem, shell or deployment tools and provide advice/plans;
  execution claims require tool evidence. OpenCode owns its tools and permission checks,
  not Dr Watson. Untrusted content cannot authorize tools or override owner instructions.
- The local API binds only to `127.0.0.1:8787`; browser-origin requests are rejected.
  It is a local CLI endpoint, not a public authenticated service. Do not expose it.
  Ollama endpoints must remain loopback-only. OpenCode supplies its own context;
  this API adds no CLI chat history, CEO pack or persistent conversation memory.
- `config/models.json` controls approved routes/defaults/endpoints/cash pricing.
  `config/evaluation-candidates.json` supplies runtime privacy restrictions as well as
  evaluation metadata. Known training-required, blocked and expired Go models are
  rejected even on explicit overrides. Unknown manual models are not privacy-approved.
  Dated approvals are checked per request; renewal and regional settings require owner
  review. DeepSeek's current ZDR approval is valid through **2026-11-30**; the owner
  confirmed Global-region access on 2026-11-16. Never renew or change settings automatically.
  `beam-free` has 30-day retention, geographic restrictions and temporary availability;
  zero cash price is not a privacy guarantee.
- Cash limits default to a $15 monthly warning and $20 hard cap; only the owner may
  change local limits. Positive-cost reservations are blocked at the cap or when
  remaining budget cannot cover them; zero-priced and local routes remain available.
  Setting both limits to zero blocks paid routes, not hosted Go/free requests.
  Preserve reservations and `data/budget.db` across restarts; interrupted/failed calls
  may have been billed.
  The ledger is an estimate, not the provider invoice or an account-wide spending cap.
- Go subscription allowance is not cash spend and is not measured by the budget ledger.
  Keep **Use balance / Extra Usage off** in the owner's account; code cannot enforce
  that external setting. Do not enable paid API use, raise limits, change credentials,
  deploy, or alter GitHub/security configuration without explicit owner authorization.
  Keep GitHub Actions overage hard-stopped and use standard Ubuntu runners.
- Human review is required for security-sensitive paths and guardrails (including
  `.github/`, `.opencode/`, `AGENTS.md`, `opencode.json(c)`, `config/`, provider,
  routing-provider-chain, local-API and reviewer modules, and security-policy documents).
  CI, advisory agent review and human QA are separate gates. Agents never merge
  their own PRs; missing review output is not approval.

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
- Native Actions `review-policy` fails for blocking, incomplete or human-required review,
  missing/skipped dependencies, or failed execution. `review-execution` success means only
  successful validated execution/publication, not security approval. No Checks/status write
  permission or neutral conclusion is used; neutral/skipped required checks can satisfy GitHub
  branch protection. The owner must require `review-policy`, standard CI and independent human
  review in repository settings; see the [deployment instructions](docs/agents/github-review.md#required-check-deployment-and-neutral-conclusions).
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
