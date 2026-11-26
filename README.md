# Claude Ship × Garnet: one-PR exhibit

One PR tests whether a dependency version change passes code review but
changes what CI reaches at runtime. Playwright's browser installer follows a
different download redirect after the upgrade, without changing the test or
build commands. Public GitHub CI needs no Garnet secrets.

## What this tests

| Surface | What it does | What it does not do |
|---|---|---|
| [Garnet CI](https://github.com/garnet-org/action/releases/tag/v2.6.0) | Records the Linux install/build with the same OIDC setup as the [runtime-review kit](https://github.com/garnet-labs/garnet-runtime-review-mcp/tree/02ec1669cdb03bc4416db18b9826ccfd26530b97/skills/garnet-runtime-review-install). | Prove zero new processes or cover anything outside the recorded job. Capture is best-effort. |
| [Claude Approvals](https://code.claude.com/docs/en/approvals-policy#if) | A manifest-only change can receive Claude's approving review if native Code Review passes and the policy is enforced. A code or config change needs a non-author. | Read or wait for the Garnet check inside its policy. |
| **Custom GitHub check** | `garnet/runtime-diff` blocks a merge when the finalized Garnet comparison records a change or no usable comparison is available. | Approve, dismiss a review, or merge a PR. |
| [PR Steward](https://code.claude.com/docs/en/pr-steward#what-pr-steward-fixes) | Works from a real failed GitHub check. The checked-in skill tells it to read the exact hosted MCP profile before making a narrow fix. | Treat missing evidence as a fix request. |

The custom check runs from the default branch after CI. It executes no PR
code and downloads no PR artifacts. It reads the finalized Garnet App comment
directly from GitHub, then reads the referenced record using the public Garnet
MCP `profiles` tool. The head, exact base, run, attempt, job and profile must
agree. The publisher and Steward don't need the MCP PR-outcome lookup.
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
   keep the existing rules on `main`. For the exhibit, require
   **garnet/runtime-diff** (GitHub Actions) on `exhibit/playwright` and
   require topic branches to be current. Do not grant a bypass or enable
   auto-merge for the exhibit. This adapter won't pass a comparison with an
   older base ancestor or multiple captured jobs.

## Replay on one PR

Use [`exhibit/playwright`](https://github.com/garnet-labs/claude-ship-garnet/tree/exhibit/playwright)
as the baseline. To create this baseline on a fresh install, branch from the
merged setup, then pin the browser dependency:

```sh
git switch -c exhibit/playwright
npm install --workspace @exhibit/format-label --save-dev --save-exact --package-lock-only --ignore-scripts --no-audit --no-fund playwright@1.56.1
```

On that branch only, set the captured `runtime-build` runner to
`ubuntu-24.04` and add `npx --no-install playwright install chromium --only-shell`
before `npm run build` in the existing **Build** step. Commit and publish the
branch, record its exact push run, then apply the exhibit branch rule. This
keeps the intentional first browser download off protected `main`.

After the baseline run succeeds, create a topic branch from that exact commit
and update only Playwright:

```sh
npm install --workspace @exhibit/format-label --save-dev --save-exact --package-lock-only --ignore-scripts --no-audit --no-fund playwright@1.57.0
git add package-lock.json packages/format-label/package.json
git commit -m 'chore(deps): bump Playwright to 1.57.0'
```

Open a ready PR into `exhibit/playwright`. Only the workspace manifest and
lockfile should differ.
Save the App comment permalink, `garnet/runtime-diff` check, and Claude
review for the exact head. The ordinary build should succeed. Verify
separately whether Claude passes the diff, Approvals would approve it in
observe mode, and the runtime gate blocks the merge. Only claim an approval
if GitHub shows the approving review at this head.

Watch for a Steward-authored reply naming the exact MCP profile and a
Steward-authored change. The skill specifies how to read evidence, not
which package or version to edit. Check the final head's diff, profile and
required check separately. The download implementation is outside the PR
diff; a reviewer can still inspect the upstream dependency and release notes.
If you arm Steward with `@claude steward`, report the manual trigger; if a
person pushes the correction, do not report it as a Steward fix.

Do not present a timed-out, first, incomplete, or stale record as a pass.
Rerun the capture if the profile is unavailable. A passing check means no
new workload connections were recorded in this comparison. Garnet may still
record additions or removals not tied to a workflow step. Workload
removal-only comparisons stay blocked for human review without requesting a
Steward fix.

## Local checks

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
actionlint
```
