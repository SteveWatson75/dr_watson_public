# Repository-summary checkpoints (2026-11-08)

> Update: the shipping configuration now advertises 262,144 context tokens (the
> smallest OpenCode Go free route) with `compaction.buffer: "3.125%"`, reserving
> 8,192 tokens and compacting at 253,952. The 32k/25% figures below describe the
> original reproduction.

## Finding and scope

The reproduced checkpoint is **OpenCode compaction output**, not text prepended
by Dr Watson's response serializer or by the model's ordinary repository answer.
OpenCode stores it as `type: "compaction"`, separately from `type: "assistant"`.
However, stopping at that distinction did not explain the Dr Watson-specific
experience: its project configuration advertises a 32k context window, while
OpenCode's default buffer reserves at least 16k. Ordinary repository inspection
therefore triggers premature compaction and can enter a re-read/compact loop.

The experience correction is an explicit `compaction.buffer: "25%"`: reserve
8,192 tokens, matching the advertised output budget, rather than half the window.
The same fresh seven-file summary now completes with **zero checkpoints**.
The percentage scales with other selected models; context limits are not inflated
to assume that all upstream and fallback routes support a larger window.

An independently verified compatibility defect is corrected: OpenCode 2.2.6's
**initial** compaction instruction was not recognised. Without a remembered
route, message preparation mistakes its template headings for an old checkpoint,
removes the instruction, and injects a normal task anchor instead. Recognising
the exact initial instruction preserves it, just like subsequent checkpoint
updates. No output filtering, routing-table changes, or compaction disabling is
introduced.

## Comparison

- Public release: `0744352` (2026-10-19).
- Both GitHub repositories' `src/local-api.ts` blobs, and the private checkout's
  committed implementation: `c3edfa0f9545bdae66d293b20de8a160a0aa2ccf`.
- Both project configurations advertise 32,768 context / 8,192 output tokens and
  customise `agents.compaction.system` with a short checkpoint instruction.
  The public configuration additionally selects Dr Watson as the default model
  and assigns title/summary models.
- The original public checkout has uncommitted API, routing, budget and config
  changes. They were not incorporated or overwritten. A separate worktree based
  on the release was used. The running local API belongs to the public checkout.
- The locally modified implementation was also traced: the small fresh summary
  still selected Beam and produced a clean answer. Its added checkpoint-history
  instructions are not evidence of a fix for transcript compaction records.
- Launcher reports v2.0.30; the actual background service reports **2.2.6**.

## Fresh-session reproduction and redacted trace

Temporary loopback diagnostic servers wrapped the existing transport seam and
logged only route, message roles/field names, character counts, checkpoint
presence, tool names and usage. Prompts, file contents, reasoning text,
credentials and authentication headers are omitted here. Diagnostics allowed
only the existing Go subscription and local fallback, not external paid routes.
Temporary port overrides were restored; no global configuration was changed.

1. Create a fresh `build` session in the released worktree, explicitly selecting
   `dr-watson/dr-watson-auto`. Allow only `read` and deny other tools.
2. Ask for a concise repository summary after reading exactly README.md,
   package.json, src/local-api.ts, src/local-api.test.ts, src/provider.ts,
   src/budget.ts and src/config.ts. Do not edit or delegate.
3. Wait for idle; inspect `/api/session/{sessionID}/message?order=asc&limit=100`.
4. Result: five completed **automatic compaction records**, followed by an
   ordinary assistant answer (1,775 characters, no checkpoint headings).
   The checkpoints have Objective, Requirements, Decisions, Work State,
   Next Move, Relevant Files and Important Context headings.

All successful completions used `opencode:beam-free`. Paid Go models hit their
usage limits; the unavailable LongCat fallback was skipped. The locally modified
route list similarly skipped unavailable Crouton before selecting Beam.

Representative upstream response shapes (content redacted):

| Request | Finish | Content chars | Checkpoint headings | Reasoning chars |
| --- | --- | ---: | --- | ---: |
| Read files | tool_calls | null | no | 151 |
| First automatic compaction | stop | 2,132 | yes | 5,823 |
| Final ordinary answer | stop | 1,775 | no | 527 |

Compaction prompt usage was about 25k tokens. The advertised small context window
and OpenCode's automatic compaction budget explain why ordinary reconnaissance
can trigger compaction. In service 2.2.6, the default threshold is 32,768 minus
the 16,384-token buffer; explicit `"25%"` raises it from 16,384 to 24,576.
OpenCode uses its own context estimates/previous usage to decide when to compact,
not the next upstream response's eventual prompt-token count.

### Corrected experience and comparison

Using the same background service as the desktop app, a fresh `build` session,
the same seven-file request, read-only permissions and the same successful
`opencode:beam-free` route:

| Configuration | Automatic checkpoints before first summary | Answer chars | Checkpoint headings in answer |
| --- | ---: | ---: | --- |
| Original default buffer | 5 | 1,775 | no |
| Explicit 8,192-token buffer (initial trial) | 0 | 2,245 | no |
| Final `"25%"` buffer | 0 | 2,182 | no |
| Direct `opencode-go/beam-free` | 0 | 2,283 | no |

The direct Beam catalogue entry advertises 1,048,576 context tokens, explaining
why the same inspection does not cross its compaction threshold. There is no
need to change Dr Watson's conservative routed-model limit to match it.

The final corrected Dr Watson session then received a second request for a
one-sentence summary without tools. Its grown history triggered **one completed
automatic compaction**, then a clean 289-character answer with no tool re-reads.
This proves automatic compaction still operates beyond the new threshold; the
fix does not suppress checkpoints when compaction is actually needed.

These are live service/API transcript checks, not a visual desktop screenshot
test. No desktop renderer was changed. Apply the buffer in the project config
the desktop session actually loads; another checkout or a copied provider config
does not inherit this PR's setting automatically.

The upstream message has separate `content`, `reasoning_content` and, for tool
steps, `tool_calls` fields. `publicCompletion` copies these separately;
`streamCompletion` emits them as separate delta fields. Neither concatenates
reasoning or a stored checkpoint with the answer. The earlier private
"Project summary" session likewise contains four automatic compaction records
before a clean summary, with no checkpoint headings in assistant text.

## Validation and remaining boundary

- Before the fix, the new initial-compaction detection regression fails.
- Configuration regressions require the explicit proportional buffer, unchanged
  advertised context/output limits, automatic compaction and retained history.
- The buffer regression fails against the previous configuration. With both
  corrections, all 152 tests in 18 files, typecheck and diff check pass.
- Tests cover initial and legacy/update requests with no remembered route,
  unchanged internal instructions and checkpoint responses, ordinary repository
  summaries over JSON and SSE, separate reasoning, and latest-request selection.
  Existing tool-cycle, routing and budget tests remain in place.
- Live patched API with no remembered route preserves the full 2,723-character
  initial compaction instruction, tool calls/results and reasoning; OpenCode
  completes manual compaction via Beam (727-character checkpoint).
- The fresh seven-file repository summary no longer triggers the reproduced
  checkpoint loop. Legitimate long-session compaction records can still be displayed by
  OpenCode; globally hiding those is separate from this experience correction.

References: [OpenCode compaction](https://opencode.ai/docs/compaction),
[session API](https://opencode.ai/docs/api), and
[CLI settings](https://opencode.ai/docs/cli/config). The documented CLI settings
do not provide a dedicated checkpoint-visibility switch.
