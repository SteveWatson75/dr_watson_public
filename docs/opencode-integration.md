# OpenCode integration verification — 2026-10-15

Tested the source merged in PR #25 (`90678c2`) with OpenCode v2.0.30, Node.js v24.10.0 and Ollama v0.18.2 on Apple M1 / 16 GB RAM. Tests ran in `/tmp/dr-watson-opencode-integration` with a separate Dr Watson budget ledger; repository files and the normal budget database were not used as coding fixtures.

## Passed: OpenCode → Dr Watson → OpenRouter free

Used the v2 provider format now documented in README, selecting `dr-watson/dr-watson-auto`. Dr Watson used the explicit `openrouter/free` override with the existing $15/$20 caps. Only synthetic prompts and temporary fixtures were sent. OpenCode provider policies allowed only Dr Watson; a minimal primary test agent denied shell execution and allowed fixture reads and the single fixture write.

- `GET /v1/models` returned `dr-watson-auto`.
- `opencode run --standalone --agent integration --format json -m dr-watson/dr-watson-auto ...` returned the requested `WATSON_CONNECTION_OK` marker.
- OpenCode executed its `read` tool on `probe.txt` and returned `WATSON_INTEGRATION_7429`, which was not included in the request prompt.
- OpenCode executed its `write` tool to create `add.mjs` and returned `CREATED`. Independent Node assertions checked `add(2, 3) === 5`, `add(-4, 4) === 0`, and `add(0, 7) === 7`.
- Server logs identified `openrouter:openrouter/free`. The isolated ledger recorded 11 completed requests, 9,989 input tokens, 1,537 output tokens and $0 estimated spend at the final check. An additional zero-cost reservation remained for an interrupted request. No paid-model route was used.

The initial write attempt was denied by the temporary agent's permission rules; allowing the fixture filename in both relative and absolute forms permitted the repeat test. Dr Watson forwarded the permission-error tool result correctly.

## Not passed: installed local Qwen route

The installed model was `qwen3.5:latest`; the default `llama3.2:3b` fallback was not installed. With `LLM_PROVIDER=ollama`, `LLM_MODEL=qwen3.5:latest`, and both budget limits set to zero, OpenCode reached Dr Watson and the local model. Requests timed out at the existing 60-second provider timeout. Ollama also reported truncating the initial 5,329-token prompt to its default 4,096-token window. A smaller test agent did not produce a completed response within the timeout. Local inference therefore needs separate tuning before this is a dependable local fallback.

This run did not verify automatic Haiku/Gemini/Sonnet selection against live paid services. Mocked coverage for routing, caps and Haiku protection remains the existing test suite. The temporary API and Ollama processes were shut down after testing; no global OpenCode configuration was changed.
