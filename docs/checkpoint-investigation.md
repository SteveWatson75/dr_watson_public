# Repository-summary checkpoints (2026-11-08)

## Finding and scope

The reproduced checkpoint is **OpenCode compaction output**, not text prepended
by Dr Watson's response serializer or by the model's ordinary repository answer.
OpenCode stores it as `type: "compaction"`, separately from `type: "assistant"`.
Displaying those records in a transcript is an OpenCode client concern. This
patch does **not** claim to hide them or fix the client's presentation.

An independently verified compatibility defect is corrected: OpenCode 2.2.6's
**initial** compaction instruction was not recognised. Without a remembered
route, message preparation mistakes its template headings for an old checkpoint,
removes the instruction, and injects a normal task anchor instead. Recognising
the exact initial instruction preserves it, just like subsequent checkpoint
updates. No output filtering, routing-table changes, or compaction disabling is
appropriate based on the evidence.

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
can trigger compaction; changing the advertised limits or budget was not needed
to establish the origin and was not attempted.

The upstream message has separate `content`, `reasoning_content` and, for tool
steps, `tool_calls` fields. `publicCompletion` copies these separately;
`streamCompletion` emits them as separate delta fields. Neither concatenates
reasoning or a stored checkpoint with the answer. The earlier private
"Project summary" session likewise contains four automatic compaction records
before a clean summary, with no checkpoint headings in assistant text.

## Validation and remaining boundary

- Before the fix, the new initial-compaction detection regression fails.
- After the fix, all 150 tests in 17 files, `npm run typecheck`, and
  `git diff --check` pass.
- Tests cover initial and legacy/update requests with no remembered route,
  unchanged internal instructions and checkpoint responses, ordinary repository
  summaries over JSON and SSE, separate reasoning, and latest-request selection.
  Existing tool-cycle, routing and budget tests remain in place.
- Live patched API with no remembered route preserves the full 2,723-character
  initial compaction instruction, tool calls/results and reasoning; OpenCode
  completes manual compaction via Beam (727-character checkpoint).
- Checkpoint visibility in OpenCode remains reproducible/expected after this
  compatibility fix. Suppressing it requires a client-side presentation change,
  not deletion of legitimate provider content in these repositories.

References: [OpenCode compaction](https://opencode.ai/docs/compaction),
[session API](https://opencode.ai/docs/api), and
[CLI settings](https://opencode.ai/docs/cli/config). The documented CLI settings
do not provide a dedicated checkpoint-visibility switch.
