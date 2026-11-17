# Dr Watson

Dr Watson is a local TypeScript assistant and model-routing API. It brings project
context, conversation memory and provider fallback into one entry point, with a
monthly budget cap for paid API usage.

Use the CLI for project-aware conversations, or the local API as a backend for
OpenCode. Routing uses deterministic task rules and a reviewed model catalogue,
not another model deciding which model to call.

## How it fits together

- **Entry points:** `src/index.ts` runs the CLI; `src/serve.ts` starts the loopback API.
- **Local API:** `src/local-api.ts` owns the HTTP boundary; `src/local-api/` separates
  protocol validation/SSE, message preparation and session-aware completion routing.
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

For contributors and coding agents: [AGENTS.md](AGENTS.md).
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

Keys stay in ignored local `.env`. Do not commit them or enable paid usage without
owner authorization. Built-in agents cannot execute work; OpenCode owns its tool
permissions. See [security boundaries and approvals](SECURITY.md#local-operation-and-owner-authorization).

### Configuration authority

| File | Purpose and consumers |
| --- | --- |
| [`config/models.json`](config/models.json) | Runtime approved identities, tier order, provider defaults/endpoints, local fallback and cash pricing; validated by `src/providers/model-catalogue.ts` for routing and budget |
| [`config/evaluation-candidates.json`](config/evaluation-candidates.json) | Runtime privacy restrictions/expiry and evaluation eligibility/allowance metadata; **not** a second approved-route catalogue |
| [`.env.example`](.env.example) → local `.env` | Supported environment settings; loaded by `src/config.ts` and entry-point consumers, never committed with credentials |
| [`opencode.json`](opencode.json) | Active OpenCode project provider, virtual model, compaction and maintenance-agent settings; not Dr Watson's upstream route configuration |
| [`.github/workflows/`](.github/workflows/) and [starter action](.github/actions/start-dr-watson/action.yml) | Active automation, prompts, owner gates and token permissions; reviewer generates its own isolated config |
| [`config/legacy-models.json`](config/legacy-models.json) | Frozen, independent regression fixture; tests only, never production configuration |

Owner-specific `.env`, `memory/CEO_CONTEXT.md`, `workspace/` project context and
`data/` databases remain local. There is no repository `.opencode/` or `PROJECT.md`;
selected projects can supply `workspace/<project>/PROJECT.md`, `decisions.md` and
`tasks.md` to the CLI. Dated investigations, evaluations and raw results in `docs/`
are evidence, not instructions to select today's routes.

## Routing and commands

Automatic selection uses simple local task rules:

| Tier | Work |
| --- | --- |
| `cheap` (default) | Routine questions, summaries, classification, issue drafting, small edits, simple tests |
| `standard` | Implementation, multi-file changes, repo analysis, debugging, long coding tasks |
| `hard` | Architecture, difficult debugging, code/PR review |

Use `/tier cheap`, `/tier standard`, `/tier hard`, or `/tier auto` to control the tier for subsequent prompts. On provider failure, automatic routing tries the remaining Go models in the selected tier, then other configured providers, and finally Ollama. Missing keys are skipped. Errors unrelated to provider availability stop the run. Code-review requests route to `hard` automatically.

Exact model identities and fallback order live only in `config/models.json`.
Routes change through evaluated, owner-reviewed edits, never discovery or ranking.
See [Round 2 selection evidence and limitations](docs/model-evaluations-round2-results.md)
and [privacy requirements](SECURITY.md#local-operation-and-owner-authorization).
`npm run evaluate-models -- --list --tier cheap` lists evaluation candidates offline;
evaluation eligibility is not routing approval.

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

`npm run check-models`
- fetches the OpenCode Go model catalogue,
- compares it to the previous snapshot in `data/catalogue.db`,
- reports added, removed, and changed models,
- flags newly discovered models that aren't in the approved catalogue as candidates for review.

Successful checks append snapshots to `model_catalogue_snapshots`. Existing
databases may retain the legacy `model_catalogue` table and its rows; discovery
no longer creates or maintains that derived per-model table.

Discovery is observational: it writes snapshots but never changes routing.
To approve a model, evaluate cost, context, tool support and privacy first; then
request owner review of its identity, route and pricing in `config/models.json`.
Run the [development checks](AGENTS.md#development) before proposing that edit.

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

The catalogue fails closed on malformed or unapproved configuration. Manual models
outside it require explicit provider selection and local input/output pricing
overrides when unlisted; unknown pricing blocks the route. Known privacy restrictions
still apply. Long-context and scheduled cash-pricing rules are also in the catalogue.

## Budget

Limits and environment defaults are in [.env.example](.env.example); approval and
cash-versus-subscription rules are in [SECURITY.md](SECURITY.md#local-operation-and-owner-authorization).
Setting cash limits to zero does **not** force local execution; use `LLM_PROVIDER=ollama`.

`/stats` shows month-to-date estimated USD spend, remaining budget and tokens/spend
by provider/model. `data/budget.db` groups costs by UTC calendar month. A blocked
reservation tries the remaining configured routes; if no route works, the app stops
with local setup guidance. Preserve the ledger across restarts.

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

Cash estimates assume no cache discounts. Review catalogue rates when providers change
prices: [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing),
[Gemini](https://ai.google.dev/gemini-api/docs/pricing). Anthropic uses its
Chat Completions compatibility API, not an OpenAI service. `/stats` records Go
tokens but does not estimate subscription allowance consumption; evaluation
allowance estimates are separate from the cash ledger.

Haiku requests estimate the assembled input, including instructions and tools, as serialized UTF-8 bytes divided by three (rounded up), plus 4,096 tokens of overhead. This cautious text/code heuristic is not an exact tokenizer or guaranteed upper bound. `LLM_HAIKU_INPUT_LIMIT` defaults to 80,000 estimated tokens and must stay below 100,000. Old chat history is removed first; the current request, project context, durable memory and required CEO pack are preserved. If those still exceed the threshold, a warning explains why Haiku was skipped and the next configured route is tried. Haiku effort stays at low or medium. Monthly budget enforcement, including its more conservative byte-based reservations, is unchanged.

## OpenCode local backend

Start from this directory with `npm run serve`. The API binds only to `127.0.0.1:8787` and exposes `GET /v1/models` and `POST /v1/chat/completions`. Keep `LLM_PROVIDER=auto` in `.env` for task routing; existing explicit provider/model overrides also apply. Provider keys stay in Dr Watson's `.env`.

This repository's active OpenCode V2 configuration is [`opencode.json`](opencode.json).
Leave the API terminal running, verify `curl http://127.0.0.1:8787/v1/models`,
then run `opencode` here and select `dr-watson/dr-watson-auto`.
For another project, merge the required settings from that file into its existing
configuration without overwriting owner settings; see OpenCode's
[configuration locations and precedence](https://opencode.ai/docs/config).

The main build agent goes through `dr-watson-auto`; the hidden `title` and `summary` agents can go directly to a cheap OpenCode Go model. V2 compaction still uses the session's selected model, but the project-level `agents.compaction.system` instruction asks for a concise checkpoint rather than transcript-style narration. The compaction model therefore continues through Dr Watson's router. This setup requires OpenCode Go to be connected in OpenCode (`/connect`) in addition to `OPENCODE_API_KEY` being present in Dr Watson's `.env` for Dr Watson's own Go routes.

The advertised context is a virtual-model budget, not a guarantee that every
fallback supports that window; local models may have much smaller context limits.

Keep the explicit compaction buffer in the project configuration used by the desktop app too. OpenCode's default buffer reserves at least 16k tokens; the explicit percentage keeps the reserved budget tied to the advertised output budget instead, and scales with other selected models. `"3.125%"` reserves 8,192 tokens (the advertised output budget), so compaction starts at 253,952 tokens. Automatic and manual compaction remain enabled; genuinely long histories can still produce checkpoints.

The [dated integration results](docs/opencode-integration.md) retain the historical
OpenRouter override test; it is not the automatic-routing setup recipe.
The implementation/owner-comment Actions still inject pinned V1 provider syntax;
do not copy those overrides into a V2 project configuration.

OpenCode owns files, terminal commands and tools. Dr Watson forwards supplied text messages, system/developer instructions, function definitions, tool calls and results through the existing router and budget ledger. It adds no chat history, CEO pack or persistent conversation memory. All supplied context is protected: oversized Haiku requests skip to the next route without dropping OpenCode's context. Both `max_tokens` and `max_completion_tokens` are accepted and capped at 2,048. Images/audio, Responses API and multiple completion choices are outside this first version.

### Bounded GitHub Actions mode

Interactive coding sessions rely on task anchoring: Dr Watson re-injects the original request so the agent does not restart reconnaissance after a compaction. That anchoring is wrong for the bounded, non-coding review and owner-comment jobs in GitHub Actions, where it can pull the agent back into an open-ended research loop.

Set the request header `x-dr-watson-mode: github-action` (or start the local API with `DR_WATSON_MODE=github-action`) to use the bounded path. In that mode Dr Watson still drops "continue"-style and duplicate user messages, but it never adds the `Task anchor` developer message or a synthetic user turn, so review and comment tasks stay focused on the supplied prompt and diff. Implementation jobs omit the mode and keep normal coding-session anchoring. This mode only changes message preparation; routing tiers, the budget ledger and the `developer` → `system` normalisation for OpenCode Go are unchanged.

OpenCode's [session runtime uses a streaming interface](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/llm/AGENTS.md). For `stream: true`, this API returns buffered SSE chunks, tool calls, an optional usage chunk and `[DONE]` after one non-streaming provider response is recorded. Text therefore appears after completion. Non-streaming clients receive a normal completion. SDK retries remain disabled. Browser-origin requests are rejected; this is a local CLI endpoint without public hosting or authentication services.

Startup and `GET /v1/models` make no inference calls. Automated HTTP tests mock
providers and cover routing, budget fallback, tool round trips and SSE; routine
validation needs no live model. For an owner-authorized **local-only inference**
probe, start Ollama and the API with explicit local overrides:

```sh
LLM_PROVIDER=ollama LLM_MODEL= LLM_BASE_URL= LLM_MONTHLY_SOFT_LIMIT_USD=0 LLM_MONTHLY_HARD_LIMIT_USD=0 npm run serve
# In another terminal (this POST invokes the local model):
curl -i http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"dr-watson-auto","messages":[{"role":"user","content":"Say hello briefly"}],"max_tokens":64}'
```

Expect `x-dr-watson-route: ollama:llama3.2:3b` on the curl response and the same
route in server logs. If Ollama is unavailable, expect a sanitized 502 with setup
commands. The small default local model is intended for this text test, not reliable
tool execution. An OpenCode session may still make direct Go maintenance calls;
the explicit Ollama override controls Dr Watson's routes, not OpenCode's own agents.

## Checks

See [development checks and PR requirements](AGENTS.md).
Run `npm run format` to format TypeScript source and tooling JSON with Prettier,
or `npm run format:check` to check without writing. These commands do not rewrite
model configuration, workflows, documentation or historical evaluation evidence.

## GitHub agent loop

The issue → implementation → PR → review → human QA loop is described in
[`docs/agents/github-agent-loop.md`](docs/agents/github-agent-loop.md).
The [bounded PR reviewer](docs/agents/github-review.md) uses trusted base-branch preparation,
OpenCode → a restricted Dr Watson API → deterministic Go routes, and a separate `GITHUB_TOKEN`
publication job. It does not use `OPENCODE_GH_TOKEN`, inspect raw evaluation JSON, or execute PR code.
See [security controls and limitations](SECURITY.md#github-pr-review-trust-boundaries).
Other agent workflows retain their existing starter action and PAT design.
