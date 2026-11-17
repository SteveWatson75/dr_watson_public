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

## Reliability audit (17 November 2026)

These are distinct failure classes, not one recurring provider failure:

| Runs | Evidence | Classification |
| --- | --- | --- |
| `43903849953`, `43907480204`, `43912497002`, `43914200441`, `43918034695`, `43921074076`, `43923089401` | Actions reports `startup_failure`; all seven have zero jobs. The first/last run-page annotations explicitly identify GitHub's scheduled public-repository `pull_request_target` brownout ending 16 November at 18:00 UTC. | GitHub event-policy startup block, before collection or model execution. |
| `43896092373`, `43898047536` (PR #12) | Published diagnostics show two ~60-second Go attempts, both `transport`, `modelSuccess: false`, successful client and publication. | Actual provider execution failures; logs do not prove a more specific upstream cause. |
| `43890950771` (PR #11) | Successful model/client/publication, two included files, nine exclusions, partial scope. | Coverage limitation (historical selection problem described above), not transport failure. |
| `44047761206` (PR #19) | Both job logs and downloaded result artifact confirm one successful MiMo Pro call (39,995 ms; 5,993 input / 1,212 output tokens), successful artifact transfer and COMMENT publication. `fullScope: false`, `humanRequired: true`, 34 included paths, 65 exclusion entries, 20,000 context bytes, `Incomplete`, zero findings. | Honest incomplete verdict due to bounded coverage and mandatory inspection, incorrectly presented as publication/execution failure by unconditional `Incomplete` exit code 1. |

The workflow is now explicitly **collect → analyze → current-run artifact → publish
(`review-execution`) → `review-policy`**. The first two phases use trusted base code
and read-only GitHub access. Publication uses the same trusted base, strict artifact
and finding validation, live head/base revalidation, and a deterministic COMMENT
write. Only a fixed `approved=true/false` output reaches the credential-free policy
job; model text never becomes a workflow expression, command or GitHub operation.

| Result | `review-execution` | `review-policy` |
| --- | --- | --- |
| Valid complete Approved, current SHA, successful publication, no human-required path | success | success (advisory result only, not merge approval) |
| Valid blocking findings, including partial scope | success | failure |
| Valid Incomplete, omitted required code, or mandatory human inspection | success | failure |
| Invalid/missing artifact or verdict, failed client/provider, stale SHA, publication failure | failure | failure |
| Analysis/publication skipped, cancelled, failed or missing | not successful or absent | failure if the policy job runs; otherwise no passing policy check |

`analyze` now also fails on actual client/provider/invalid-output execution failures,
**after** writing safe diagnostics for the always-run artifact upload. A syntactically
valid model `Incomplete` is not such a failure. `verdictValid` distinguishes invalid/
truncated model output from a valid limited verdict; the publisher independently
revalidates the artifact. Coverage completeness and mandatory human inspection are
independent fields: even complete supplied guardrail hunks cannot receive Approved.
Validated findings accompanying Incomplete are retained as a narrower blocking
verdict; they never establish complete coverage.

### Required-check deployment and neutral conclusions

[GitHub accepts successful, skipped **and neutral** required checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging).
Therefore a neutral incomplete check alone would silently satisfy a required
security gate. Writing custom conclusions through the [Checks API](https://docs.github.com/en/rest/checks/runs#create-a-check-run)
would also require Checks write access. Neither is necessary: native Actions jobs
provide separate execution and fail-closed policy checks, with **no additional
write permissions**. The policy job always evaluates dependency results and fails
for skipped/missing results rather than itself skipping. It has no checkout,
dependencies, provider secret or token permissions.

**Owner action after inspecting/merging this policy:** in repository Settings →
Rules → Rulesets (or Branches → branch protection), require `review-policy` from
GitHub Actions, alongside standard `typecheck` CI and independent human approval.
Do **not** use `analyze` or `review-execution` as the security gate. The old
`publish` display name is deliberately retired so an existing required `publish`
context cannot silently become passing for Incomplete; replace that requirement
with `review-policy`, not with the execution check. At audit time the main
protection API returned “Branch not protected” and the rulesets API returned no
rulesets. This PR does not change repository settings or claim an enforced merge
gate exists. If made required, human-required reviews remain failing even after a
human COMMENT/approval: there is no automatic waiver or approval-detection path.
An owner must handle exceptional merges through their explicit repository policy,
never by interpreting execution success as review approval.

The historical brownout is separate: if a future startup annotation reports an
event-policy block, an administrator must inspect the applicable Actions event
policy and explicitly allow the trusted-base workflow if appropriate. Do not
switch to PR-head execution, broaden tokens, or claim a code fix resolves a
platform policy block.

### Large/formatting-heavy PRs

Coverage handling now reports mandatory inspection independently of truncation and
labels included paths as **supplied hunks**, not fully inspected files. Omissions
remain explicit and prevent approval under the existing required-scope rules.
Oversized comments abbreviate only the inventory, never findings or the verdict;
the complete inventory stays in the summary/artifact. Split mechanical formatting
from functional changes, or inspect omitted code directly.

No formatting is inferred from PR claims, whitespace-normalized code, or model
assertions. No omitted code is silently approved. Multi-part inference is not
introduced: PR #19 exhausted the source budget across many files and also required
human inspection regardless of extra model coverage. More calls cannot remove
that policy requirement; there is no demonstrated reliability gain sufficient to
justify increased inference/timeout exposure here. Context, per-file, request,
fallback, output, deadline, privacy and zero-dollar limits are unchanged.

PR #19 merged at `f4a11da` before this branch was created. Standard `ci.yml` now
runs its existing `npm run format:check` immediately after `npm ci`, without
formatting/writing/committing files, without changed permissions, and never through
Agent review. Offline tests invoke the actual script on formatted/misformatted
temporary source and verify that failure does not rewrite the source.

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
  `src/model-policy*`, `src/provider*`, `src/local-api*`, the reorganized
  `src/providers/`, `src/github/github-review*`, `src/routing/provider-chain*`,
  and any file named for
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
  disclosed. Every priority 0 file additionally requires human inspection and can never receive
  an automated **Approved** verdict: this preserves the historical workflow/review-policy/
  config/guardrail path set and extends it to security-sensitive non-test files such as
  `SECURITY.md`, `src/auth.ts` and `docs/security-policy.md`. Test-only changes stay
  test-classified (priority 2); only the historical guardrail-module test paths
  (`src/github-review*`, `src/model-policy*`, `src/provider*`, `src/local-api*`,
  plus `src/providers/`, `src/github/github-review*` and `src/routing/provider-chain*`) keep their
  existing human-inspection requirement.
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
If a comment would exceed 60 KB, preserve the verdict/findings with an explicitly abbreviated inventory;
the full filename/reason inventory remains in the job summary and result artifact.

Every publication is a GitHub **COMMENT**, tied to the inspected commit, not an actual GitHub
approval. Incomplete is a valid, honest result: it records that the bounded evidence was
insufficient instead of guessing, and it never implies the PR is safe. Valid Incomplete is
published where possible without failing `review-execution`, but always fails `review-policy`.
Blocking findings also fail `review-policy`, even with incomplete coverage.
Analysis/job execution success,
model invocation success, review completion and review approval are separate facts.
Repository settings must permit `GITHUB_TOKEN` review publication; failures never fall back to a PAT.

## Diagnostics and investigation

Job summary contains the report and allowlisted JSON; seven-day `bounded-review-result` artifact
contains only the result, coverage manifest and diagnostics. No raw prompt, provider body or client
logs. Fields include PR/SHA, included/excluded counts, context bytes, conservative token upper
bound, `requestCount`, `fallbackAttempts`, provider/model, duration, safe category/status, token
usage when supplied, `modelSuccess`, `cliSuccess`, `reviewComplete`, `reviewApproved`, `fullScope`.
`verdictValid`, `humanRequired`, `executionSuccess` and allowlisted `executionError` distinguish
valid verdicts, human policy requirements and failed execution.
`publicationSuccess` and a safe GitHub HTTP status distinguish publication failures; missing
execution artifacts report unknown request counts (`null`), never an invented successful call.

Example (synthetic local live smoke, no GitHub publication):

```json
{"route":"opencode:mimo-v2.6-pro","requestCount":1,"fallbackAttempts":0,
 "durationMs":11369,"inputTokens":332,"outputTokens":440,
 "outcome":"Has blocking changes needed","modelSuccess":true,"cliSuccess":true}
```

1. Check **review-policy**, **review-execution**, the final verdict and safe execution diagnostics,
   not just analysis success. A policy failure alone is not an infrastructure failure.
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

For this reliability fix, before merge run `npm run format:check`, `npm run typecheck`,
`npm test` and `git diff --check`. Mocked tests cover the loopback analysis/artifact
handoff (including cached retries), complete approval, partial/human-required
Incomplete, findings with omitted code, invalid artifacts/locations/diagnostics,
provider/client/invalid-output failures, publication errors and stale head/base.
The policy tests execute the actual workflow shell for success/failure/skipped/
cancelled/missing dependency results; no live inference or GitHub writes occur.

After owner merge, validate on **new small owner PRs**, not by altering PR #19:

1. A non-security one-file change should yield a SHA-bound COMMENT and both execution/
   policy success only if the model returns a valid complete Approved verdict.
2. A deliberately obvious correctness defect should publish actionable findings;
   execution succeeds, policy fails. Do not merge the defect.
3. A large formatting-heavy change should disclose omitted paths and remain
   Incomplete (or blocking if findings exist); execution succeeds, policy fails.
4. A tiny `src/local-api`/workflow change must report mandatory human inspection
   and fail policy even if all hunks fit. No COMMENT may become GitHub APPROVE.
5. Confirm invalid-output/provider/client failures fail analysis/execution with a
   retained diagnostic artifact; head/base movement fails stale publication.
   Prefer the mocked fault tests over deliberately exhausting live provider calls
   or changing production credentials/settings.
6. Confirm standard CI rejects a deliberately misformatted temporary PR commit,
   then passes after **local** formatting; CI itself must never change files.
7. Inspect required-check settings and the PR merge box: only `review-policy` is
   the review gate. A missing/cancelled review is never permission to merge.

Live hosted verification requires owner-authorized inference and trusted main;
local mocked coverage is not a claim that the new hosted workflow has run.

Known limits: this remains a bounded, diff-based, advisory review, not a comprehensive
code review. Diff-only review lacks unchanged-file context; GitHub patch truncation and
large source changes produce partial coverage; under the fixed budget large
test/documentation patches are truncated or entirely omitted even when production
evidence is complete; redaction is heuristic; optional CI snapshots can be
incomplete. Model quality/injection resistance is not guaranteed. Runner/API/installation failures
can prevent even Incomplete publication. Human review and CI remain mandatory independent gates.
See [SECURITY.md](../../SECURITY.md#github-pr-review-trust-boundaries).
