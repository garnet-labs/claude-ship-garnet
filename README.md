# Claude Ship × Garnet: one-PR exhibit

One dependency bump, three heads: manifest only → the same bump with a no-data
build callout → a correction that keeps the bump and removes the callout.
The fixture uses a private npm workspace package (not a published package);
the GitHub repository is public so the demo needs no Garnet secrets.

## What this tests

| Surface | What it does | What it does not do |
|---|---|---|
| [Garnet CI](https://github.com/garnet-org/action/releases/tag/v2.6.0) | Records the Linux install/build with the same OIDC setup as the [runtime-review kit](https://github.com/garnet-labs/garnet-runtime-review-mcp/tree/02ec1669cdb03bc4416db18b9826ccfd26530b97/skills/garnet-runtime-review-install). | Prove zero new processes or cover anything outside the recorded job. Capture is best-effort. |
| [Claude Approvals](https://code.claude.com/docs/en/approvals-policy#if) | A manifest-only change can receive Claude's approving review if native Code Review passes and the policy is enforced. A code or config change needs a non-author. | Read or wait for the Garnet check inside its policy. |
| **Custom GitHub check** | `garnet/runtime-diff` blocks a merge when the finalized Garnet comparison records a change or no usable comparison is available. | Approve, dismiss a review, or merge a PR. |
| [PR Steward](https://code.claude.com/docs/en/pr-steward#what-pr-steward-fixes) | Works from a real failed GitHub check. The checked-in skill tells it to read the exact hosted MCP profile before making a narrow fix. | Treat missing evidence as a fix request. |

The custom check runs from the default branch after CI. It executes no PR
code and downloads no PR artifacts. It uses the public Garnet MCP `outcome`
and `profiles` tools, verifies the linked Garnet App comment, and requires the
current head, exact base commit, run, attempt, and recorded job to agree.
The exhibit is for trusted same-repository branches, not fork PRs or a
production security boundary: an actor who can run a workflow with
`checks: write` as GitHub Actions shares the check's source identity.

## Install

1. Merge these files to a public repository's `main`. Wait for one
   instrumented `CI` run on that exact commit before opening the exhibit.
   If Garnet does not post on the PR, verify that the
   [Garnet GitHub App](https://app.garnet.ai/) can access the repository.
2. A Claude Team or Enterprise owner follows [Claude Ship setup](https://code.claude.com/docs/en/claude-ship#set-up-claude-ship)
   for only this repository. Link the [Claude GitHub App](https://github.com/apps/claude),
   enable Code Review, and start Steward in Manual mode to check its behavior.
   The author can opt into [automatic Steward](https://code.claude.com/docs/en/pr-steward-pull-requests#turn-off-or-limit-pr-steward-on-all-your-pull-requests)
   for the unattended exhibit. Set a usage cap in Claude Ship.
3. **Custom Steward setup:** If its hosted environment blocks the MCP domain,
   assign a [shared environment](https://code.claude.com/docs/en/pr-steward-setup#choose-the-environment-pr-steward-runs-in)
   with `api.garnet.ai` in the allowed domains. The helper uses no credentials
   and makes a read-only MCP call over HTTPS. `.mcp.json` is the kit's
   interactive Claude Code config; we do not assume Steward loads it.
4. Start with [Approvals in observe mode](https://code.claude.com/docs/en/approvals-setup#start-in-observe-mode).
   Once its decisions match the exhibit, remove `mode: observe` in a separate
   reviewed PR. Observe mode cannot post an approving review.
5. In [GitHub's branch rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass),
   require both **Claude Approvals** (Claude app) and **garnet/runtime-diff**
   (GitHub Actions) on `main`; require branches to be current and dismiss
   stale reviews on push. Follow [Steward's branch rules](https://code.claude.com/docs/en/pr-steward-setup#require-reviews-with-branch-rules)
   and don't grant the app a bypass. Leave auto-merge off for the exhibit.
   This adapter intentionally won't pass a comparison with an older base
   ancestor or multiple captured jobs.

## Replay on one PR

Start from the recorded `main` and create a topic branch. For the first head:

```sh
npm version 1.0.1 --workspace @exhibit/format-label --no-git-tag-version
git add package-lock.json packages/format-label/package.json
git commit -m 'chore: bump format-label to 1.0.1'
```

Open a ready PR. Save the App comment permalink, `garnet/runtime-diff` check,
and the Claude review for the exact head. Expect the check to say **No new
runtime behavior recorded** if the recorded comparison found no delta. Only
claim a Claude approval if GitHub shows the approving review at this head.

For the second head, edit `packages/format-label/index.mjs` to use this
fixture, commit, and push. It sends no user, repo, or build data and ignores
network errors so the build test alone cannot detect the callout:

```js
export async function formatLabel(label) {
  await fetch('https://example.com/', {
    method: 'HEAD',
    signal: AbortSignal.timeout(5000)
  }).catch(() => {});
  return label.trim().toLowerCase();
}
```

Expect the ordinary build to succeed and the custom runtime check to fail
with **Runtime behavior changed**. Watch for a Steward-authored reply naming
the exact MCP profile and a Steward commit removing only the callout. Check
the final head's GitHub diff, Garnet comparison, and Claude review separately.
If you arm Steward with `@claude steward`, report the manual trigger; if a
person pushes the correction, do not report it as a Steward fix.

Do not present a timed-out, first, incomplete, or stale record as a pass.
Rerun the capture if the profile is unavailable. A passing check means only
that no new behavior or removals were recorded in this comparison.
Removal-only comparisons stay blocked for human review without requesting a
Steward fix.

## Local checks

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
actionlint
```
