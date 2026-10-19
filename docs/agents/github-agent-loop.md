# GitHub agent loop

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
4. CI runs on the PR. When it is ready for review, a separate bounded OpenCode context reads the
   PR description, linked issue, and changed-file diff, then posts actionable review findings; it
   cannot merge. Owner comments that contain `/opencode ...` on the issue/PR or `/oc ...` on a code
   review comment trigger a focused follow-up.
5. A human checks the diff, CI, agent review, and manual-QA checklist, then merges. QA failures go
   back into the issue as new acceptance criteria or a new linked issue.

For large changes, use a human planning pass to turn the idea into a spec and dependency-linked
issues before labeling individual slices. Keep one issue small enough for a fresh agent context.

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
3. In the OpenCode Console, turn **Use balance** off so reaching the Go model allowance blocks
   requests instead of falling back to paid balance.
4. In GitHub billing, keep Actions overage blocked (no payment method, or an Actions budget with a
   hard stop). Standard Ubuntu minutes for private repositories draw from the account's included
   monthly allowance; do not use larger runners. Add `agent:implement` to Issues labels if it is not
   already present.

## Spend and safety limits

- Only explicit owner actions start an agent. There are no schedules or automatic runs on every
  issue edit.
- Jobs use standard Ubuntu runners, have timeouts, and serialize runs per issue/PR. The reviewer
  cancels stale runs when a newer commit arrives.
- Workflows route through Dr Watson (`dr-watson/dr-watson-auto`) on `http://127.0.0.1:8787/v1`. A
  `start-dr-watson` composite action starts `npm run serve` with `LLM_PROVIDER=auto` and
  `LLM_MONTHLY_SOFT_LIMIT_USD=0` / `LLM_MONTHLY_HARD_LIMIT_USD=0`, so paid routes are blocked. The
  pinned OpenCode V1 provider is injected through `OPENCODE_CONFIG_CONTENT` (see
  [README](../../README.md#opencode-local-backend)).
- The review action step has a 10-minute `timeout-minutes` safety valve with `continue-on-error`, so
  an over-long run is cancelled instead of waiting for the job timeout.
- OpenCode Go usage is included in the existing subscription. In the OpenCode Console, keep **Use
  balance** off so hitting the Go allowance blocks the run instead of falling back to paid balance.
- When the paid Go models reach their rolling 5-hour or weekly allowance, OpenCode Go falls back to
  its free models (`beam-free`, then `longcat-2.5-preview-free`). They carry no monthly limit and
  keep a run progressing at $0 while the subscription allowance recovers.
- Agent PRs are drafts; CI, fresh-context review, QA, and merge approval remain separate gates.
- The review workflow only checks same-repository PRs opened by the repository owner; fork PRs are
  excluded.

## Dr Watson routing (bounded)

The agent workflows route through `dr-watson/dr-watson-auto`, backed by the local API behavior:

- Each job starts the router with `.github/actions/start-dr-watson` and sets
  `model: dr-watson/dr-watson-auto`. The pinned OpenCode V1 CLI needs the custom provider injected
  through `OPENCODE_CONFIG_CONTENT`; without it OpenCode reports `Model not found:
  dr-watson/dr-watson-auto`.
- Review and owner-comment jobs opt into the bounded GitHub Actions mode described in the
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
