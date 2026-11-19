# Gemini and Anthropic compatibility audit

Checked 2026-11-18 against official documentation and the installed OpenAI Agents
SDK 0.18.0 / OpenAI SDK 7.27.0. **No live provider inference was performed.**

## Confirmed findings

- Both providers document OpenAI Chat Completions support at the catalogue's
  existing endpoints, with bearer authentication. No native SDK is required.
- Anthropic accepts `response_format` only as `json_schema` with `strict: true`.
  Its schema subset rejects string length, numeric bounds and most array bounds.
  The SDK sends the memory extractor's `minLength` and `maxItems` unchanged.
  This is a documented HTTP 400 incompatibility, not established by live inference.
  The correction simplifies only the Anthropic wire schema; the original Zod
  schema still validates the result before memory/tool use. The existing schema
  instruction retains constraints as prompt guidance.
- Anthropic ignores function `strict`. Tool arguments therefore require local
  validation; the existing Agents SDK/Zod tool path already supplies it.
- Gemini requires thought signatures on current-turn function calls. The SDK
  preserves `extra_content.google.thought_signature` through its `providerData`
  conversion; the mocked tool round trip now checks that explicitly.
- Invalid Gemini keys can return HTTP 400 with "API key not valid" rather than
  401 (also reported in Google's developer forum; not live-reproduced here).
  That specific credential message now falls through like existing auth failures.
  Unsupported-parameter 400s remain terminal; SDK HTTP retries remain disabled.
- The SDK accepts empty `choices` as empty output. The default model factory now
  rejects empty Gemini/Anthropic output, retaining its budget reservation.
  Malformed JSON fails safely without speculative replay or releasing spend.
- Both compatibility APIs expose `prompt_tokens` and `completion_tokens`.
  Gemini reasoning tokens are included in completion usage, not added twice.
  Existing approved cash pricing and conservative reservation rules are unchanged.

## Coverage and limits

Mocked HTTP tests exercise the real client and Agents SDK: endpoint/auth, text,
tool-result round trips, signature preservation, invalid arguments, structured
JSON and original-schema validation, credential/request/transient errors, fallback,
usage reporting/settlement, missing usage and malformed/empty responses.
These are protocol regression tests, **not** evidence of live model availability,
account access, generation quality or provider billing accuracy.

The schema helper is not a general schema translator: recursive schemas, arbitrary
object keys and other provider-unsupported schema features can still fail.
Use Zod output/tool schemas for local validation; passing a raw JSON schema to the
SDK does not supply equivalent runtime semantic validation.

Anthropic documents additional restrictions: current models can reject custom
sampling values, Sonnet 5.5 rejects forced tool choice, and system/developer
messages are hoisted. Callers must use supported parameters; this change does not
silently discard explicit sampling/tool-choice requirements. Unscoped Anthropic
personal/service keys additionally need an `anthropic-workspace-id` header; this
repository currently supports workspace-scoped keys, not workspace selection.
The provider describes its compatibility API as primarily for testing/comparison;
Gemini describes OpenAI compatibility as beta. These remain operational limitations,
not justification for changing the repository's approved architecture.

## Optional owner-authorized live smoke

Only after explicit authorization, with the intended key configured locally:

```sh
npx tsx src/commands/provider-smoke.ts --run anthropic
npx tsx src/commands/provider-smoke.ts --run gemini
```

Never run these as routine validation. The command refuses CI, disables tracing
and sensitive SDK logging, and prints only pass/fail labels. It uses the existing
configuration, approved prices and persistent monthly budget ledger; it does not
raise limits or enable services. It tries only the named provider (no hidden
fallback), with one text completion, a tool interaction (at most two model turns),
and one structured output, each capped at 256 output tokens. Thinking can exhaust
that small cap; failure is not proof the provider is generally incompatible.
Failed calls keep conservative reservations. A failed phase stops further checks.

Owner approval is required before running live checks, changing routes/prices,
or deciding whether to support unscoped Anthropic keys/native API migration.

## Automated validation

`npm run typecheck`, `npm test` (340 tests), `npm run format:check`, and
`git diff --check` passed. Invoking the smoke script without `--run` printed usage
and exited with status 1 without inference. No authorized live invocation was run.

## Official references

- [Anthropic OpenAI SDK compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)
- [Anthropic structured output/schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations)
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [Gemini thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures?generate-content=true#openai)
- [Gemini troubleshooting/authentication and transient failures](https://ai.google.dev/gemini-api/docs/troubleshooting)
- [Google-hosted developer forum: invalid-key 400 example (community report)](https://discuss.ai.google.dev/t/400-api-key-not-valid-did-something-change-in-last-2-days/58949)
