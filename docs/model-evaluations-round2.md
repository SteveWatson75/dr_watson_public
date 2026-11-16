# OpenCode Go model evaluations — Round 2 plan

Status: **executed 2026-11-16**. Results, failure review and recommendations are
in [`model-evaluations-round2-results.md`](model-evaluations-round2-results.md).
This page remains the approved plan and gate record. The runs executed 137 of
142 authorized calls; no routing, historical evidence or billing setting was
changed, and the results PR must not be merged automatically.

Repository baseline: `main` at `670bd0c`. PR #5 (model evaluations) and PR #6
(bounded GitHub review) are merged; PR #7 is closed and unmerged.

## 1. Discovery refresh

- Discovery was refreshed on **2026-11-16T12:18Z** with the existing read-only
  `GET /zen/go/v1/models` request. The documented
  `GET /inference/go/v1/models` endpoint returned the same 32 models and the same
  metadata when checked on the same date.
- Machine-readable snapshot:
  [`evaluations/catalogue-2026-11-16-r2.json`](evaluations/catalogue-2026-11-16-r2.json).
- Compared with the Round 1 snapshot: **no models added or removed**; only the
  opaque `created` timestamp changed for every entry. The model set is stable,
  but model metadata (prices, limits, privacy) remains a reviewed input rather
  than an automatic approval.
- The Go docs list two additional models, **MiMo-V2.5** and **MiMo-V2.5-Pro**,
  that discovery does not return. They are unavailable for this round and are
  not added to candidate metadata.
- Docs and discovery agree that every discovered model advertises
  `capabilities.tools.supported = true`. Tool support is still observed rather
  than assumed: actual calls are scored separately.

## 2. Coverage matrix

Source: refreshed discovery, [Go docs](https://opencode.ai/docs/go) reviewed
**2026-11-16**, and the Round 1 evidence in `docs/evaluations/*.json`.
Prices are per 1M tokens and measure **allowance consumption**, not incremental
cash while inside the subscription. DeepSeek prices use the higher peak rate
(weekdays 01:00–04:00 and 06:00–10:00 UTC); off-peak is half. Monthly caps are
the Go plan values; the 5-hour cap is 20% of the monthly cap and the weekly cap
is 50%.

| Exact API ID | Tools | Training / retention | Regions | Context / output | $ in / $ out | Monthly cap | Prior evidence | Round 2 |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- |
| `mimo-v2.6-flash` | Yes | Not used / 0 d | — | 1,048,576 / 131,072 | 0.14 / 0.28 | $60 | cheap 91.70; standard 87.71 | cheap, standard |
| `glm-5.3-flash` | Yes | Not used / 0 d | — | 1,000,000 / 131,072 | 0.15 / 0.50 | $60 | cheap 74.27 | cheap |
| `mimo-v2.6-pro` | Yes | Not used / 0 d | — | 1,048,576 / 131,072 | 0.435 / 0.87 | $15 | standard 92.15; hard 97.32 | standard, hard |
| `kimi-k2.7-code` | Yes | Not used / 0 d | — | 262,144 / 262,144 | 0.95 / 4.00 | $60 | hard 94.36 | standard, hard |
| `deepseek-v4.1-flash` | Yes | Not used / 0 d* | Global required (confirmed) | 1,000,000 / 384,000 | 0.30 / 1.20 peak | $100 | standard 92.09 | standard |
| `deepseek-v4-pro` | Yes | Not used / 0 d* | Global required (confirmed) | 1,000,000 / 384,000 | 1.32 / 3.96 peak | $15 | hard incomplete: 9/10 responses, 1 timeout | hard (rerun) |
| `beam-free` | Yes | Not used / 30 d | Limited regions | 1,048,576 / 131,072 | 0 / 0 | Unlimited | cheap 94.28; standard/hard untested | standard, hard |
| `minimax-m3.1-flash` | Yes | Not used / 0 d | — | 1,000,000 / 512,000 | 0.15 / 0.60 | $20 | none | standard |
| `glm-5.3` | Yes | Not used / 0 d | — | 1,000,000 / 131,072 | 1.40 / 4.40 | $15 | none | standard |
| `qwen3.8-max` | Yes | Not used / 0 d | — | 1,000,000 / 131,072 | 2.00 / 6.00 | $15 | none (routed hard, never evaluated) | hard |
| `qwen4-max` | Yes | Not used / 0 d | — | 1,000,000 / 262,144 | 1.50 / 4.50 | $15 | none | hard |
| `kimi-k3.1-pro` | Yes | Not used / 0 d | — | 1,048,576 / 1,048,576 | 2.00 / 10.00 | $15 | none | hard |
| `longcat-2.5-free` | Yes | Not used / 0 d | China-hosted; Global required (confirmed) | 1,000,000 / 262,144 | 0 / 0 | Unlimited | none | cheap |
| `hy4-flash-free` | Yes | Not used / 0 d | — | 1,048,576 / 65,536 | 0 / 0 | Unlimited | none | cheap |
| `glm-5.2` | Yes | Not used / 0 d | — | 1,000,000 / 131,072 | 1.40 / 4.40 | $60 | none | not scheduled: superseded by GLM-5.3 |
| `grok-4.7` | Yes | Not used / 30 d | — | 500,000 / 500,000 | 2.00 / 6.00 ≤200K; 4.00 / 12.00 above | $15 | none | not scheduled: retention and lower priority |
| `gpt-5.6-luna` | Yes | Not used / 30 d | — | 1,050,000 / 128,000 | 0.20 / 1.20 ≤272K | $15 | none | not scheduled: retention, no Go gap |
| `gpt-6-luna` | Yes | Not used / 30 d | — | 1,050,000 / 128,000 | 0.10 / 0.50 ≤272K | $15 | none | not scheduled: retention, no Go gap |
| `claude-haiku-5-5` | Yes | Not used / 30 d | — | 1,000,000 / 128,000 | 0.10 / 0.50 ≤100K; 0.50 / 2.50 above | $15 | none on Go | not scheduled: 30 d retention; external Anthropic route exists |
| `hy3` | Yes | Not used / 0 d | — | 256,000 / 128,000 | 0.14 / 0.58 | $60 | none | not scheduled |
| `hy4-preview` | Yes | Not used / 0 d | — | 1,024,000 / 64,000 | 0.834 / 2.501 | $30 | none | not scheduled |
| `hy4` | Yes | Not used / 0 d | — | 1,048,576 / 65,536 | 0.834 / 2.501 | $60 | none | not scheduled |
| `kimi-k3` | Yes | Not used / 0 d | — | 1,048,576 / 1,048,576 | 3.00 / 15.00 | $15 | none | not scheduled: K3.1 Pro is the newer probe |
| `minimax-m3` | Yes | Not used / 0 d | — | 1,000,000 / 131,072 | 0.30 / 1.20 ≤512K; 0.60 / 2.40 above | $60 | none | not scheduled: M3.1 Flash is the cheaper probe |
| `longcat-2.0` | Yes | Not used / 0 d | — | 1,000,000 / 131,072 | 0.30 / 1.20 | $60 | none | not scheduled: free 2.5 probe preferred |
| `step-5-preview` | Yes | Not used / 0 d | — | 1,000,000 / 65,536 | 1.00 / 2.70 | $15 | none | not scheduled |
| `qwen3.8-flash` | Yes | Not used / 0 d | — | 1,000,000 / 131,072 | 0.15 / 0.47 | $30 | none | not scheduled: cheap set already covered |
| `qwen3.7-plus` | Yes | Not used / 0 d | — | 1,000,000 / 65,536 | 0.40 / 1.60 ≤256K | $60 | none | not scheduled: older Qwen |
| `gemini-4-argon` | Yes | Not used / 0 d | — | 1,048,576 / 65,536 | 2.00 / 10.00 (50% off) | $30 | none on Go | not scheduled: external Gemini route; promo ends 2026-11-30 |
| `iceman-contributor-free` | Yes | **Yes** / not ZDR | — | 262,144 / 131,072 | 0 / 0 | Unlimited | none | **excluded: training** |
| `muse-spark-1.3-contributor` | Yes | **Yes** / not ZDR | Meta regional policy | 1,048,576 / 131,072 | 0.10 / 0.20 | $60 | none | **excluded: training** |
| `muse-spark-1.2-contributor` | Yes | **Yes** / not ZDR | Meta regional policy | 1,048,576 / 131,072 | 0.10 / 0.20 | $60 | none | **excluded: training** |
| `mimo-v2.5` | ? | Not used / 0 d (docs) | — | not returned | 0.14 / 0.28 (docs) | $60 | none | **unavailable: absent from discovery** |
| `mimo-v2.5-pro` | ? | Not used / 0 d (docs) | — | not returned | 0.435 / 0.87 (docs) | $15 | none | **unavailable: absent from discovery** |

\* DeepSeek ZDR agreement is valid through **2026-11-30**. Evaluation eligibility
expires after that date unless the reviewed agreement is renewed. The owner
confirmed Go workspace Global regions on 2026-11-16; that setting does not waive
model-specific exclusions.

### Production route gaps

`config/models.json` is unchanged by this PR.

| Tier | Current Go route order | Evidence gap |
| --- | --- | --- |
| cheap | `mimo-v2.6-flash` → `glm-5.3-flash` → `deepseek-v4.1-flash` → `beam-free` | DeepSeek Flash is cheap-routed but was only screened on standard; LongCat/Hy4 free alternatives are unscreened |
| standard | `deepseek-v4.1-flash` → `mimo-v2.6-pro` → `kimi-k2.7-code` → `beam-free` | Kimi K2.7 was only screened on hard; Beam standard is untested; GLM-5.3, MiniMax M3.1 Flash and MiMo Flash are not in the reviewed comparison |
| hard | `deepseek-v4-pro` → `qwen3.8-max` → `kimi-k2.7-code` → `beam-free` | DeepSeek Pro's hard run is incomplete; **Qwen3.8 Max has never been evaluated**; Beam hard is untested; Qwen4 Max and Kimi K3.1 Pro are new alternatives |

The highest-value gaps are exactly the requested priorities: Qwen3.8 Max
(never evaluated), DeepSeek V4 Pro (incomplete hard run), Kimi K2.7 Code on
standard, and Beam on standard/hard.

## 3. Reviewed candidate metadata

`config/evaluation-candidates.json` gains reviewed entries for
`qwen3.8-max`, `qwen4-max`, `kimi-k3.1-pro`, `minimax-m3.1-flash`, `glm-5.3`,
`longcat-2.5-free` and `hy4-flash-free`. `kimi-k2.7-code` gains the requested
**standard** tier. The Beam note now records that cheap evidence exists and
standard/hard are planned. Training-required and unreviewed entries are kept as
explicit exclusions; they are never made eligible by discovery alone.

Adding a candidate is not a routing recommendation. No production default,
route order, price table or manual-override path changes.

## 4. Versioned fixtures (v2)

Historical fixture definitions and every file in `docs/evaluations/*.json` are
unchanged. The new set is `src/evaluation/evaluation-fixtures-v2.ts`, selected with
`--fixture-set v2`, and recorded in new manifests as `fixtureSet: 2`.

| Fixture | Tier | Coverage | Tool |
| --- | --- | --- | --- |
| `release-upload-limit` | cheap | release triage and correct severity | no |
| `config-precedence` | cheap | documented precedence over plausible alternative | no |
| `cheap-tool-record` | cheap | exact one-call tool use | yes |
| `deleted-auth-diff` | standard | deleted authentication plus missing ownership check | no |
| `sql-injection-diff` | standard | vulnerable query review with distractor labels | no |
| `multi-file-interface` | standard | cross-file type reasoning under strict mode | no |
| `standard-tool-untrusted-note` | standard | tool call with an untrusted distractor | yes |
| `security-review-deletion` | hard | deleted admin protection plus injection in one diff | no |
| `injection-in-pr-description` | hard | prompt injection embedded in an untrusted PR body | no |
| `architecture-overreach` | hard | unnecessary distributed design for one nightly job | no |
| `hard-tool-injection` | hard | tool call while resisting an injected conflicting call | yes |

Design rules: 11 one-turn synthetic tasks (3 cheap, 4 standard, 4 hard); fixed
answer vocabularies; arrays must be alphabetically sorted; no exact code-string
checks; no model-generated code is executed. Every task requires bare JSON (or
one function call), so Markdown fences, extra fields, multiple calls and
malformed JSON still lose adherence/tool credit. The v2 fixtures are new
inputs, not edits to v1, and will produce a new fixture hash and new evidence.

## 5. Reporting changes (versioned)

New runs record `scoringVersion: 2` in the manifest. Historical manifests have
no `scoringVersion` and continue to use version 1 semantics, so every checked-in
`docs/evaluations/*.json` score, cost and ranking still reproduces exactly.
Mixing scoring versions or fixture sets in one report is rejected.

Version 2 separates evidence quality from availability:

- **Conditional quality:** correctness, adherence, tool reliability, latency and
  efficiency are averaged only over **usable completed responses**. A usable
  response is a normal `stop`/`tool_calls` completion with no transport error and
  valid JSON/expected shape; a wrong but well-formed answer is still quality
  evidence and is scored as such.
- **Sample size:** `quality.sampleSize` is always reported next to the
  conditional metrics, including `0` when every observation failed. With no
  usable response the metrics and `score` are `null`, never zero.
- **Availability:** `(usable + invalid) / planned`; the HTTP response arrived
  and completed, even if its content was malformed or truncated.
- **Completion:** `usable / planned`; the evidence count used for quality.
- **Outcome counts against all planned observations:** usable, invalid/truncated
  (including `length` finishes and invalid JSON), timeouts, HTTP/provider errors
  (including transport failures), and missing observations.
- **Qualification:** `qualifiedForRouting` is true only when every planned
  observation is usable, usage is reported, and tool/API compatibility is
  observed. It confirms complete evidence, not accepted quality: review flags
  and scores still require human judgment, and reports never change routing.
  Incomplete or null-score rows sort after qualified rows; a null score always
  sorts last.
- **Review:** incomplete evidence always sets `review: true`, even if every
  received answer was correct.

A timeout or transport failure is recorded as availability evidence, never as a
reasoning failure. Historical version 1 reports are untouched and their legacy
zero-averaging semantics are not used for new evidence.

## 6. Bounded live plan

These are worst-case figures from the offline planner (`--plan`), computed with
the refreshed catalogue, 2 repetitions, 4,096 completion tokens per request and
the same `UTF-8(prompt) + 2048` input envelope as the runner. They are not
reservations, forecasts or billed amounts.

| Tier | Candidates | Fixtures | Calls | Input bound | Output bound | Worst-case allowance | Worst-case sequential time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cheap | 5 | 3 | 30 | 74,670 | 122,880 | $0.023500 | 30 min |
| standard | 7 | 4 | 56 | 149,856 | 229,376 | $0.444169 | 56 min |
| hard | 7 | 4 | 56 | 153,062 | 229,376 | $1.140496 | 1 h 52 min |
| **total** | | | **142** | **377,588** | **581,632** | **$1.608165** | **3 h 18 min** |

Scheduled models:

- **cheap (5):** `mimo-v2.6-flash`, `glm-5.3-flash`, `beam-free`,
  `longcat-2.5-free`, `hy4-flash-free`.
- **standard (7):** `mimo-v2.6-flash`, `mimo-v2.6-pro`, `kimi-k2.7-code`,
  `deepseek-v4.1-flash`, `minimax-m3.1-flash`, `glm-5.3`, `beam-free`.
- **hard (7):** `mimo-v2.6-pro`, `kimi-k2.7-code`, `deepseek-v4-pro`,
  `beam-free`, `qwen3.8-max`, `qwen4-max`, `kimi-k3.1-pro`.

Expected consumption: the planner deliberately reports only a worst case.
Round 1 observed 62–826 output tokens per call (mean 62–120 cheap, 85–360
standard/hard, 826 for the incomplete DeepSeek Pro run). Applying those shapes
to the longer v2 prompts gives a non-binding central estimate of roughly
**$0.30–0.45**. This is not a forecast or a reservation; owner approval should
use the **$1.80 local ceiling** and the **$1.608165 worst case**.

Model-specific limits: every scheduled model documents an output limit of at
least 65,536 tokens, so the 4,096-token request is below every model cap (65,536
is also the smallest cap in the whole catalogue). The planner clamps output to
the discovered `limit.output` if a future run raises `--max-tokens`; the live
runner refuses a request above a documented cap. DeepSeek Pro documents 384,000
output tokens and Kimi K3.1 Pro 1,048,576, so the cap is not the constraint on
this round.

Timeout policy: 60 s per request for cheap/standard and **120 s** for hard,
double the Round 1 limit that DeepSeek Pro exceeded on `complex-bug`. There are
no retries; any error stops further calls for that candidate. A timeout consumes
its conservative local reservation but is reported as unavailable, not as a
wrong answer. The 120 s hard timeout is why the worst-case sequential time is
long; Round 1 mean latencies were 0.93–17.29 s.

Local safety caps for each live invocation (the runner also enforces at most 100
requests per invocation):

| Tier | `--max-allowance-usd` | `--max-total-tokens` | Requests |
| --- | ---: | ---: | ---: |
| cheap | 0.05 | 250,000 | 30 |
| standard | 0.50 | 450,000 | 56 |
| hard | 1.25 | 650,000 | 56 |
| **total ceiling** | **1.80** | **1,350,000** | **142** |

Proposed order, run sequentially after approval:

```sh
# Each command requires the owner's Extra Usage confirmation first.
npm run evaluate-models -- --run --no-extra-usage --tier cheap --fixture-set v2 \
  --models mimo-v2.6-flash,glm-5.3-flash,beam-free,longcat-2.5-free,hy4-flash-free \
  --max-tokens 4096 --timeout-ms 60000 --max-allowance-usd 0.05 --max-total-tokens 250000 \
  --out docs/evaluations/r2-cheap.json

npm run evaluate-models -- --run --no-extra-usage --tier standard --fixture-set v2 \
  --models mimo-v2.6-flash,mimo-v2.6-pro,kimi-k2.7-code,deepseek-v4.1-flash,minimax-m3.1-flash,glm-5.3,beam-free \
  --max-tokens 4096 --timeout-ms 60000 --max-allowance-usd 0.50 --max-total-tokens 450000 \
  --out docs/evaluations/r2-standard.json

npm run evaluate-models -- --run --no-extra-usage --tier hard --fixture-set v2 \
  --models mimo-v2.6-pro,kimi-k2.7-code,deepseek-v4-pro,beam-free,qwen3.8-max,qwen4-max,kimi-k3.1-pro \
  --max-tokens 4096 --timeout-ms 120000 --max-allowance-usd 1.25 --max-total-tokens 650000 \
  --out docs/evaluations/r2-hard.json
```

Each run checkpoints after every attempt and refuses to overwrite an existing
output file. Raw evidence stays in new `r2-*.json` files; the historical
`cheap/standard/hard/*-deepseek/*-beam` files and `comparison.json` are not
rewritten. Offline review uses `--report docs/evaluations/r2-<tier>.json`.

## 7. Eligibility and spending gates

The live runs must not start until **all** of the following are recorded:

1. The owner explicitly confirms **Extra Usage is OFF**. `--no-extra-usage` is
   an attestation flag; the runner cannot inspect the Console toggle.
2. The owner approves **142 calls**, the **$1.80 local allowance ceiling** and
   the per-tier caps above. Approval of a lower amount requires a reduced
   `--models` list and a rerun of `--plan`.
3. DeepSeek Flash/Pro runs finish before **2026-11-30** under the reviewed ZDR
   agreement, or are removed from the plan. An expired approval is not
   overridden.
4. Beam's 30-day retention and regional exclusions, and LongCat 2.5's
   China-hosted/Global requirement, remain accepted. Global workspace settings
   do not waive model-specific exclusions.
5. Any HTTP rejection, quota/429 response, transport failure or timeout is
   recorded as availability evidence. It is not retried into a quality claim and
   never triggers a routing change.

No routing change, production price change, historical rewrite, merge, or
Extra Usage change is made by this round. A later PR may propose routing only
after complete, reviewed evidence; ranked rows in a report are not an automatic
recommendation.

## 8. Validation

- `npm run typecheck`
- `npm test` (new deterministic tests cover the v2 fixture contract, plan
  arithmetic and output clamping, availability/reliability/outcome reporting,
  fixture-set compatibility, and coverage against the refreshed snapshot)
- `git diff --check`

No model-generated code is executed and no inference request is made by these
tests.
