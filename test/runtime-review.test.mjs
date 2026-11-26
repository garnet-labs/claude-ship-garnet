import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEgress, decide, evidence, isGarnetComment, matchesRun, mcp, profileFor, publish } from '../scripts/runtime-review.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const id = '73562dce-ddbc-464b-aea0-beb467d8d615';
const repo = 'garnet-labs/claude-ship-garnet';
const url = `https://github.com/${repo}/pull/1#issuecomment-42`;
const context = { repo, pr: 1, head, run: 2, attempt: 1 };

function marker(overrides = {}) {
  return {
    commit: head, previous: base, status: 'finalized', capture_quality: 'best-effort',
    incomplete: 0, jobs: 1, scope: 'base-ancestor', outcome: 'unchanged',
    changed: 0, added: 0, removed: 0, ...overrides
  };
}

test('only a finalized, scoped, exact-base no-change record passes', () => {
  assert.equal(decide(marker(), head, base), 'nothing-new');
  assert.equal(decide(marker({ scope: 'pr-base' }), head, base), 'nothing-new');
  assert.equal(decide(marker({ scope: 'previous-run' }), head, base), 'unknown');
  assert.equal(decide(marker(), head, 'c'.repeat(40)), 'unknown');
  assert.equal(decide(marker({ commit: base }), head, base), 'unknown');
  assert.equal(decide(marker({ status: 'pending' }), head, base), 'unknown');
  assert.equal(decide(marker({ capture_quality: 'partial' }), head, base), 'unknown');
  assert.equal(decide(marker({ incomplete: 1 }), head, base), 'unknown');
  assert.equal(decide(marker({ jobs: 0 }), head, base), 'unknown');
  assert.equal(decide(marker({ removed: 1 }), head, base), 'removals-only');
  assert.equal(decide(marker({ outcome: 'first' }), head, base), 'unknown');
  assert.equal(decide(null, head, base), 'unknown');
});

test('a positive change is distinct from absent evidence', () => {
  const changed = marker({ outcome: 'changed', changed: 1, added: 1 });
  assert.equal(decide(changed, head, base), 'changed');
  assert.equal(decide(marker({ outcome: 'changed' }), head, base), 'unknown');
});

test('GitHub App identity and exact run attempt cannot be substituted', () => {
  const comment = {
    id: 42, html_url: url, user: { id: 210813234 }, performed_via_github_app: { id: 1249875 },
    body: `<!-- garnet-control-plane-pr-comment:v1:app.garnet.ai -->\n<!-- garnet:commit ${head} -->`
  };
  assert.equal(isGarnetComment(comment, context), true);
  assert.equal(isGarnetComment({ ...comment, user: { id: 1 } }, context), false);
  assert.equal(isGarnetComment({ ...comment, performed_via_github_app: { id: 1 } }, context), false);
  assert.equal(isGarnetComment(comment, { ...context, pr: 2 }), false);
  const run = {
    id: 2, path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: head,
    run_attempt: 1, head_repository: { full_name: repo }, pull_requests: [{ number: 1 }]
  };
  assert.equal(matchesRun(run, context), true);
  assert.equal(matchesRun({ ...run, id: 3 }, context), false);
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

test('MCP profiles use exact selectors, paginate, and expose only build destinations', async () => {
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
  assert.deepEqual(buildEgress(result), ['example.com']);
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

test('the trusted App comparison pins the capture attempt and exact MCP profile', async () => {
  const read = async (name, args) => {
    assert.equal(name, 'profiles');
    assert.equal(args.runID, '2');
    assert.equal(args.runAttempt, 1);
    return { items: [profile()], pageInfo: { hasNextPage: false } };
  };
  const comment = {
    id: 42, html_url: url, user: { id: 210813234 }, performed_via_github_app: { id: 1249875 },
    body: [
      '<!-- garnet-control-plane-pr-comment:v1:app.garnet.ai -->',
      `<!-- garnet:commit ${head} -->`,
      `<!-- garnet:summary ${JSON.stringify(marker())} -->`,
      `<a href="https://github.com/${repo}/actions/runs/2/job/123?utm_source=github">Job log</a>`,
      `<a href="https://app.garnet.ai/public/runs/2?profile=${id}&amp;utm_source=github">Full record</a>`
    ].join('\n')
  };
  const capture = { id: 123, name: 'runtime-build', run_attempt: 1, conclusion: 'success' };
  function github(comments, jobs = [capture]) {
    return async path => {
      if (path === 'issues/1/comments?per_page=100&page=1') return comments;
      assert.equal(path, 'actions/runs/2/attempts/1/jobs?per_page=100');
      return { total_count: jobs.length, jobs };
    };
  }
  const matched = await evidence(github([comment]), context, base, read);
  assert.equal(matched.verdict, 'nothing-new');
  assert.equal(matched.profile.id, id);
  assert.equal(matched.url, url);
  for (const body of [
    comment.body.replace(`garnet:commit ${head}`, `garnet:commit ${base}`),
    comment.body.replace('/job/123', '/job/124'),
    comment.body.replace('/public/runs/2', '/public/runs/3'),
    comment.body.replace('https://app.garnet.ai/', 'https://example.com/'),
    comment.body.replace('"incomplete":0', '"incomplete":1'),
    comment.body.replace(`profile=${id}`, `profile=${id}&amp;profile=${id}`),
    `${comment.body}\n<!-- garnet:summary malformed -->`,
    `${comment.body}\n<!-- garnet:commit ${head} -->`
  ]) assert.equal(await evidence(github([{ ...comment, body }]), context, base, read), null);
  assert.equal(await evidence(github([comment, comment]), context, base, read), null);
  assert.equal(await evidence(github([{ ...comment, user: { id: 1 } }]), context, base, read), null);
  assert.equal(await evidence(github([comment], [{ ...capture, run_attempt: 2 }]), context, base, read), null);
  assert.equal(await evidence(github([comment], [capture, capture]), context, base, read), null);

  const pagedGithub = async path => path === 'issues/1/comments?per_page=100&page=1'
    ? Array.from({ length: 100 }, () => ({}))
    : path === 'issues/1/comments?per_page=100&page=2' ? [comment] : github([])(path);
  assert.equal((await evidence(pagedGithub, context, base, read)).profile.id, id);
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
  assert.deepEqual(await mcp('profiles', {}, async () => new Response(result)), value);
  assert.deepEqual(await mcp('profiles', {}, async () => new Response(`data: ${result}\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' }
  })), value);
  await assert.rejects(mcp('profiles', {}, async () => Response.json({
    id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value) }] }
  })), /did not return structured evidence/);
});
