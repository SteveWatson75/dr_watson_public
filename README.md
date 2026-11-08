# Dr Watson

A local AI entry point with task routing, project context, memory and a capped monthly API budget. Requires Node.js 22.13+ and local Ollama for the zero-cost fallback. Specialists currently provide advice and plans; they have no filesystem, shell or deployment tools.

## Local setup

1. Copy `.env.example` to `.env` (or update an existing `.env` and set `LLM_PROVIDER=auto`).
2. Create/fund a Gemini API account and copy its key into `GEMINI_API_KEY`.
3. Create/fund an Anthropic API account and copy its key into `ANTHROPIC_API_KEY`.
4. Install Ollama, run `ollama pull llama3.2:3b`, and start `ollama serve` if it is not already running.
5. Run `npm install`, then `npm run dev`. Check `/stats`, or run `npm run dev -- --stats` for status without making any API requests.

Keys stay in local `.env`, which is ignored by Git. Missing keys are reported at startup and skipped. No cloud, hosting, billing-console or deployment access is needed. When a task requires human action in such a service, the agent must stop and give exact steps for the user.

## Routing and commands

Automatic selection uses simple local task rules:

| Tier | OpenCode Go models (fallback order) | Work |
| --- | --- | --- |
| `cheap` (default) | `mimo-v2.6-flash` → `glm-5.3-flash` → `deepseek-v4.1-flash` → `crouton-alpha-free` → `beam-free` → `iceman-contributor-free` | Routine questions, summaries, classification, issue drafting, small edits, simple tests |
| `standard` | `deepseek-v4.1-flash` → `mimo-v2.6-pro` → `kimi-k2.7-code` → `beam-free` → `crouton-alpha-free` → `iceman-contributor-free` | Implementation, multi-file changes, repo analysis, debugging, long coding tasks |
| `hard` | `deepseek-v4-pro` → `qwen3.8-max` → `kimi-k2.7-code` → `beam-free` → `crouton-alpha-free` → `iceman-contributor-free` | Architecture, difficult debugging, code/PR review |

Use `/tier cheap`, `/tier standard`, `/tier hard`, or `/tier auto` to control the tier for subsequent prompts. On provider failure, automatic routing tries the remaining Go models in the selected tier, then other configured providers, and finally Ollama. Missing keys are skipped. Errors unrelated to provider availability stop the run. Code-review requests route to `hard` automatically.

OpenCode Go's free models (`beam-free`, `crouton-alpha-free`, `iceman-contributor-free`) have no monthly limit and remain available after the paid Go models exhaust their rolling 5-hour and weekly allowances, so they are tried before leaving Go for any external provider. That keeps a run working at $0 while the subscription allowance recovers. Free models are not the full-quality default and some are limited-time; the paid Go tier is still preferred while it is available.

Use `/provider ollama` to stay local, `/provider anthropic` or `/provider gemini` for an explicit provider, and `/provider auto` to restore task routing. Provider overrides fall back only to Ollama. Existing `openai`, `openrouter` and `groq` providers remain manual choices. Set `LLM_PROVIDER`, `LLM_MODEL` and `LLM_BASE_URL` locally for persistent overrides; `LLM_MODEL` requires an explicit provider. Ollama defaults to `llama3.2:3b` at `http://127.0.0.1:11434/v1`; only loopback URLs are allowed.

Other commands: `/projects`, `/use <project>`, `/side [question]`, `/back`, `/remember <fact>`, `/stats`, `exit`. Optional `AUTO_MEMORY=true` uses the same guarded model path for memory extraction. Remote Jev shadow requests are disabled in the app.

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
read-only: finding a new model never changes `TIER_ROUTES` or what gets routed.

`npm run check-models`
- fetches the OpenCode Go model catalogue,
- compares it to the previous snapshot in `data/catalogue.db`,
- reports added, removed, and changed models,
- flags newly discovered models that aren't in `TIER_ROUTES` as candidates for review.

Run it weekly (e.g. `cron` or `launchd` on your Mac). If OpenCode adds a model you
want Dr Watson to use, add it to `TIER_ROUTES` in `src/provider-chain.ts` and,
if it carries a non-zero price, to `MODEL_PRICING` in `src/budget.ts`. The router,
budget ledger, Go-specific 429 cooldowns, and failover behaviour all stay
unchanged until you make that manual edit.

## Budget

Default monthly limits are a **$15 soft warning** and a **$20 hard cap**, leaving headroom below the 250 SEK ceiling. Change only local `LLM_MONTHLY_SOFT_LIMIT_USD` / `LLM_MONTHLY_HARD_LIMIT_USD` values; limits never increase automatically. Set both to `0` to block every paid-provider request.

`/stats` shows month-to-date estimated USD spend, remaining budget, and tokens/spend by provider and model. The SQLite ledger is `data/budget.db`, grouped by UTC calendar month; keep it across restarts. All non-Ollama providers are blocked at the cap, including manual overrides. If the remaining budget cannot cover a request reservation, it also falls back to Ollama. If local is unavailable, the app stops with the exact Ollama setup commands.

Each model request, including specialist and memory calls, reserves a conservative estimate before sending: serialized input bytes plus overhead, and at most 2,048 output tokens. SQLite transactions share reservations between local processes. Successful usage replaces the reservation with estimated token cost. Failed calls, missing usage and interrupted processes keep their reservation because they may have been billed. SDK retries and streaming are disabled. Reservations count in displayed spend and can cause an earlier cutoff. This is a local estimate, not the provider invoice or a limit on usage made outside Dr Watson.

Prices live in the small `MODEL_PRICING` table in `src/budget.ts`: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing). Haiku's long-context rate and Gemini's January 2027 rate change are included. Anthropic uses its [Chat Completions compatibility API](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk); no OpenAI API call is made by the automatic route. No cache discounts are assumed. Review this table if providers change prices. For a manual model missing from the table, set local `LLM_INPUT_USD_PER_MILLION` and `LLM_OUTPUT_USD_PER_MILLION`; unknown pricing blocks that route.

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

### `npm run check-models`

Fetches the OpenCode Go model catalogue, compares it to the previous snapshot saved in `data/catalogue.db`, and reports any **added**, **removed**, or **changed** models. It also flags newly discovered models that aren't yet in `TIER_ROUTES` (`src/provider-chain.ts`) as candidates for review.

This is read-only: it never changes routing automatically. Use it weekly (e.g. via `cron` or `launchd` on your Mac) to stay aware of new OpenCode Go models, then decide whether to add one to `TIER_ROUTES` and `MODEL_PRICING` by hand.

```
OpenCode Go models — last checked 2026-10-18 ...
Total Go models: 37

NEW
  kimi-k3    (not routed — candidate for review)

2 new model(s) not currently routed.
Review them before adding to TIER_ROUTES in src/provider-chain.ts.
```

Pass `--json` for machine-readable output (added/removed/changed/candidates) if you later want to wire it into notifications.

## GitHub agent loop

The private-repository issue → implementation → PR → review → human QA loop is described in
[`docs/agents/github-agent-loop.md`](docs/agents/github-agent-loop.md). Each job starts the local
Dr Watson router (`start-dr-watson`) and runs OpenCode against `dr-watson/dr-watson-auto` on
`http://127.0.0.1:8787/v1`, using the existing OpenCode Go subscription (`OPENCODE_API_KEY` Actions
secret) and a repo-scoped GitHub token (`OPENCODE_GH_TOKEN` Actions secret). They use standard
Ubuntu runners, explicit owner-triggered labels/comments, per-job timeouts, a 10-minute review step
timeout, and no automatic merge. Disable Go balance fallback and keep GitHub Actions overage
hard-stopped before enabling it.
