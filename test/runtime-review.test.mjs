import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, evidence, isGarnetComment, matchesRun, mcp, profileFor, publish, workloadEgress } from '../scripts/runtime-review.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const id = '73562dce-ddbc-464b-aea0-beb467d8d615';
const repo = 'garnet-labs/claude-ship-garnet';
const url = `https://github.com/${repo}/pull/1#issuecomment-42`;
const context = { repo, pr: 1, head, run: 2, attempt: 1 };

function review(overrides = {}, envelopeOverrides = {}) {
  const item = {
    determinable: true, bound_to_head: true, head_sha: head, marker_commit: head,
    status: 'finalized', capture_quality: 'best-effort', scope: 'base-ancestor',
    app_outcome: 'unchanged', profile_ids: [id], comment_url: url, ...overrides
  };
  return {
    ...item,
    envelope: {
      commit: head, previous: base, status: 'finalized', capture_quality: 'best-effort',
      incomplete: 0, jobs: 1, scope: 'base-ancestor', outcome: item.app_outcome,
      changed: 0, added: 0, removed: 0, ...envelopeOverrides
    }
  };
}

test('only a finalized, scoped, exact-base no-change record passes', () => {
  assert.equal(decide(review(), head, base), 'nothing-new');
  assert.equal(decide(review({ scope: 'pr-base' }, { scope: 'pr-base' }), head, base), 'nothing-new');
  assert.equal(decide(review({ scope: 'pr-base' }), head, base), 'unknown');
  assert.equal(decide(review(), head, 'c'.repeat(40)), 'unknown');
  assert.equal(decide(review({ marker_commit: base }), head, base), 'unknown');
  assert.equal(decide(review({ head_sha: base }), head, base), 'unknown');
  assert.equal(decide(review({ status: 'pending' }), head, base), 'unknown');
  assert.equal(decide(review({ determinable: false }), head, base), 'unknown');
  assert.equal(decide(review({ capture_quality: 'partial' }), head, base), 'unknown');
  assert.equal(decide(review({}, { incomplete: 1 }), head, base), 'unknown');
  assert.equal(decide(review({}, { jobs: 0 }), head, base), 'unknown');
  assert.equal(decide(review({}, { removed: 1 }), head, base), 'removals-only');
  assert.equal(decide(review({ app_outcome: 'first' }), head, base), 'unknown');
  assert.equal(decide(null, head, base), 'unknown');
});

test('a positive change is distinct from absent evidence', () => {
  const changed = review({ app_outcome: 'changed' }, { changed: 1, added: 1 });
  assert.equal(decide(changed, head, base), 'changed');
  assert.equal(decide(review({ app_outcome: 'changed' }), head, base), 'unknown');
});

test('GitHub App identity and exact run attempt cannot be substituted', () => {
  const comment = {
    html_url: url, user: { id: 210813234 }, performed_via_github_app: { id: 1249875 },
    body: `<!-- garnet-control-plane-pr-comment:v1:app.garnet.ai -->\n<!-- garnet:commit ${head} -->`
  };
  assert.equal(isGarnetComment(comment, head, url), true);
  assert.equal(isGarnetComment({ ...comment, user: { id: 1 } }, head, url), false);
  assert.equal(isGarnetComment(comment, base, url), false);
  const run = {
    path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: head,
    run_attempt: 1, head_repository: { full_name: repo }, pull_requests: [{ number: 1 }]
  };
  assert.equal(matchesRun(run, context), true);
  assert.equal(matchesRun({ ...run, run_attempt: 2 }, context), false);
  assert.equal(matchesRun({ ...run, pull_requests: [{ number: 1 }, { number: 2 }] }, context), false);
  assert.equal(matchesRun({ ...run, head_repository: { full_name: 'other/fork' } }, context), false);
});

function profile() {
  return {
    id, githubOrg: 'garnet-labs', repo: 'claude-ship-garnet',
    runID: '2', runAttempt: 1, job: 'runtime-build',
    data: { scenarios: { github: { head_sha: head } }, network: { egress: { peers: [
      { remote_names: ['example.com', 'not a host'], proc_trees: [{ github_step: '5. Build', arguments: 'not for output' }] },
      { remote_names: ['runner.example'], proc_trees: [{ github_step: 'Post Run' }] }
    ] } } }
  };
}

test('MCP profiles use exact selectors and paginate', async () => {
  const result = await profileFor(context, id, async (name, args) => {
    assert.equal(name, 'profiles');
    assert.equal(args.githubOrg, 'garnet-labs');
    assert.equal(args.repo, 'claude-ship-garnet');
    assert.equal(args.runID, '2');
    assert.equal(args.runAttempt, 1);
    assert.equal(args.job, 'runtime-build');
    if (args.pageArgs.after === 'page2') return { items: [profile()], pageInfo: { hasNextPage: false } };
    assert.equal(args.pageArgs.after, undefined);
    return { items: [], pageInfo: { hasNextPage: true, endCursor: 'page2' } };
  });
  assert.equal(result.id, id);
  assert.deepEqual(workloadEgress(result), ['example.com']);
});

test('receipt includes workload egress from install, smoke, and build, not runner-only peers', () => {
  const item = profile();
  item.data.network.egress.peers.push(
    { remote_names: ['install.example', 'example.com'], proc_trees: [{ github_step: '0. Install dependencies' }] },
    { remote_address: '10.0.0.1', proc_trees: [{ github_step: 'Smoke test' }, { github_step: '99. Runner Processes' }] },
    { remote_address: '169.254.169.254', proc_trees: [{ github_step: 'Test' }] },
    { remote_names: ['unattributed.example'], proc_trees: [{ github_step: '<unknown>' }, {}] },
    { remote_names: ['setup.example'], proc_trees: [{ github_step: '1. Set up job' }] },
    { remote_names: ['post.example'], proc_trees: [{ github_step: '8. Post Run checkout' }] }
  );
  assert.deepEqual(workloadEgress(item), ['10.0.0.1', '169.254.169.254', 'example.com', 'install.example']);
});

test('stale, missing, duplicate and unreadable observations do not pass', async () => {
  const stale = profile();
  stale.data.scenarios.github.head_sha = base;
  for (const items of [[stale], [], [profile(), profile()]]) {
    assert.equal(await profileFor(context, id, async () => ({ items, pageInfo: { hasNextPage: false } })), null);
  }
  assert.equal(await profileFor(context, id, async () => ({
    items: [profile()], pageInfo: { hasNextPage: true, endCursor: 'repeated' }
  })), null);
  await assert.rejects(profileFor(context, id, async () => { throw new Error('unreadable'); }), /unreadable/);
});

test('the hosted comparison must match the linked App comment and capture run', async () => {
  const outcome = review();
  const read = async (name, args) => {
    if (name === 'outcome') {
      assert.deepEqual(args, { githubOrg: 'garnet-labs', repo: 'claude-ship-garnet', pullNumber: 1 });
      return outcome;
    }
    return { items: [profile()], pageInfo: { hasNextPage: false } };
  };
  const comment = {
    html_url: url, user: { id: 210813234 }, performed_via_github_app: { id: 1249875 },
    body: [
      '<!-- garnet-control-plane-pr-comment:v1:app.garnet.ai -->',
      `<!-- garnet:commit ${head} -->`,
      `<!-- garnet:summary ${JSON.stringify(outcome.envelope)} -->`,
      `https://github.com/${repo}/actions/runs/2/job/123`
    ].join('\n')
  };
  const matched = await evidence(async path => {
    assert.equal(path, 'issues/comments/42');
    return comment;
  }, context, base, read);
  assert.equal(matched.verdict, 'nothing-new');
  assert.equal(matched.profile.id, id);
  assert.equal(await evidence(async () => ({ ...comment, body: comment.body.replace('/runs/2/', '/runs/3/') }),
    context, base, read), null);
  assert.equal(await evidence(async () => ({ ...comment, body: comment.body.replace('"incomplete":0', '"incomplete":1') }),
    context, base, read), null);
});

test('publishes head-bound checks; only observed changes hand work to Steward', async () => {
  for (const state of ['nothing-new', 'changed', 'removals-only', 'ci-failed', 'superseded']) {
    const run = {
      id: 2, path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: head,
      run_attempt: 1, head_repository: { full_name: repo }, pull_requests: [{ number: 1 }],
      conclusion: state === 'ci-failed' ? 'failure' : 'success'
    };
    let reads = 0;
    let conclusion;
    const gh = async (path, payload, method) => {
      if (path === 'pulls/1') {
        return {
          state: 'open', base: { sha: base, ref: 'main' },
          head: { sha: ++reads >= 3 && state === 'superseded' ? base : head, repo: { full_name: repo } }
        };
      }
      if (path === 'check-runs') {
        assert.equal(payload.name, 'garnet/runtime-diff');
        assert.equal(payload.head_sha, head);
        assert.equal(payload.status, 'in_progress');
        return { id: 57 };
      }
      if (path === 'actions/runs/2') return run;
      assert.equal(path, 'check-runs/57');
      assert.equal(method, 'PATCH');
      assert.equal(payload.status, 'completed');
      conclusion = payload.conclusion;
      assert.equal(payload.output.summary.includes('Steward receipt lookup selectors'), state === 'changed');
      if (state === 'removals-only') assert.equal(payload.output.title, 'Runtime destinations no longer seen');
    };
    await publish(run, repo, gh, async (_gh, observed, baseline) => {
      assert.notEqual(state, 'ci-failed');
      assert.deepEqual(observed, context);
      assert.equal(baseline, base);
      return { verdict: state === 'superseded' ? 'nothing-new' : state, url, profile: profile() };
    });
    assert.equal(conclusion, { 'nothing-new': 'success', changed: 'failure' }[state] ?? 'action_required');
  }
});

test('MCP transport handles JSON and SSE, but never parses tool text as evidence', async () => {
  const value = { one: 1 };
  const result = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: value } });
  assert.deepEqual(await mcp('outcome', {}, async () => new Response(result)), value);
  assert.deepEqual(await mcp('outcome', {}, async () => new Response(`data: ${result}\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' }
  })), value);
  await assert.rejects(mcp('outcome', {}, async () => Response.json({
    id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value) }] }
  })), /did not return structured evidence/);
});
