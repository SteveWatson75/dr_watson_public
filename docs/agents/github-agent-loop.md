# GitHub agent loop

This guide covers implementation and owner-comment workflows. See also
[advisory review](github-review.md) and
[security boundaries](../../SECURITY.md#github-agent-trust-boundaries).

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
3. OpenCode V2 reads the issue and repository, implements the issue and runs typecheck/tests.
   A shell step commits/pushes the changes and creates a draft PR with `Closes #N`,
   the model's summary, checks and manual-QA notes. No changes produces an issue comment
   with the agent's explanation or blocker.
4. Independent CI runs on the PR. When ready, OpenCode V2 reviews the diff and
   relevant code through Dr Watson and a `gh` step posts an advisory comment.
   Owner comments that contain `/opencode ...` on the issue/PR or `/oc ...` on a code
   review comment trigger a focused follow-up.
5. A human checks the diff, CI, agent review, and manual-QA checklist, then merges. QA failures go
   back into the issue as new acceptance criteria or a new linked issue.

## One-time setup

1. Create a **fine-grained personal access token** for this repository
   only. Grant `Contents`, `Issues`, and `Pull requests` read/write access (Metadata read is
   automatic). Set the shortest practical expiration and do not grant workflow permissions. Add it
   as the Actions secret `OPENCODE_GH_TOKEN`. This avoids relying on the OpenCode GitHub App setup
   redirect for the legacy owner-comment action. Unlike the built-in `GITHUB_TOKEN`,
   a PAT can trigger follow-on CI and review workflows. Implementation exposes it
   only to the final commit/push/draft-PR step, not to OpenCode. The existing legacy
   owner-comment action still receives it directly. The PAT scopes do not prevent
   merging: agents are instructed never to merge.
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
- Agent PRs are drafts; deterministic CI, advisory review and human QA are independent.

## Dr Watson routing (bounded)

Implementation, review and owner-comment workflows route through `dr-watson/dr-watson-auto`:

- Each job starts the loopback API with
  [`.github/actions/start-dr-watson`](../../.github/actions/start-dr-watson/action.yml).
  It uses `LLM_PROVIDER=auto` and zero cash limits. The worker sets
  `dr-watson/dr-watson-auto` model. Implementation/review call native V2
  `opencode run` using `opencode.json`; hidden title/summary calls also use the router.
  They have 40/30 native model-step limits respectively.
  The unchanged legacy owner-comment action needs its inline V1 provider override.
- Review and owner-comment jobs opt into the bounded GitHub Actions mode described in the
  [README](../../README.md#bounded-github-actions-mode), which suppresses coding-session anchoring
  so the agent does not loop on open-ended research. Implementation jobs keep the normal anchoring.
- `OPENCODE_API_KEY` belongs only on the local API step, never in OpenCode's environment.
  Checkout credentials are not persisted in implementation/review. The shared starter
  installs trusted dependencies without lifecycle hooks and never dumps raw router logs.

Troubleshooting:

- `Author identity unknown`: keep `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
  `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` on the commit step (or the legacy
  OpenCode action for owner comments).
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
