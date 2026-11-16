# GitHub agent loop

This guide covers implementation and owner-comment workflows. The reviewer has
separate [bounded operations](github-review.md) and
[security boundaries](../../SECURITY.md#github-pr-review-trust-boundaries);
it does not use their PAT, starter action, V1 client or generic routing.

This repository uses GitHub Issues and pull requests as the durable workflow state. GitHub Actions
is the event router; OpenCode runs as a bounded worker. The agent never merges its own pull request.

## Flow

1. For a straightforward task, capture it with the **Feature or improvement** issue form. For a
   larger idea, use a human planning pass first: install
   [`mattpocock/skills`](https://github.com/mattpocock/skills) for OpenCode with
   `npx skills@latest add mattpocock/skills -a opencode`, run `/setup-matt-pocock-skills`, then use
   `grill-with-docs` → `to-spec` → `to-tickets`. Split work into small, dependency-linked issues
   with testable acceptance criteria.
2. The repository owner adds the `agent:implement` label when the issue is ready. That explicit
   label is the approval gate for an implementation run.
3. OpenCode implements the issue, runs typecheck/tests, and opens a draft PR with `Closes #N` and
   manual-QA notes. Unclear or blocked tickets get a clarification comment instead of code.
4. CI runs on the PR. When it is ready for review, a separate bounded OpenCode context receives
   sanitized PR metadata and selected changed-file hunks, then a deterministic publisher posts
   a validated advisory verdict; it cannot merge. Owner comments that contain `/opencode ...` on the issue/PR or `/oc ...` on a code
   review comment trigger a focused follow-up.
5. A human checks the diff, CI, agent review, and manual-QA checklist, then merges. QA failures go
   back into the issue as new acceptance criteria or a new linked issue.

## One-time setup

1. Create a **fine-grained personal access token** for this repository
   only. Grant `Contents`, `Issues`, and `Pull requests` read/write access (Metadata read is
   automatic). Set the shortest practical expiration and do not grant workflow permissions. Add it
   as the Actions secret `OPENCODE_GH_TOKEN`. This avoids relying on the OpenCode GitHub App setup
   redirect. OpenCode's action accepts a caller-provided token with `use_github_token: true`; unlike
   the built-in `GITHUB_TOKEN`, a PAT can trigger follow-on CI and review workflows. Checkout keeps
   this credential available to OpenCode's Git fetch/push operations; only owner-triggered jobs can
   access it.
2. Add an Actions repository secret named `OPENCODE_API_KEY` containing the API key for your
   existing OpenCode Go subscription. Never commit either key or copy them into workflow YAML.
3. The owner must confirm the [billing and authorization safeguards](../../SECURITY.md#local-operation-and-owner-authorization):
   Go **Use balance / Extra Usage off**, Actions overage hard-stopped, standard Ubuntu runners.
   Add `agent:implement` to Issues labels if it is not already present.

## Spend and safety limits

- Only explicit owner labels/comments start implementation or comment workers.
  The separate reviewer runs automatically for eligible non-draft owner PR events.
- Jobs use standard Ubuntu runners, have timeouts, and serialize runs per issue/PR. The reviewer
  cancels stale runs when a newer commit arrives.
- Paid reservations are blocked by zero-dollar workflow limits; zero-priced hosted
  routes remain possible. Availability, quota and privacy restrictions can still
  stop a run. Exact approved fallback order is in
  [`config/models.json`](../../config/models.json), not an independent workflow list.
- Agent PRs are drafts; CI, fresh-context review, QA, and merge approval remain separate gates.

## Dr Watson routing (bounded)

The implementation/comment workflows route through `dr-watson/dr-watson-auto`:

- Each job starts the loopback API with
  [`.github/actions/start-dr-watson`](../../.github/actions/start-dr-watson/action.yml).
  It uses `LLM_PROVIDER=auto` and zero cash limits. The worker sets
  `model: dr-watson/dr-watson-auto`. The pinned OpenCode V1 CLI needs the custom provider injected
  through `OPENCODE_CONFIG_CONTENT`; without it OpenCode reports `Model not found:
  dr-watson/dr-watson-auto`.
- Owner-comment jobs opt into the bounded GitHub Actions mode described in the
  [README](../../README.md#bounded-github-actions-mode), which suppresses coding-session anchoring
  so the agent does not loop on open-ended research. Implementation jobs keep the normal anchoring.
- `OPENCODE_API_KEY` belongs only on the local API step, never in the OpenCode action environment.

Troubleshooting:

- `Author identity unknown`: set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and
  `GIT_COMMITTER_EMAIL` on the OpenCode action step. A `git config --global` step is not enough
  because the action runs git in a separate context.
- A job that hangs until its timeout is usually blocked on an interactive permission prompt for an
  external directory such as `/tmp/*`. Keep staging inside the workspace or restore files directly
  with `git show <commit>:<path> > <path>`.
- `refusing to allow a Personal Access Token to create or update workflow ... without workflow
  scope`: the repo-scoped PAT deliberately does not have the `workflow` permission, so an agent
  cannot push changes under `.github/workflows/`. The owner applies those workflow edits, or grants
  and later revokes the scope for a dedicated run.

OpenCode GitHub integration: <https://opencode.ai/docs/github>

Matt Pocock's skills: <https://github.com/mattpocock/skills>

GitHub Actions billing: <https://docs.github.com/en/billing/concepts/product-billing/github-actions>
