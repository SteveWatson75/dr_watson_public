# OpenCode Go evaluations — Round 2 results

Status: **executed 2026-11-16** under the owner's authorization. This is
screening evidence and a recommendation for human review. No production
routing, price table, historical result or billing setting was changed, and this
results PR must not be merged automatically.

Plan and gates: [`model-evaluations-round2.md`](model-evaluations-round2.md).

## 1. Authorization and execution

- Owner confirmed **Extra Usage OFF** and accepted Beam's 30-day retention for
  synthetic tasks plus LongCat 2.5's China-hosted/Global conditions.
- Maximum **142 requests**; **137 executed** and **5 unspent**. `glm-5.3` stopped
  after one transport failure, so its five remaining standard observations were
  not run. They were not retried because a rerun would exceed the authorized
  request count.
- Combined local allowance ceiling **$1.80**; actual estimated allowance
  **$0.153332**.
- Fixture set **v2**, two repetitions, `scoringVersion: 2`, 4,096 completion
  tokens per request.
- Tiers ran sequentially with the approved commands: cheap 60 s timeout,
  standard 60 s, hard 120 s. No retries, paid fallbacks, Extra Usage, or
  additional evaluations.

| Tier | Authorized requests | Executed | Usable | Provider errors | Timeouts | Invalid | Missing | Allowance | Local cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cheap | 30 | 30 | 30 | 0 | 0 | 0 | 0 | $0.000492 | $0.05 |
| standard | 56 | 51 | 50 | 1 | 0 | 0 | 5 | $0.042768 | $0.50 |
| hard | 56 | 56 | 56 | 0 | 0 | 0 | 0 | $0.110071 | $1.25 |
| **total** | **142** | **137** | **136** | **1** | **0** | **0** | **5** | **$0.153332** | **$1.80** |

Tokens: **73,334** local accounting (66,455 reported across successful
responses plus a 6,879 conservative reservation for the failed `glm-5.3` call).
Allowance figures include the runner's conservative failed-call reservation.
There were no HTTP 401/403/429, billing, quota or authentication errors. The one
failure was a 60.0 s transport failure with no HTTP status.

Reports: `docs/evaluations/r2-{cheap,standard,hard}-report.json`.
Raw checkpoints: `docs/evaluations/r2-{cheap,standard,hard}.json`.

## 2. Eligibility, privacy and compatibility

Current discovery returned the same 32 model IDs as the reviewed snapshot, with
no additions or removals and no metadata change other than `created`. Every
scheduled candidate passed current discovery, tool-support, training/retention,
regional and date-expiry checks. The runs completed on 2026-11-16, inside
DeepSeek's ZDR approval through 2026-11-30.

| Excluded or unavailable | Reason |
| --- | --- |
| `iceman-contributor-free` | Request data used to improve the model (training). |
| `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor` | Training required; Meta regional policy. |
| `crouton-alpha-free` | No current privacy evidence; absent from discovery. |
| `mimo-v2.5`, `mimo-v2.5-pro` | Documented by Go but absent from discovery; not schedulable. |

Beam's 30-day retention and regional exclusions, and LongCat 2.5's China-hosted
Global requirement, were accepted by the owner for these synthetic tasks. No
model was excluded for tool incompatibility: every complete model produced the
expected tool call in both tool fixtures (**2/2**). `glm-5.3` standard is
incomplete for availability, not privacy or compatibility.

## 3. Results by tier

`P / T / I / M` = provider errors / timeouts / invalid-or-truncated / missing.
Completion is `usable / planned`; correctness is conditional on usable
responses; tool is `record_result` correctness. Ranking is the report's
five-point-band, cost-aware order; **score order is not a statistical
significance claim**.

### Cheap — 3 fixtures × 2 repetitions

| Rank | Model | Actual / planned | Usable | P / T / I / M | Completion | Exact correctness | Tool | Mean latency | Tokens in / out | Allowance | Qualified | Score |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 1 | `beam-free` | 6 / 6 | 6 | 0 / 0 / 0 / 0 | 100% | 100.0% | 1.00 | 1.09 s | 964 / 553 | $0.000000 | yes | 99.51 |
| 2 | `hy4-flash-free` | 6 / 6 | 6 | 0 / 0 / 0 / 0 | 100% | 100.0% | 1.00 | 2.12 s | 1,072 / 630 | $0.000000 | yes | 99.30 |
| 3 | `longcat-2.5-free` | 6 / 6 | 6 | 0 / 0 / 0 / 0 | 100% | 100.0% | 1.00 | 7.33 s | 936 / 618 | $0.000000 | yes | 98.46 |
| 4 | `mimo-v2.6-flash` | 6 / 6 | 6 | 0 / 0 / 0 / 0 | 100% | 100.0% | 1.00 | 5.19 s | 850 / 358 | $0.000219 | yes | 98.89 |
| 5 | `glm-5.3-flash` | 6 / 6 | 6 | 0 / 0 / 0 / 0 | 100% | 100.0% | 1.00 | 1.26 s | 980 / 252 | $0.000273 | yes | 99.54 |

All five models answered every cheap fixture exactly and made both tool calls
correctly. Free models lead the cost-aware ranking, but are temporary and carry
retention or regional conditions.

### Standard — 4 fixtures × 2 repetitions

| Rank | Model | Actual / planned | Usable | P / T / I / M | Completion | Exact correctness | Tool | Mean latency | Tokens in / out | Allowance | Qualified | Score |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 1 | `beam-free` | 8 / 8 | 8 | 0 / 0 / 0 / 0 | 100% | 100.0% | 1.00 | 2.30 s | 1,556 / 1,877 | $0.000000 | yes | 99.09 |
| 2 | `mimo-v2.6-pro` | 8 / 8 | 8 | 0 / 0 / 0 / 0 | 100% | 100.0% | 1.00 | 4.22 s | 1,348 / 799 | $0.001282 | yes | 98.97 |
| 3 | `deepseek-v4.1-flash` | 8 / 8 | 8 | 0 / 0 / 0 / 0 | 100% | 75.0% | 1.00 | 5.17 s | 1,884 / 1,957 | $0.002914 | yes | 89.80 |
| 4 | `kimi-k2.7-code` | 8 / 8 | 8 | 0 / 0 / 0 / 0 | 100% | 75.0% | 1.00 | 6.56 s | 1,270 / 2,216 | $0.010070 | yes | 89.62 |
| 5 | `minimax-m3.1-flash` | 8 / 8 | 8 | 0 / 0 / 0 / 0 | 100% | 50.0% | 1.00 | 3.97 s | 3,124 / 2,506 | $0.001972 | yes | 80.98 |
| 6 | `mimo-v2.6-flash` | 8 / 8 | 8 | 0 / 0 / 0 / 0 | 100% | 37.5% | 1.00 | 10.70 s | 1,358 / 1,938 | $0.000733 | yes | 75.84 |
| 7 | `glm-5.3` | 3 / 8 | 2 | 1 / 0 / 0 / 5 | 25% | 100.0% | n/a | 6.15 s | 310 / 783 | $0.003879 | no | n/a |

`glm-5.3` completed two standard fixtures exactly, then hit a 60.0 s transport
failure on `multi-file-interface` repetition 1. The runner stopped that
candidate, so five planned observations are missing. Its 6.15 s mean latency
covers only the two usable responses. This is availability evidence, not a
quality conclusion.

### Hard — 4 fixtures × 2 repetitions

| Rank | Model | Actual / planned | Usable | P / T / I / M | Completion | Exact correctness | Tool | Mean latency | Tokens in / out | Allowance | Qualified | Score |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 1 | `beam-free` | 8 / 8 | 8 | 0 / 0 / 0 / 0 | 100% | 91.7% | 1.00 | 5.35 s | 1,630 / 4,298 | $0.000000 | yes | 95.29 |
| 2 | `qwen4-max` | 8 / 8 | 8 | 0 / 0 / 0 / 0 | 100% | 91.7% | 1.00 | 4.50 s | 1,718 / 905 | $0.006650 | yes | 95.93 |
| 3 | `kimi-k3.1-pro` | 8 / 8 | 8 | 0 / 0 / 0 / 0 | 100% | 91.7% | 1.00 | 4.14 s | 2,105 / 1,700 | $0.021210 | yes | 95.81 |
| 4 | `mimo-v2.6-pro` | 8 / 8 | 8 | 0 / 0 / 0 / 0 | 100% | 85.4% | 1.00 | 4.46 s | 1,422 / 909 | $0.001409 | yes | 93.80 |
| 5 | `kimi-k2.7-code` | 8 / 8 | 8 | 0 / 0 / 0 / 0 | 100% | 85.4% | 1.00 | 14.79 s | 1,336 / 5,139 | $0.021825 | yes | 91.54 |
| 6 | `deepseek-v4-pro` | 8 / 8 | 8 | 0 / 0 / 0 / 0 | 100% | 85.4% | 1.00 | 11.95 s | 2,412 / 5,919 | $0.026623 | yes | 91.63 |
| 7 | `qwen3.8-max` | 8 / 8 | 8 | 0 / 0 / 0 / 0 | 100% | 91.7% | 1.00 | 17.97 s | 2,146 / 4,677 | $0.032354 | yes | 93.05 |

Every hard model completed all eight observations, made both tool calls
correctly, blocked the security PR, and resisted the injected tool instruction.
DeepSeek V4 Pro completed this time with no timeout, unlike Round 1.

## 4. Individual failure and scoring-flag review

Exact-match scoring is deliberately conservative. Several hard/standard flags
are attributable to fixture wording or output shape, not demonstrated reasoning
failure:

- **`architecture-overreach` (all hard models):** every model returned
  `decision: simplify`, `alternative: single-transaction`, and named all three
  unnecessary components. They used natural names (`"distributed lock"`,
  `"Kafka"`, `"saga coordinator"`) instead of the expected hyphenated tokens
  (`distributed-lock`, `kafka`, `saga`). This is a fixture vocabulary
  ambiguity, not a reasoning failure. It lowers every hard model's exact
  correctness by the same field.
- **`security-review-deletion`:** three models added `missing-rate-limit` on one
  repetition. The code snippet has no rate limiting, so this is arguably a
  correct extra finding rather than a false positive.
- **`deleted-auth-diff`:** some models reported only `missing-authentication`
  after the session check was removed, treating authorization as moot. The
  fixture definitions distinguish the labels, but the omission is a review
  ambiguity, not evidence of unreliable behaviour.
- **Findings shape:** some models returned findings as objects with a `label`
  field rather than a string array. They identified the correct labels; the
  exact-match penalty is a format issue.
- **`glm-5.3` standard:** one 60 s transport failure; five observations were not
  attempted because the candidate stopped. This is availability evidence and is
  not counted as a wrong answer.

After that review, the complete standard/hard candidates all demonstrated the
intended security, injection-resistance, multi-file and tool-call behaviour.
The exact numeric scores therefore understate quality; recommendations below use
the reviewed substance plus reliability, latency and allowance.

## 5. Recommended primary and fallback

Recommendations only. **No routing change is made by this PR.** The current
production order remains untouched.

| Tier | Primary | Evidence | Fallback | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| cheap | `mimo-v2.6-flash` (retain) | 6/6 exact, 2/2 tools, $0.000219, 5.19 s, zero retention | `glm-5.3-flash` (retain) | 6/6 exact, 2/2 tools, $0.000273, 1.26 s, zero retention | All five candidates tied on correctness. Free candidates are fastest/free but temporary with retention/regional terms. |
| standard | `mimo-v2.6-pro` (promote from fallback) | 8/8 exact, 2/2 tools, $0.001282, 4.22 s, zero retention | `deepseek-v4.1-flash` (retain as fallback) | 8/8 usable, 6/8 exact; reviewed flags only, $0.002914, 5.17 s, zero retention | Beam is 8/8 and free but 30-day retention/temporary, so it stays an emergency free option rather than the privacy-default fallback. |
| hard | `qwen4-max` (new primary recommendation) | 8/8 usable, 11/12 exact, 2/2 tools, $0.006650, 4.50 s, zero retention | `kimi-k3.1-pro` (new fallback recommendation) | 8/8 usable, 11/12 exact, 2/2 tools, $0.021210, 4.14 s, zero retention | Kimi K3.1 Pro is the same score band; Qwen4 Max consumes about one-third the allowance. `qwen3.8-max` was slower/costlier (17.97 s, $0.032354); `deepseek-v4-pro` completed at 91.63 / 11.95 s; `mimo-v2.6-pro` is the economical hard alternate at $0.001409 (93.80). |

Why not the free leaders:

- `beam-free` was perfect on standard and near-perfect on hard, but it is a
  temporary offer, retains synthetic data for 30 days, and has regional
  exclusions. It remains a useful zero-cost emergency fallback, not the
  privacy-default primary.
- `hy4-flash-free` and `longcat-2.5-free` were perfect on cheap, but are
  temporary and (LongCat) China-hosted/Global-gated. They do not justify
  replacing the zero-retention paid pair on a six-call sample.

## 6. Reproduction and integrity

```sh
npm run evaluate-models -- --report docs/evaluations/r2-cheap.json
npm run evaluate-models -- --report docs/evaluations/r2-standard.json
npm run evaluate-models -- --report docs/evaluations/r2-hard.json
```

Reports are deterministic: regenerating them from the raw checkpoints produced
byte-identical files. SHA-256:

| File | SHA-256 |
| --- | --- |
| `r2-cheap.json` | `1771fe84d8eb32bfe56fc50f1a9cc5bbf424ddbfccdfad46266b879e014328fe` |
| `r2-standard.json` | `4c51a666266e0d95240f43f2ada75e7a42ce560135ea465292836c624c94375e` |
| `r2-hard.json` | `8d53601e1ec6f4fa9a7aacd9be6af423a3b5a27a85115eb0953297f09467d5f8` |
| `r2-cheap-report.json` | `805df66aa821e5e4e1936db5fca2ddd96660b18be5522ec1af78a22a24834b3c` |
| `r2-standard-report.json` | `977ccab5fef7cc4b98dd74449261a7b75f304378ea1954b38ec7112001d76170` |
| `r2-hard-report.json` | `291b2189d801fcd7c42da8c5d950faec7ce72d6d4fb4822422a4891fbea7e974` |

Historical Round 1 files and `docs/evaluations/comparison.json` were not
modified.

## 7. Limitations

Two repetitions and three or four fixtures per tier are a screening sample, not
a statistically significant benchmark. Exact vocabulary and output-shape checks
produce false negatives; this run found at least three such ambiguities, so the
recommendations use reviewed evidence as well as the deterministic scores. Mean
latency is sensitive to network and provider load. The 4,096-token screening
limit does not exercise long-output failure modes. No semantic judge, generated
code execution, or production agent loop was used.
