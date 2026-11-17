# Advisory GitHub review

One job runs OpenCode V2 through the existing Dr Watson loopback API and posts its
final text with `gh pr comment`. There is no custom inference wrapper, context
manifest, result artifact, verdict validator, approval eligibility or AI merge gate.

## Events and inspection

`pull_request_target` events `opened`, `synchronize`, `reopened` and
`ready_for_review` review non-draft, owner-authored, same-repository PRs targeting
main. Drafts and forks do not run. Only the trusted base SHA is checked out; npm
lifecycle scripts are disabled. The head is fetched into Git, not checked out.
OpenCode reads the description, full Git diff and relevant base/head source using
its normal tools. PR configuration, plugins and test code are not executed.

There is no fixed 20 KB excerpt or complete-coverage certification. Normal tool
output/context limits still apply. The prompt requests actionable findings with
file/line references and impact, important inspection limitations, manual QA and
the reviewed SHA. No findings does not mean approval.

## Permissions and limits

- Contents/PR **read**, Issues **write** for comments. No PAT, Contents write,
  PR write, formal approval or merge operation.
- OpenCode gets no GitHub token or upstream key. A final trusted `gh` step gets
  `GITHUB_TOKEN`. The same job owns that limited token; this is not process isolation.
- Native OpenCode configuration denies tools except reads/searches and Git
  diff/show. PR text, code, comments and instructions are untrusted review data.
  These controls limit operations, not the reliability of the model's judgment.
- Fifteen-minute job, ten-minute model step, 30 native model steps, one active
  run per PR. Zero-dollar router budgets block paid fallback, not Go allowance use;
  keep Extra Usage off. Approved routes/privacy checks remain shared with local use.
- Raw JSONL/model/router logs stay on the ephemeral runner, not in comments or
  uploaded artifacts. Only the final review text is published. Do not commit secrets:
  source can reach the provider and appear in model output.

The legacy OpenCode GitHub action can publish with Issues write and read-only
Contents/PR permissions, but invokes `opencode github run`, which V2 does not
provide. Native V2 `opencode run` plus one `gh` command avoids that legacy client
without recreating a review service. Both implementation and review use the pinned
V2 CLI and existing project provider configuration.

## Deployment and live smoke tests

Keep standard CI required as appropriate; **do not require AI review**. If branch
rules still require retired `analyze`, `publish`, `review-execution`,
`review-integrity` or `review-policy` checks, the owner must remove those AI check
requirements. Do not weaken independent CI or human protections. Workflows do not
change repository settings automatically.

Offline checks cannot verify GitHub permissions, provider availability or useful
live findings. With explicit owner authorization after merge:

1. Apply `agent:implement` to a small test issue as owner. Check that tests/typecheck
   run and the created PR is **draft**, with summary, actual checks and manual QA.
   Confirm no review starts while it is draft and follow-on deterministic CI runs.
2. Mark that PR ready. Confirm one advisory comment identifies the head, concrete
   findings (use a harmless known bug), limitations and manual QA; no approval,
   branch push, file change or merge occurs. Inspect the job's reported token scopes.
3. Push a follow-up commit and confirm a new review; reopen to verify that trigger.
   An older comment may remain: compare its SHA with the current head.
4. Check that a non-owner label, draft PR and fork do not start these agents.
   On timeout/provider failure, expect a failed run without a fabricated review.

See [security boundaries](../../SECURITY.md#github-agent-trust-boundaries).
