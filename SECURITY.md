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
  routing-provider-chain and local-API modules, and security-policy documents).
  CI, advisory agent review and human QA are independent. Agents never merge
  their own PRs; missing review output is not approval.

## GitHub agent trust boundaries

- **Implementation:** an owner-applied `agent:implement` issue label starts OpenCode V2
  on the default branch. It can edit and run tests. A subsequent shell step commits,
  pushes and creates an explicitly draft PR. The built-in token has Contents/Issues
  read access; `OPENCODE_GH_TOKEN` is exposed only to that publication step.
  Use a fine-grained PAT limited to this repository with Contents/Issues/PR read/write,
  no workflow, secrets or administration permissions. Actual secret scopes must be
  checked by the owner. These write scopes do **not** technically prevent merging.
- **Review:** `pull_request_target` handles opened/updated/reopened/ready non-draft,
  same-repository, owner-authored PRs targeting main. Only the trusted base is checked
  out and installed, with lifecycle scripts disabled. PR Git objects are fetched as
  data, never checked out. The built-in token has Contents/PR read and Issues write
  for advisory comments, not Contents/PR write, approval or merge permissions.
  No PAT is used. OpenCode has reads/searches and a narrow Git diff/show shell allowlist;
  edits, arbitrary shell, network tools and delegation are denied by configuration.
  Its process receives neither a GitHub token nor the upstream provider key.
- Both prompts treat issue/PR descriptions, source and comments as untrusted data,
  not permission to change the task. Implementation must not deliberately merge,
  approve its own work, change secrets or alter security settings. These instructions
  are not a sandbox. The existing owner `/opencode`/`/oc` follow-up workflow remains
  a write-capable legacy action with PAT access, and carries implementation-level risk.
- `OPENCODE_API_KEY` is supplied to the local router startup step, not OpenCode.
  Both agents use existing routing, privacy checks and zero-dollar cash limits.
  Timeouts and native step limits bound runs, not subscription token consumption.
  Keep Go Extra Usage off. Source/context is sent to the selected hosted provider.
  No raw router/model logs, credentials or environment dumps are published; model
  output is still untrusted and comments are not guaranteed free of sensitive source.
- Trusted base code, dependencies, OpenCode and GitHub runners remain trusted.
  Tool permissions and step-local credential exposure are not OS/process isolation.
  Prompt injection can still distort findings, induce undesirable local operations,
  or affect an implementation. Implementation is riskier because it executes tests
  and publishes code with a write-capable PAT. Never commit secrets.
- Review is advisory, may be incomplete or stale, and can fail to publish. It is not
  an approval or required merge check. Standard CI remains independent. A human
  inspects the diff, checks, limitations and manual QA before deciding to merge.

See [review operations and smoke tests](docs/agents/github-review.md).
