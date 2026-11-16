# Bounded GitHub PR reviews

## Confirmed audit (16 November 2026)

PR #5 merged at `482a2e9`; historical `docs/evaluations/` evidence is unchanged.

- [Run 43849477245](https://github.com/SteveWatson75/dr_watson_public/actions/runs/43849477245)
  read evaluation JSON repeatedly (including offsets 200, 3680 and 3200 of `cheap.json`).
  Logs show main-agent steps 0–7 followed by a summary request. The published comment said
  **“no review verdict was written yet”**. There were no formal GitHub reviews on PR #5.
- [Run 43855026262](https://github.com/SteveWatson75/dr_watson_public/actions/runs/43855026262)
  shows 16 file reads, steps 0–3, a retry after HTTP 502, then another summary request.
  It timed out after ten minutes, yet the job conclusion was success (`continue-on-error`).
  The error reported missing Anthropic credentials and unavailable local Ollama.
- Old preparation supplied whitespace-joined filenames, not bounded diffs; it compared
  fetched base against the merge checkout rather than binding review content to the head SHA.
  Prompt-only tool restrictions did not stop reads. No deterministic verdict validation existed.
- Generic review detection selects `hard`, whose first route is DeepSeek V4 Pro; every provider
  request has a 60-second SDK timeout, no SDK retries, and broad deterministic failover.
  OpenCode can additionally retry the local API and request summaries. Router logs were not
  surfaced, so exact upstream models, attempt counts and Go error categories in those runs
  **cannot be confirmed** from the available action logs. Visible agent steps are not a count
  of all provider attempts.

Suspected, not proven: growing raw-data context contributed to provider delays; a specific
Go failure caused that run's fallthrough. Separate evaluation evidence records a DeepSeek
V4 Pro timeout, but does not prove the same failure caused every review timeout.

- [Run 43890950771](https://github.com/SteveWatson75/dr_watson_public/actions/runs/43890950771)
  (PR #11) correctly failed closed as **Incomplete** but selected evidence poorly: the
  old alphabetical non-Markdown sort supplied `src/ceo-context.test.ts` and part of
  `src/conversation-observability.test.ts` before the production files
  `src/provider.ts`, `src/conversation.ts`, `src/memory.ts` and `src/stats.ts`, and the
  20,000-byte budget expired first. Deterministic priority selection and two-pass
  allocation (below) fix the ordering; the fail-closed **Incomplete** behavior is
  unchanged.

## Input and execution

`agent-review.yml` runs trusted **main/base** code via `pull_request_target`; it never checks
out the head. Owner/same-repository/non-draft/main-target restrictions remain enforced.
`github-review-cli.ts collect` checks the event head/base SHA before and after paginated
GitHub PR-file reads. At most 1,000 files and 2 MB per API response; malformed, duplicate,
unsafe-path or incomplete file inventories fail closed. CI check status is optional, sampled
at the reviewed SHA; CI is not executed or treated as an approval gate here.

`github-review.ts` prepares PR title/body, statuses, rename paths and available diff hunks:

- Evidence is selected in deterministic priority order so production changes reach the
  model before optional material (ties break by path):
  **0 — security-sensitive configuration and guardrails**: `.github/`, `.opencode/`,
  `opencode.json(c)`, `AGENTS.md`, `CODEOWNERS`, `config/`, `src/github-review*`,
  `src/model-policy*`, `src/provider*`, `src/local-api*`, and any file named for
  auth/authorization/permission/privacy/secret/credential/security/guardrail/policy,
  including security-policy documents.
  **1 — production implementation and runtime configuration**: all remaining source,
  scripts and config (`package.json`, Dockerfiles, unrecognized extensions). Unknown
  file types are required content that fails closed, never silently ignored.
  **2 — tests and fixtures**: `*.test.*`, `*.spec.*`, `test(s)/`, `__tests__/`, `e2e/`,
  fixture-named files and directories.
  **3 — documentation and prose**: `*.md`/`*.mdx`, README/LICENSE/CHANGELOG/
  CONTRIBUTING, `docs/**` (security-policy documents remain priority 0).
  Priority only allocates the fixed budget; it is not a trust decision. Untrusted PR
  text and filenames cannot create coverage: human-inspection flags, line validation
  and fail-closed verdict rules are unchanged.
- Allocation is two-pass within the unchanged limits. Pass 1 gives every changed
  priority 0/1 file a bounded share (remaining bytes divided across the files not yet
  served, capped by the per-file limit) so one early large file cannot consume the
  whole budget before required changes are seen. Pass 2 spends what remains on further
  implementation hunks, then tests, then documentation. Total prepared evidence
  **20,000 UTF-8 bytes**, per-file **16,000 bytes**, Markdown **4,000 bytes**. Title/body/CI are capped at
  1,000/4,000/2,000 characters. Within the advertised **32,768-token context**, reserve **8,192
  output tokens**, leaving a **24,576-token input budget**. Conservatively bound input using
  evidence UTF-8 bytes plus policy bytes and 2,048 envelope tokens, checked before invocation.
  No average-tokenization or “characters / 4” assumption.
- Partial coverage is explicit. The manifest records only the line references actually
  supplied, and every file cut short by the budget or its per-file limit gets a
  `context budget: remaining hunks omitted (<priority class>)` entry. A file with
  omitted hunks is never described as fully inspected; any omitted non-Markdown hunk
  marks coverage partial and forbids **Approved**. When the budget cannot cover all
  required implementation changes the review returns **Incomplete**; a validated
  blocking finding over supplied hunks remains a valid narrower verdict. Omitted
  entries name exactly what a human must inspect directly in the PR diff before
  relying on the review. Exclusions and omitted-hunk markers are never dropped to
  improve a result.
- Exclude raw `docs/evaluations/*.json` and benchmark/observation JSON, generated/minified/build
  content, observation/snapshot data, oversized non-config JSON, `.env`/credential/key files and lockfiles. Binary/unavailable patches cannot be
  inspected. Exclusions and omitted hunks are listed with reasons; nothing is deleted.
- Missing/truncated material source, context overflow, sensitive files, or lockfiles alongside
  dependency-manifest changes prevent approval. Documentation is optional and omissions are
  disclosed. Workflow/review-policy/config changes additionally require human inspection.
- New-side added/context and old-side deleted line references survive hunk selection. Coverage means the **intended selected diff
  scope**, not full repository correctness or inspection of excluded evidence.

OpenCode **2.0.30** runs one agent step from an isolated temporary directory/home with all tools
denied. Its only provider is the local restricted Dr Watson API on an ephemeral loopback port.
The API supplies policy/context itself, ignores client instructions, sends no tools, and caches
one invocation promise: retries/maintenance requests cannot create more review rounds.
No linked issues, comments, web content or additional repository files are fetched by the model.

Review-specific deterministic routes: **MiMo V2.6 Pro → Kimi K2.7 Code**, existing approved
catalogue models with successful coding/tool evaluation evidence. This is a bounded review
policy, not a quality-based promotion of generic production tiers. Require reviewed
`training=not-used`, no block and unexpired privacy approval immediately before invocation.
The fixed Go endpoint, existing privacy guard/budget ledger, zero-dollar workflow limits,
8,192 output tokens and zero SDK retries apply. No paid/provider/Ollama fallback or dynamic routing.
Only transient timeouts, rate limits and selected availability statuses permit the second model;
existing narrowly matched Go model/endpoint-unavailable 400/422 errors also permit failover.
Other invalid/auth/policy errors stop immediately. Go cooldown behavior is retained.

Deadlines: **60 seconds per upstream request**, **150 seconds overall client review** (abort
upstream and kill client process group), **3 minutes review step**, **8 minutes analysis job**.
A separate **4-minute publication job** has no model/provider credential. Do not increase all
timeouts to diagnose failures.

## Verdict and publication

Require exactly one JSON result: `sha`, `outcome`, `findings`, `manualQA`, `reason`.
Only outcomes:

- **Approved** — no blocking findings and required intended coverage completed.
- **Has blocking changes needed** — at least one concrete defect with file, explicit `side`
  (`new` for added/context lines, `old` only for deleted lines), inspected line, defect description
  and blocking impact. Deletion-only hunks and removed files can use old-side locations.
- **Incomplete** — invalid/missing/truncated output, timeout/failure, policy/budget unavailability,
  incomplete required coverage, stale SHA, or missing/failed client invocation.

Reject unknown fields, unauthorized paths/lines, >16 KB output, wrong SHA and inconsistent
outcome/findings. Publisher revalidates the artifact, invocation diagnostics and current head/base.
Missing/wrong sides, unrelated old lines and omitted deletion locations are invalid: Incomplete,
never approval. Published findings label their side; old-side lines refer to the inspected base.
Reports include inspected/excluded material, remaining manual QA and one final outcome, rendered
as escaped plain text plus a deterministic outcome heading.
If a comment would exceed 60 KB, publish Incomplete with an explicitly abbreviated inventory;
the full filename/reason inventory remains in the job summary and result artifact.

Every publication is a GitHub **COMMENT**, tied to the inspected commit, not an actual GitHub
approval. Incomplete is a valid, honest result: it records that the bounded evidence was
insufficient instead of guessing, and it never implies the PR is safe. Incomplete is published where possible and makes the publish job fail. Blocking findings
can be a successfully completed review without approving the PR. Analysis/job execution success,
model invocation success, review completion and review approval are separate facts.
Repository settings must permit `GITHUB_TOKEN` review publication; failures never fall back to a PAT.

## Diagnostics and investigation

Job summary contains the report and allowlisted JSON; seven-day `bounded-review-result` artifact
contains only the result, coverage manifest and diagnostics. No raw prompt, provider body or client
logs. Fields include PR/SHA, included/excluded counts, context bytes, conservative token upper
bound, `requestCount`, `fallbackAttempts`, provider/model, duration, safe category/status, token
usage when supplied, `modelSuccess`, `cliSuccess`, `reviewComplete`, `reviewApproved`, `fullScope`.
`publicationSuccess` and a safe GitHub HTTP status distinguish publication failures; missing
execution artifacts report unknown request counts (`null`), never an invented successful call.

Example (synthetic local live smoke, no GitHub publication):

```json
{"route":"opencode:mimo-v2.6-pro","requestCount":1,"fallbackAttempts":0,
 "durationMs":11369,"inputTokens":332,"outputTokens":440,
 "outcome":"Has blocking changes needed","modelSuccess":true,"cliSuccess":true}
```

1. Check **publish** outcome and actual final verdict, not just analysis success.
2. For missing artifact, identify the failed prepare/install/analyze step; publisher records
   Incomplete. For missing comment, check GitHub permissions/outage/cancellation first.
3. Inspect safe attempt categories: `timeout`, `rate_limit`, `upstream`, `invalid_or_policy`,
   `transport`. Check Go availability/allowance, reviewed privacy metadata/expiry and zero-budget
   configuration. Never enable Extra Usage or broader PAT scopes as an automatic workaround.
4. Review coverage omissions and manual QA. After head/base moves, rerun against current SHAs.
   Canceled/superseded runs may not publish; absence never implies approval.

## Validation and manual QA

Routine tests use mocked responses, including a synthetic URL-to-`execSync` command-injection
defect carried through finding validation and final publication format. No CI API charges.
Local smoke with real pinned OpenCode and mocked upstream: one attempt, validated Approved.
Controlled synthetic **live Go** local smoke: one MiMo Pro request, 11.369 seconds, 332 input /
440 output tokens, one blocking command-injection finding; zero-dollar limits, no publication.
This was not a GitHub-hosted workflow smoke or a production-quality evaluation.

Before merging: inspect trusted checkout, token separation, no head execution and no evidence
changes; run typecheck/tests/diff-check. After a human merges this policy, use a small owner PR
with an obvious synthetic correctness defect, mark ready, confirm SHA-bound COMMENT/diagnostics,
then try a data-heavy PR and verify exclusions. The draft cannot safely exercise its own new
`pull_request_target` policy before it reaches trusted main. Do not merge just to test it.
Manually verify Go Extra Usage remains off and repository token-review settings.

Known limits: this remains a bounded, diff-based, advisory review, not a comprehensive
code review. Diff-only review lacks unchanged-file context; GitHub patch truncation and
large source changes produce partial coverage; under the fixed budget large
test/documentation patches are truncated or entirely omitted even when production
evidence is complete; redaction is heuristic; optional CI snapshots can be
incomplete. Model quality/injection resistance is not guaranteed. Runner/API/installation failures
can prevent even Incomplete publication. Human review and CI remain mandatory independent gates.
See [SECURITY.md](../../SECURITY.md#github-pr-review-trust-boundaries).
