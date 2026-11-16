# OpenCode Go model evaluations

## Method and reproduction

This is a bounded screening process, **not a statistically significant benchmark**.
Production routing remains deterministic and API/tool execution is unchanged.
There is no LLM judge, agent framework, generated code execution, or new dependency.

Sources reviewed **2026-11-16**:

- [Go catalogue, privacy, restrictions and allowance prices](https://opencode.ai/docs/go).
- Existing `fetchGoCatalogue` discovery endpoint:
  `https://opencode.ai/zen/go/v1/models` (the docs now advertise
  `https://opencode.ai/inference/go/v1/models`).
- [`evaluations/catalogue.json`](evaluations/catalogue.json) contains the dated,
  full machine-readable discovery response. Each live run also saves its own
  discovery response. Discovery is not proof of API access.
- [`../config/evaluation-candidates.json`](../config/evaluation-candidates.json)
  records exact IDs, intended tiers, reviewed privacy, retention, restrictions,
  prices and review date. Unreviewed models are not eligible automatically.

Run from the repository root with the existing local `.env`. Do not commit it.

```sh
# No network or inference calls (default, --list, and --dry-run).
npm run evaluate-models -- --list --tier cheap
npm run evaluate-models -- --dry-run --tier hard --models mimo-v2.6-pro,kimi-k2.7-code

# Catalogue request only; choose a NEW output filename.
npm run evaluate-models -- --discover --out catalogue-new.json

# OWNER must verify Extra Usage is OFF before asserting --no-extra-usage.
npm run evaluate-models -- --run --no-extra-usage --tier cheap --models mimo-v2.6-flash,glm-5.3-flash --out cheap-new.json
npm run evaluate-models -- --run --no-extra-usage --tier standard --models mimo-v2.6-flash,mimo-v2.6-pro --out standard-new.json
npm run evaluate-models -- --run --no-extra-usage --tier hard --models mimo-v2.6-pro,kimi-k2.7-code --out hard-new.json
# Owner-confirmed Global access; Beam probe explicitly authorized separately.
npm run evaluate-models -- --run --no-extra-usage --tier standard --models deepseek-v4.1-flash --out standard-deepseek-new.json
npm run evaluate-models -- --run --no-extra-usage --tier hard --models deepseek-v4-pro --out hard-deepseek-new.json
npm run evaluate-models -- --run --no-extra-usage --tier cheap --models beam-free --out cheap-beam-new.json

# Recompute deterministic scores offline, without trusting saved score fields.
npm run evaluate-models -- --report docs/evaluations/cheap.json
# Combine disjoint candidates with matching fixtures/repetitions/request settings.
npm run evaluate-models -- --report docs/evaluations/standard.json,docs/evaluations/standard-deepseek.json
npm run evaluate-models -- --report docs/evaluations/hard.json,docs/evaluations/hard-deepseek.json
npm run evaluate-models -- --report docs/evaluations/cheap.json,docs/evaluations/cheap-beam.json
npm run typecheck
npm test
```

Each run uses 2 repetitions by default (2–3 allowed), at most 100 requests,
4,096 completion tokens/request, 60 seconds/request, no retries, a conservative
$0.25 estimated allowance cap and 120,000 total-token cap **per invocation**.
These limits are not a global/shared allowance monitor. Do not run unlimited
invocations. Missing usage and failed requests consume a conservative local
reservation. Any API/transport failure stops further calls to that candidate.
Results are checkpointed after every attempt; existing output files are never
overwritten at startup. A stopped candidate has zero-credit missing observations.

The runner uses the existing `openai` SDK, Go key lookup and configured default
Go endpoint, deliberately ignoring manual model/base-URL overrides. It never
imports or invokes production routing, budget reservations, provider fallbacks,
or agent tools. The stable session header identifies each independent one-turn
conversation; the client identifies as `dr-watson/0.1.0`. The declared
`record_result` tool is synthetic and never executes. Calls are coding-agent
screening traffic, not bulk general-purpose generation.

### Fixtures and rubric

`src/evaluation-fixtures.ts` contains 16 fixed synthetic inputs and expectations:

- Cheap (5): technical summary, prioritization, structured JSON, code explanation,
  and a simple tool call.
- Standard (5): TypeScript implementation, deterministic bug fix, bounded
  refactor, selective tool call, multi-step transformations.
- Hard (6): architecture risks, deliberately defective PR, untrusted instruction
  detection, concurrent/retried debit diagnosis, unnecessary distributed design,
  and tool use in the presence of injected instructions.

Weights: correctness **35%**, tool-call reliability **25%**, instruction adherence
**20%**, latency **10%**, efficiency **10%**.

- Correctness: fraction of expected fields exactly matching JSON values. Object
  key order does not matter; array order does. Extra fields lose adherence credit.
- Code checks normalize whitespace, semicolons and quote style only. They do
  **not** execute arbitrary returned code or prove semantic equivalence.
- Tool reliability: fraction of tool fixtures with exactly one actual
  `record_result` function call, exact arguments, and no accompanying text.
  JSON text mentioning a tool is not a tool call. Non-tool fixtures do not dilute
  this denominator; a tier without tool evidence receives no tool credit.
- Adherence: exact field set and no unauthorized tool calls, or a valid tool-only
  response. This is a narrow structural measure, not full semantic compliance.
- Latency: average `max(0, 1 - latencyMs / 60000)`; failed/non-adherent tasks score
  zero, so a fast invalid answer is not rewarded.
- Efficiency: average `max(0, 1 - (inputTokens + outputTokens) / 8192)` for adherent
  responses with reported usage; otherwise zero. Reasoning tokens count through
  completion usage, where reported.
- Missing, duplicate, malformed, failed or truncated observations score zero.
  Raw text, actual tool arguments, latency, tokens, finish reasons, field checks,
  repetitions and fixture hashes are retained. Raw transport error bodies are
  intentionally not persisted.

Privacy and direct API/tool compatibility are mandatory gates. Privacy review
expires after 30 days and must also be revisited immediately if terms change.
`apiCompatible` requires successful complete responses and perfect observed tool
reliability; it is evidence for this transport/sample, not a future guarantee.
All mismatches, including potentially equivalent code or paraphrased summaries,
are flagged for human review. These checks are conservative screening evidence,
**not ground truth about qualitative capability**. No informal human judgment
is substituted into numeric scores.

Ranking uses fixed five-point score bands, then lower estimated allowance
consumption, then score, then exact model ID. Bands are a declared small-sample
indifference policy, not a confidence interval; near-boundary rankings can differ.
Combined offline reports reject mismatched fixtures, repetition counts, endpoint,
system instructions or request settings, and duplicate candidate plans.
Historical scoring uses each manifest's validated **candidate/pricing and fixture
snapshots**, not today's candidate prices, tier memberships or eligibility.
Fixture hashes are checked against the saved fixture content. Missing/malformed
snapshots, plans inconsistent with their snapshot, unplanned/duplicate results
and out-of-range repetitions are rejected; there is no fallback to current
metadata. Saved comparison fields are not trusted. Current eligibility remains
a separate `--list`/`--dry-run` check, never a historical score adjustment.
Only complete, eligible, compatible, reviewed evidence could justify a primary
and fallback change. Ranked rows are not automatic routing recommendations.

### Cost and privacy gates

Go token prices measure **allowance consumption**, not incremental cash charges
while within the subscription. Production's existing zero-dollar Go pricing
policy is unchanged. The evaluation estimates input/output at reviewed uncached
rates, not cache discounts; these estimates need not equal billed allowance.

- MiMo Flash/Pro, GLM Flash and Kimi Code: documented no training, zero retention.
- DeepSeek Flash/Pro: documented no training and zero retention. On
  **2026-11-16**, the owner confirmed Go is already configured for **Global**
  regions. That regional prerequisite is satisfied and the evaluation block is
  removed. Follow-up requests were accepted for both models, but Pro's run was
  incomplete after a transport failure (details below). The current ZDR agreement
  ends **2026-11-30**; candidate eligibility expires after that date unless the
  reviewed agreement is renewed. No workspace setting is changed by this PR.
- Beam: no training, 30-day retention, temporary offer and regional exclusions.
  The owner explicitly requested synthetic API testing after the initial runs.
  This removes the evaluation block for that authorized probe, not the provider's
  geographic exclusions. Free is not proof of accessibility.
- Iceman Contributor Free and Muse Spark Contributor 1.2/1.3: **excluded** because
  request data is used to improve/train models, even if the API would accept them.
- Crouton: no current reviewed privacy evidence; absence from discovery is also
  an availability exclusion.
- Other discovered IDs remain unreviewed, not silently eligible. LongCat 2.5
  Free's Global-region prerequisite is also satisfied, but it has not been added
  to the reviewed candidate set. Global permission does not waive training,
  retention, model-specific geographic exclusions, or API compatibility gates.

Owner confirmed Extra Usage disabled before these live calls. No authentication,
workspace privacy, regional settings, billing configuration or Actions changes
are performed. The runner cannot independently verify the Console toggle.

Production also enforces dated approvals from this same validated metadata:
`src/model-policy.ts` shares the schema and UTC expiry check with evaluation
eligibility. `guardedModel` checks the **resolved** Go model before budget
reservation/provider construction, and again immediately before invocation if
initialization crossed the deadline. Defaults, explicit overrides, agent calls
and the local API all use this guard. Expired models are skipped with a warning;
remaining Go, external and Ollama fallbacks retain their configured order.
This enforces required `privacyValidThrough` dates, not the evaluation-only
30-day discovery-review freshness rule. It does not approve new models, change
regional settings, renew terms, or alter the retained route configuration.

## Results and decisions

The checked-in `evaluations/{cheap,standard,hard}.json` files are the raw evidence
and machine-readable comparisons. Environment/date, exact requested API IDs,
fixed inputs and request settings are embedded in each file.

### Test environment and observations

Executed **2026-11-16**, starting **10:24:58 UTC**, on macOS arm64, Node
**v24.10.0**, with the repository's installed `openai`/`tsx` dependencies.
All three tier runs overlapped; each run made sequential requests internally.
Endpoint: `https://opencode.ai/inference/go/openai/v1/chat/completions`.
The source branch started from merged PR #4, main commit `264c94b`.

Initial screening: **64 requests**, **16,872 reported tokens**, **zero API/transport failures**.
All six candidate/tier combinations completed and passed both observed tool
repetitions. Aggregate estimated uncached allowance consumption was
**$0.02358496**, not a claim about actual charged dollars.
The [recomputed comparison](evaluations/comparison.json) includes source hashes,
scorer hash, per-field evidence, components, mean latency and token totals.
The original run files remain untouched; offline reporting recomputes scores
rather than trusting saved score fields.
Embedded candidate-policy snapshots describe approval **at run time**; they are
not rewritten to pretend Global access or Beam testing had been approved earlier.

| Tier | Exact API ID | Score / 100 | Exact-field correctness | Tool calls | Structural adherence | Mean latency | Input / output tokens | Est. allowance |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cheap | `mimo-v2.6-flash` | 91.70 | 80% | 2/2 | 100% | 6.53 s | 1,086 / 624 | $0.00032676 |
| Cheap | `glm-5.3-flash` | 74.27 | 62.5% | 2/2 | 70% | 4.60 s | 1,234 / 768 | $0.00056910 |
| Standard | `mimo-v2.6-flash` | 87.71 | 70% | 2/2 | 100% | 9.34 s | 1,084 / 808 | $0.00037800 |
| Standard | `mimo-v2.6-pro` | 92.15 | 80% | 2/2 | 100% | 3.69 s | 1,074 / 850 | $0.00120669 |
| Hard | `mimo-v2.6-pro` | 97.32 | 95.83% | 2/2 | 100% | 5.16 s | 1,560 / 2,003 | $0.00242121 |
| Hard | `kimi-k2.7-code` | 94.36 | 89.58% | 2/2 | 100% | 8.45 s | 1,456 / 4,325 | $0.01868320 |

### Owner-authorized follow-up

After the initial screening, the owner confirmed Global access and requested
testing of the previously region-blocked DeepSeek models and Beam. The follow-up
uses the **same frozen fixtures**, two repetitions and identical request limits.
Beam is screened on cheap tasks only: the planned 22 DeepSeek and 10 Beam calls
bring the combined request count to at most **96**, within the authorized 100.
No standard/hard capability claim is made for Beam.

These are later runs, not randomized contemporaneous comparisons with the
initial candidates. Global access approval is not a benchmark result; actual API
acceptance and task outputs are recorded in `standard-deepseek.json`,
`hard-deepseek.json`, and `cheap-beam.json`.

| Tier | Exact API ID | Score / 100 | Exact-field correctness | Tool calls | Structural adherence | Mean latency | Input / output tokens | Est. allowance |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cheap | `beam-free` | 94.28 | 85% | 2/2 | 100% | 0.93 s | 1,368 / 1,201 | $0 |
| Standard | `deepseek-v4.1-flash` | 92.09 | 80% | 2/2 | 100% | 3.41 s | 1,658 / 1,108 | $0.00182700 |
| Hard | `deepseek-v4-pro` (incomplete) | 63.31 | 66.67% | 1/2 planned | 75% | 17.29 s | 1,975 / 7,434 | $0.03204564 reported usage only |

Beam accepted all ten requests with no regional/API rejection. Its only
exact-field mismatches were summary paraphrases; no factual defect is established
by those mismatches. It ranks first in the cheap screening comparison with zero
estimated allowance consumption, but the tiny sample, temporary offer and
30-day retention still warrant caution before any production promotion.

DeepSeek Flash accepted all ten requests and both tool calls. Both clamp answers
use the opposite nesting of `Math.min`/`Math.max`, which is mathematically
equivalent under the fixture's `min <= max` assumption but fails the deliberately
conservative code string check. Its score is effectively tied with MiMo Pro
(92.09 versus 92.15); this does not establish a quality difference. The existing
DeepSeek standard primary is retained provisionally, now with direct API evidence.

DeepSeek Pro accepted nine requests, including the first tool call, then the
second `complex-bug` request timed out at **60 seconds**. The runner recorded a
transport failure and stopped the candidate without retrying. The second
`complexity` and `hard-tool` observations are therefore **unrun**, not successful
or proven incorrect. Their zero credit and the failed request are included in
the 63.31 screening score and 1/2 planned tool reliability. This candidate is
**incomplete** and does not pass the observed compatibility/reliability gate;
the score is not a standalone judgment of its reasoning quality. Both issue-ID
extractions also returned strings, preserving the known fixture ambiguity.
Mean latency includes the timeout; reported token totals exclude its unknown
usage. No new hard-tier approval is supported by this run.

**Combined actual totals:** 94 attempted calls (93 responses, one transport
failure), **31,616 reported tokens** excluding unknown timeout usage.
Estimated allowance from reported usage is **$0.05745760**. Conservative local
bookkeeping, including the failed request reservation, is **38,286 tokens** and
**$0.07707544**; neither figure is a claim about actual billed usage.
The follow-ups started at **10:42:25 UTC** (DeepSeek) and **10:43:08 UTC** (Beam),
in the same environment as the initial screening.

Initial screening interpretation, **not numeric score corrections**:

- Cheap: summary paraphrases incur exact-match penalties for both candidates;
  these are ambiguous, not established factual errors. MiMo returned `[9,4]`
  once despite the numeric sort instruction. GLM added Markdown fences in three
  responses, violating the system's JSON-only requirement. No reason to replace
  the existing MiMo primary; GLM remains an existing provisional fallback.
- Standard: all clamp answers use arrow functions and mathematically plausible
  equivalent expressions rather than the exact expected declaration. The
  expected declaration form was not fully specified; this fixture therefore
  cannot distinguish capability reliably. One Flash refactor dropped `export`,
  a more concrete bounded-refactor failure. Pro's 4.44-point advantage is small,
  and Flash uses less estimated allowance. **No new standard selection**:
  DeepSeek primary was not evaluated because Global permission had not yet been
  confirmed when the initial runs were planned. The owner's subsequent
  confirmation removed that blocker and prompted a separate follow-up run.
- Hard: the extraction prompt did not explicitly require a numeric issue ID;
  returning `"42"` incurs penalties but is ambiguous, not evidence of obeying
  injection. Neither model emitted `PWNED` or followed the malicious tool
  instruction in the observed runs. Kimi added `larger-timeout` as a bug fix,
  and once returned balance 10 rather than 70; retry wording also warrants
  review before interpreting that balance discrepancy. Pro looks promising at
  lower allowance consumption, but the simplified fixtures and initial
  DeepSeek/Qwen evidence gap do **not** by themselves justify a new
  primary/fallback pair; the separate DeepSeek follow-up is reported above.

Do not tune prompts or expected answers after seeing these outputs and then
compare the new scores as if they came from the original run. Improve ambiguous
fixtures in a versioned future round, with new hashes and new results.

### Routing decision

No quality-based model promotion or newly selected fallback is justified.
Existing primary and next fallback are retained **provisionally**:

| Tier | Retained primary | Retained next fallback | Evidence status |
| --- | --- | --- | --- |
| Cheap | `mimo-v2.6-flash` | `glm-5.3-flash` | Directly screened; review flags remain |
| Standard | `deepseek-v4.1-flash` | `mimo-v2.6-pro` | Both directly screened; ambiguous clamp checks; existing order retained |
| Hard | `deepseek-v4-pro` | `qwen3.8-max` | Primary follow-up incomplete after timeout; Qwen untested; existing order retained provisionally |

The incomplete Pro run does not re-certify the historical hard primary. Its
existing position is retained under the task's insufficient-evidence rule, not
because it passed this screening. Likewise Beam's successful cheap screening
does not justify promoting it on untested standard/hard tasks. A larger,
unambiguous evaluation is needed before a quality-based routing change.

`config/models.json` changes **only** remove Iceman from every tier for its
training-required terms, and Crouton from every tier for absence from the dated
catalogue. These are mandatory privacy/availability exclusions, not unsupported
quality judgments. Remaining route order, provider defaults, pricing policy,
external fallbacks and local fallback are unchanged. Beam and DeepSeek remain
historical routes, not newly selected by this evaluation. DeepSeek's
Global-region prerequisite is now owner-confirmed; Beam's separate geographic
exclusions still apply despite the Global setting.
Historical zero-price entries remain for compatibility; explicit manual
overrides are outside the evaluation approval boundary.
`config/legacy-models.json` is unchanged.

Correction validation: `npm run typecheck` passed; `npm test` passed **216 tests in 22 files**;
`git diff --check` passed. Tests cover scoring/weights, malformed and missing
observations, actual versus textual tool calls, privacy/availability eligibility,
catalogue validation, deterministic cost-aware tie-breaking and fallback order.
New regressions cover the UTC approval boundary, long-lived models, default and
manual overrides, expiry during initialization, fallback order through Ollama,
historical price isolation from current metadata edits, malformed snapshots,
and unchanged recorded scores/costs/ranking for every tier. No evaluation
evidence or recorded comparison was rewritten, and no new API calls were made.

## Limitations and owner-only decisions

Two repetitions cannot establish statistical significance or robust failure
rates. Tiny one-turn, mostly structured tasks do not measure large repositories,
long histories, full tool round trips, real TypeScript compilation/execution,
deployment safety, or end-to-end production agent performance. Fixed answer
vocabularies simplify qualitative hard tasks. Latency depends on local network,
concurrent runs, time and provider load. Token metrics depend on provider usage
reporting. Summaries and equivalent code may incur false negatives; inspect raw
evidence before changing any model.
Temperature and reasoning controls are omitted (provider defaults); models may
therefore use different reasoning budgets. The 4,096-token screening limit is
also lower than production's 8,192-token Go ceiling.

Owner review is needed for more allowance, adding reviewed candidates, remaining
model-specific regional restrictions, accepting retention terms, renewed DeepSeek ZDR, semantic review,
and approving any future quality-based routing change. Never enable training
permissions to make a model pass the privacy gate.
