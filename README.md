# Dr Watson

Dr Watson is a local TypeScript assistant and model-routing API. It brings project
context, conversation memory and provider fallback into one entry point, with a
monthly budget cap for paid API usage.

Use the CLI for project-aware conversations, or the local API as a backend for
OpenCode. Routing uses deterministic task rules and a reviewed model catalogue,
not another model deciding which model to call.

## How it fits together

- **Entry points:** `src/index.ts` runs the CLI; `src/serve.ts` starts the loopback API.
- **Conversation:** `src/conversation/` assembles CLI context and stores messages,
  durable memories and usage statistics in SQLite.
- **Agents:** `src/agents/` defines the manager, coder, researcher and memory
  extractor. The manager delegates focused questions and owns the final answer.
- **Routing and providers:** `src/routing/` chooses the task tier;
  `src/providers/` applies the reviewed routes, privacy checks and fallback.
  `src/budget.ts` reserves and records estimated paid usage.
- **Evaluation and review:** `src/evaluation/` contains the bounded model-evaluation
  CLI; `src/github/` contains the bounded PR reviewer.

The built-in specialists provide advice and plans, not autonomous implementation.
They have no filesystem, shell or deployment tools. Proposed work must not be
reported as executed without tool evidence. When OpenCode uses the local API,
OpenCode owns its tools and permissions; Dr Watson routes its model requests.

Detailed documentation: [security and limitations](SECURITY.md),
[model evaluations](docs/model-evaluations.md),
[Round 2 evidence](docs/model-evaluations-round2-results.md),
[OpenCode integration results](docs/opencode-integration.md), and the
[GitHub agent loop](docs/agents/github-agent-loop.md).

## Local setup

Requires Node.js 22.13+ and Ollama for the local fallback.

1. Run `npm install`.
2. Copy `.env.example` to `.env` (or update an existing `.env`). Keep `LLM_PROVIDER=auto`
   for automatic routing, or use `LLM_PROVIDER=ollama` to stay local.
3. For hosted routes, add the keys you intend to use: `OPENCODE_API_KEY` for Go,
   `GEMINI_API_KEY` for Gemini, or `ANTHROPIC_API_KEY` for Anthropic. Missing keys
   are skipped; no hosted key is required for Ollama.
4. Run `ollama pull llama3.2:3b`, then `ollama serve` if it is not already running.
5. Run `npm run dev` for the CLI, or `npm run serve` for the local API.
   Use `/stats` or `npm run dev -- --stats` to inspect usage without an API request.

Keys stay in local `.env`, which is ignored by Git. Missing keys are reported at startup and skipped. No cloud, hosting, billing-console or deployment access is needed. When a task requires human action in such a service, the agent must stop and give exact steps for the user.

## Routing and commands

Automatic selection uses simple local task rules:

| Tier | OpenCode Go models (fallback order) | Work |
| --- | --- | --- |
| `cheap` (default) | `mimo-v2.6-flash` → `glm-5.3-flash` → `deepseek-v4.1-flash` → `beam-free` | Routine questions, summaries, classification, issue drafting, small edits, simple tests |
| `standard` | `mimo-v2.6-pro` → `deepseek-v4.1-flash` → `kimi-k2.7-code` → `beam-free` | Implementation, multi-file changes, repo analysis, debugging, long coding tasks |
| `hard` | `qwen4-max` → `kimi-k3.1-pro` → `mimo-v2.6-pro` → `deepseek-v4-pro` → `qwen3.8-max` → `kimi-k2.7-code` → `beam-free` | Architecture, difficult debugging, code/PR review |

Use `/tier cheap`, `/tier standard`, `/tier hard`, or `/tier auto` to control the tier for subsequent prompts. On provider failure, automatic routing tries the remaining Go models in the selected tier, then other configured providers, and finally Ollama. Missing keys are skipped. Errors unrelated to provider availability stop the run. Code-review requests route to `hard` automatically.

`beam-free` is tried before external providers, but its temporary free offer and regional restrictions mean availability is not guaranteed. Crouton was removed because it is absent from current discovery; Iceman Contributor was removed because its terms require using request data to improve the model. The owner confirmed Go Global-region settings are enabled (2026-11-16), satisfying DeepSeek's regional prerequisite; its current ZDR agreement runs through 2026-11-30 and requires renewal. Production skips expired dated privacy approvals on each request, including explicit overrides, then follows the remaining configured fallback order. This project never changes privacy settings automatically.

### Round 2 route selection

The order above applies the reviewed [Round 2 results](docs/model-evaluations-round2-results.md) (executed 2026-11-16; 137 requests, $0.153 estimated Go allowance): `standard` promotes `mimo-v2.6-pro` (8/8 exact answers, 2/2 tool calls, $0.001282 allowance, zero retention) and keeps `deepseek-v4.1-flash` as its fallback; `hard` leads with `qwen4-max`, `kimi-k3.1-pro` and `mimo-v2.6-pro` (8/8 usable and 2/2 tool calls each; `qwen4-max` consumed about one third of `kimi-k3.1-pro`'s allowance, and `mimo-v2.6-pro` is the economical alternate at $0.001409), while `deepseek-v4-pro`, `qwen3.8-max` and `kimi-k2.7-code` are retained as recovery paths. `cheap` is unchanged because all five screened candidates tied on correctness. This was a screening sample of two repetitions over three or four fixtures per tier: it shows the candidates handled the synthetic tasks reliably, not that any model is statistically superior.

Routing stays deterministic on purpose: fixed local task rules and the reviewed catalogue in `config/models.json`, with no LLM-based model selector. Evaluation reports and model discovery never change a route automatically; routes change only through a reviewed edit to `config/models.json`. The free models (`beam-free`, `hy4-flash-free` and `longcat-2.5-free`) all screened successfully in Round 2 and led the cost-aware ranking, but they are temporary offers with retention or regional terms, so being evaluated is not the same as being promoted: they are not made privacy defaults. `beam-free` stays the zero-cost emergency fallback before external providers.

See [model evaluations](docs/model-evaluations.md) for the dated privacy review, 16 synthetic fixtures, bounded CLI runner, raw comparisons and limitations. `npm run evaluate-models -- --list --tier cheap` makes no API calls.

Use `/provider ollama` to stay local, `/provider anthropic` or `/provider gemini` for an explicit provider, and `/provider auto` to restore task routing. Provider overrides fall back only to Ollama. Existing `openai`, `openrouter` and `groq` providers remain manual choices. Set `LLM_PROVIDER`, `LLM_MODEL` and `LLM_BASE_URL` locally for persistent overrides; `LLM_MODEL` requires an explicit provider. Ollama defaults to `llama3.2:3b` at `http://127.0.0.1:11434/v1`; only loopback URLs are allowed.

Other commands: `/projects`, `/use <project>`, `/side [question]`, `/back`, `/remember <fact>`, `/stats`, `exit`. Optional `AUTO_MEMORY=true` uses the same guarded model path for memory extraction.

Use `/ceo` to enable strategy mode for the next prompt (repeat it to cancel).
It recommends a business/product next action and challenges low-value scope.
CEO prompts default to `hard`; an explicit `/tier` or `/provider` choice still
applies, as do all budget safeguards. Other commands do not consume the mode.
Edit `memory/CEO_CONTEXT.md` by hand to maintain durable business context; keep
it concise (under roughly 1,500–2,500 words) and free of secrets or chat history.
The pack is loaded afresh for CEO prompts and hard-tier calls, including automatic
business/product strategy routing. Ordinary cheap/standard calls do not load it,
even if provider failover later uses a hard model. `/use <project>` context is
included alongside the pack; current project files remain canonical.

## Dynamic OpenCode Go model discovery

OpenCode's Go catalogue can change as OpenCode tests and adds models, so Dr Watson
can discover the full catalogue instead of hard-coding it. The discovery is
read-only: finding a new model never changes the approved catalogue or what gets
routed.

`npm run check-models`
- fetches the OpenCode Go model catalogue,
- compares it to the previous snapshot in `data/catalogue.db`,
- reports added, removed, and changed models,
- flags newly discovered models that aren't in the approved catalogue as candidates for review.

Run it weekly (e.g. `cron` or `launchd` on your Mac). If OpenCode adds a model you
want Dr Watson to use, add it to the approved catalogue in `config/models.json`
and, if it carries a non-zero price, its pricing entry there too. The router,
budget ledger, Go-specific 429 cooldowns, and failover behaviour all stay
unchanged until you make that manual edit.

Pass `--json` for machine-readable added/removed/changed/candidate lists.
Example output (historical snapshot):

```text
OpenCode Go models — last checked 2026-10-18 ...
Total Go models: 37

NEW
  kimi-k3    (not routed — candidate for review)

2 new model(s) not currently routed.
Review them before adding to the approved catalogue in config/models.json.
```

### Model configuration

The approved catalogue lives in `config/models.json` (versioned and validated by
the Zod schema in `src/providers/model-catalogue.ts`). It is the single source of truth for
provider identifiers and defaults, provider endpoints, the cheap/standard/hard
route order, the Ollama local fallback, model pricing, and the long-context and
scheduled pricing rules. OpenCode Go's free models (ids ending in `-free`) are
kept ahead of external routes so a capped subscription keeps working. It is
loaded and validated at startup and fails closed
on a malformed or unapproved configuration, so a routed model must have an
approved identity and pricing policy. Manual `LLM_PROVIDER`/`LLM_MODEL` overrides
are outside this catalogue and are priced via `LLM_INPUT_USD_PER_MILLION` /
`LLM_OUTPUT_USD_PER_MILLION` when they are not listed.

`config/legacy-models.json` is a frozen historical test fixture representing the
configuration before it was externalized. It is never loaded by production code
and never derived from `config/models.json`; it exists only to give tests an
independent baseline for route order, provider defaults and pricing, on top of
which the tests assert the documented Round 2 route changes.

Model discovery (`npm run check-models`) is read-only. Approving a new model is a
manual, reviewed edit: add it to `config/models.json`, keep its identity and
pricing consistent, and run `npm run typecheck` and `npm test`. New models must be
evaluated (cost, context, tool support) before they are approved.

## Budget

Default monthly limits are a **$15 soft warning** and a **$20 hard cap**, leaving headroom below the 250 SEK ceiling. Change only local `LLM_MONTHLY_SOFT_LIMIT_USD` / `LLM_MONTHLY_HARD_LIMIT_USD` values; limits never increase automatically. Set both to `0` to block every paid-provider request.

`/stats` shows month-to-date estimated USD spend, remaining budget, and tokens/spend by provider and model. The SQLite ledger is `data/budget.db`, grouped by UTC calendar month; keep it across restarts. All non-Ollama providers are blocked at the cap, including manual overrides. If the remaining budget cannot cover a request reservation, it also falls back to Ollama. If local is unavailable, the app stops with the exact Ollama setup commands.

## Model-usage observability

Flow: user request → deterministic task tier → approved model routes → provider
attempts/fallback → model usage records → final response. Planned routing and
actual model usage are recorded separately.

`/stats` attributes requests, tokens and latency to the provider and model that actually served each call, because fallback means the planned route is not always the one that answers. One agent run can use several models, so every invocation attempt is recorded separately in `data/dr-watson.db`: `routing_decisions` records the planned route before the run (`route = planned`; older rows say `active`, which meant planned at the time), `agent_runs` records the run outcome with `model` listing the models that actually served it in first-use order (`+`-separated, or `none` when no route produced a response), and `model_usage` records each invocation attempt as `used` or `failed` with its own token counts and latency.

Terminology in `/stats`: `Provider/model performance` counts model invocation **attempts** — one `model_usage` row per attempt, `used` when the model answered and `failed` when the provider rejected the call. These are not agent **runs**: `Agent usage` counts agent runs, and one run normally makes several attempts. A request is counted only once the model invocation begins. Routes skipped before any provider call — privacy expiry, missing API keys, budget limits or Go cooldowns — and routes that fail during local provider initialization are never attempts or requests; they keep only their safe warning. Observability rows never contain prompts, responses, credentials, request bodies or provider error text. Databases created before `model_usage` existed stay readable: runs without invocation rows keep their original attribution.

New conversations write only planned routing decisions. Historical shadow
classifications remain in existing databases and `/stats` distributions; no
shadow classifier runs and no historical rows or schema are removed.

Scope: these tables cover Dr Watson's CLI conversations. The OpenCode local API and the GitHub review workflows do not write them — they keep their own bounded, attempt-level diagnostics — so their calls do not appear in `/stats`.

Each model request, including specialist and memory calls, reserves a conservative estimate before sending: serialized input bytes plus overhead, and at most 2,048 output tokens. SQLite transactions share reservations between local processes. Successful usage replaces the reservation with estimated token cost. Failed calls, missing usage and interrupted processes keep their reservation because they may have been billed. SDK retries and streaming are disabled. Reservations count in displayed spend and can cause an earlier cutoff. This is a local estimate, not the provider invoice or a limit on usage made outside Dr Watson.

Prices live in the versioned approved catalogue's pricing table in `config/models.json`: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing). Haiku's long-context rate and Gemini's January 2027 rate change are included. Anthropic uses its [Chat Completions compatibility API](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk); no OpenAI API call is made by the automatic route. No cache discounts are assumed. Review this table if providers change prices. For a manual model missing from the table, set local `LLM_INPUT_USD_PER_MILLION` and `LLM_OUTPUT_USD_PER_MILLION`; unknown pricing blocks that route.

All OpenCode Go routes are priced at $0 in this table and in the ledger: they consume the Go subscription allowance, not cash. Extra Usage is disabled in the owner's account configuration — an external account setting this code cannot enforce — so Go usage cannot add cash spend. The per-model allowance rates quoted in the evaluation reports come from the reviewed candidate metadata (`config/evaluation-candidates.json`) and estimate Go subscription consumption; they are not additional cash API spending. The monthly soft/hard limits govern only actual cash spend on external providers. The budget ledger and `/stats` therefore do not measure Go allowance consumption: the recorded token counts show how much each model processed, and no allowance estimator is included because Go allowance accounting is not reliably visible to external clients.

Haiku requests estimate the assembled input, including instructions and tools, as serialized UTF-8 bytes divided by three (rounded up), plus 4,096 tokens of overhead. This cautious text/code heuristic is not an exact tokenizer or guaranteed upper bound. `LLM_HAIKU_INPUT_LIMIT` defaults to 80,000 estimated tokens and must stay below 100,000. Old chat history is removed first; the current request, project context, durable memory and required CEO pack are preserved. If those still exceed the threshold, a warning explains why Haiku was skipped and the next configured route is tried. Haiku effort stays at low or medium. Monthly budget enforcement, including its more conservative byte-based reservations, is unchanged.

## OpenCode local backend

Start from this directory with `npm run serve`. The API binds only to `127.0.0.1:8787` and exposes `GET /v1/models` and `POST /v1/chat/completions`. Keep `LLM_PROVIDER=auto` in `.env` for task routing; existing explicit provider/model overrides also apply. Provider keys stay in Dr Watson's `.env`.

This repository includes an OpenCode V2 `opencode.json`. For another repository, add the same configuration there, following OpenCode's [custom provider configuration](https://opencode.ai/v2/docs/providers#custom):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "dr-watson": {
      "package": "@opencode/ai/providers/openai-compatible",
      "name": "Dr Watson (local)",
      "settings": { "baseURL": "http://127.0.0.1:8787/v1" },
      "models": {
        "dr-watson-auto": {
          "name": "Dr Watson Auto",
          "reasoning": true,
          "interleaved": "reasoning_content",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 262144, "output": 8192 }
        }
      }
    }
  },
  "model": "dr-watson/dr-watson-auto",
  "compaction": { "buffer": "3.125%" },
  "agents": {
    "compaction": {
      "hidden": true,
      "system": "Write only a compact checkpoint of at most 220 words. Use short bullets under these headings when relevant: Objective, Requirements, Decisions, Completed, Active, Blockers, Next move, Relevant files. Preserve user constraints, exact paths and identifiers, unresolved failures, and pending commands. Include only information needed to resume the task. Do not retell the conversation, repeat tool output, narrate reasoning, list routine inspection steps, or duplicate completed work. Omit empty headings and give one concrete next action."
    },
    "title": { "model": "opencode-go/mimo-v2.6-flash" },
    "summary": { "model": "opencode-go/mimo-v2.6-flash" }
  }
}
```

The main build agent goes through `dr-watson-auto`; the hidden `title` and `summary` agents can go directly to a cheap OpenCode Go model. V2 compaction still uses the session's selected model, but the project-level `agents.compaction.system` instruction asks for a concise checkpoint rather than transcript-style narration. The compaction model therefore continues through Dr Watson's router. This setup requires OpenCode Go to be connected in OpenCode (`/connect`) in addition to `OPENCODE_API_KEY` being present in Dr Watson's `.env` for Dr Watson's own Go routes.

Then run `opencode` in that repository. The advertised context limit matches the smallest OpenCode Go free route (262,144 tokens); a local fallback model may have a smaller configured context window, so requests can still compact earlier when such a route is selected.

Keep the explicit compaction buffer in the project configuration used by the desktop app too. OpenCode's default buffer reserves at least 16k tokens; the explicit percentage keeps the reserved budget tied to the advertised output budget instead, and scales with other selected models. `"3.125%"` reserves 8,192 tokens (the advertised output budget), so compaction starts at 253,952 tokens. Automatic and manual compaction remain enabled; genuinely long histories can still produce checkpoints.

For the route verified with OpenCode v2.0.30, keep `OPENROUTER_API_KEY` in Dr Watson's `.env` and start the API with:

```sh
cd <cloned-repo-directory>
LLM_PROVIDER=openrouter LLM_MODEL=openrouter/free LLM_BASE_URL=https://openrouter.ai/api/v1 npm run serve
```

Leave that terminal running. In another terminal, run `curl http://127.0.0.1:8787/v1/models`, then start `opencode` from the project containing `opencode.json`. Select `dr-watson/dr-watson-auto`; server logs should show `Local API route: openrouter:openrouter/free`. The existing monthly budget caps still apply, including blocking free-provider routes at the hard cap. The [integration results](docs/opencode-integration.md) cover text responses, reading a fixture and creating JavaScript verified with independent assertions.

To enable automatic task routing instead, keep the appropriate provider keys in Dr Watson's `.env`, then restart the API with `LLM_PROVIDER=auto LLM_MODEL= LLM_BASE_URL= npm run serve`. Missing keys are skipped. OpenCode's main provider configuration stays the same. For the default zero-cost fallback, run `ollama pull llama3.2:3b` and start `ollama serve`.

OpenCode v1 uses `provider`, `npm: "@ai-sdk/openai-compatible"`, and `options` instead of the v2 `providers`, `package`, and `settings` fields; it uses `small_model` for maintenance calls. Do not mix the two configuration formats. If `opencode` is not on your shell's PATH after installation, the installer may have placed it at `~/.opencode/bin/opencode`. Dr Watson requires Node.js 22.13+ in the shell that starts it.

OpenCode owns files, terminal commands and tools. Dr Watson forwards supplied text messages, system/developer instructions, function definitions, tool calls and results through the existing router and budget ledger. It adds no chat history, CEO pack or persistent conversation memory. All supplied context is protected: oversized Haiku requests skip to the next route without dropping OpenCode's context. Both `max_tokens` and `max_completion_tokens` are accepted and capped at 2,048. Images/audio, Responses API and multiple completion choices are outside this first version.

### Bounded GitHub Actions mode

Interactive coding sessions rely on task anchoring: Dr Watson re-injects the original request so the agent does not restart reconnaissance after a compaction. That anchoring is wrong for the bounded, non-coding review and owner-comment jobs in GitHub Actions, where it can pull the agent back into an open-ended research loop.

Set the request header `x-dr-watson-mode: github-action` (or start the local API with `DR_WATSON_MODE=github-action`) to use the bounded path. In that mode Dr Watson still drops "continue"-style and duplicate user messages, but it never adds the `Task anchor` developer message or a synthetic user turn, so review and comment tasks stay focused on the supplied prompt and diff. Implementation jobs omit the mode and keep normal coding-session anchoring. This mode only changes message preparation; routing tiers, the budget ledger and the `developer` → `system` normalisation for OpenCode Go are unchanged.

OpenCode's [session runtime uses a streaming interface](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/llm/AGENTS.md). For `stream: true`, this API returns buffered SSE chunks, tool calls, an optional usage chunk and `[DONE]` after one non-streaming provider response is recorded. Text therefore appears after completion. Non-streaming clients receive a normal completion. SDK retries remain disabled. Browser-origin requests are rejected; this is a local CLI endpoint without public hosting or authentication services.

For a zero-paid-cost manual smoke test, start Ollama, then run:

```sh
LLM_PROVIDER=auto LLM_MONTHLY_SOFT_LIMIT_USD=0 LLM_MONTHLY_HARD_LIMIT_USD=0 npm run serve
# In another terminal:
curl http://127.0.0.1:8787/v1/models
curl -i http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"dr-watson-auto","messages":[{"role":"user","content":"Say hello briefly"}],"max_tokens":64}'
opencode run -m dr-watson/dr-watson-auto "Say hello briefly; do not use tools"
```

Expect `x-dr-watson-route: ollama:llama3.2:3b` on the curl response and `Local API route: ollama:llama3.2:3b` in server logs. Paid routes must be blocked. If Ollama is unavailable, the endpoint returns a sanitized 502 with setup commands. Tool execution depends on the selected model's capabilities; the small default local fallback is intended for this text smoke test. Automated HTTP tests mock providers and exercise routing, budget fallback, tool round trips and SSE without paid calls.

## Checks

Run `npm run typecheck` and `npm test`. Tests use mocked providers and temporary ledgers; they make no paid calls.

## GitHub agent loop

The issue → implementation → PR → review → human QA loop is described in
[`docs/agents/github-agent-loop.md`](docs/agents/github-agent-loop.md).
The [bounded PR reviewer](docs/agents/github-review.md) uses trusted base-branch preparation,
OpenCode → a restricted Dr Watson API → deterministic Go routes, and a separate `GITHUB_TOKEN`
publication job. It does not use `OPENCODE_GH_TOKEN`, inspect raw evaluation JSON, or execute PR code.
See [security controls and limitations](SECURITY.md#github-pr-review-trust-boundaries).
Other agent workflows retain their existing starter action and PAT design.
All use standard Ubuntu runners and no automatic merge. Keep Go balance fallback disabled
and GitHub Actions overage hard-stopped.
