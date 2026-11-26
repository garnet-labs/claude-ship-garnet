import assert from 'node:assert/strict';
import test from 'node:test';
import pr6 from './pr-review-pr6.json' with { type: 'json' };
import { decide, evidence, invalidateRetargetedChecks, isGarnetComment, matchesRun, mcp, profileFor, publish, workloadEgress } from '../scripts/runtime-review.mjs';

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

test('a finalized App change with background additions but no workload delta stays scoped', () => {
  const background = marker({ outcome: 'changed', unattributed: 0, backgroundAdded: 8, backgroundRemoved: 2 });
  assert.equal(decide(background, head, base), 'background-only');
  for (const overrides of [{ unattributed: 1 }, { added: 1 }, { removed: 1 },
    { backgroundAdded: 0 }, { status: 'recording' }, { capture_quality: 'partial' }]) {
    assert.equal(decide({ ...background, ...overrides }, head, base), 'unknown');
  }
  assert.equal(decide({ ...background, changed: 1, added: 1 }, head, base), 'changed');
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
  const { run_attempt: _attempt, ...captureWithoutAttempt } = capture;
  assert.equal((await evidence(github([comment], [captureWithoutAttempt]), context, base, read)).profile.id, id);
  for (const body of [
    comment.body.replace(`garnet:commit ${head}`, `garnet:commit ${base}`),
    comment.body.replace('/job/123', '/job/124'),
    comment.body.replace('/public/runs/2', '/public/runs/3'),
    comment.body.replace('https://app.garnet.ai/', 'https://example.com/'),
    comment.body.replace('"incomplete":0', '"incomplete":1'),
    comment.body.replace(JSON.stringify(marker()), '{malformed}'),
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

test('PR #6 publishes success only after binding its App comment and capture profile', async () => {
  const recordedHead = pr6.head_sha;
  const recordedBase = pr6.envelope.previous;
  const run = {
    id: 45724477522, path: '.github/workflows/ci.yml', event: 'pull_request', conclusion: 'success',
    head_sha: recordedHead, run_attempt: 1, head_repository: { full_name: repo }, pull_requests: [{ number: 6 }]
  };
  const request = { repo, pr: 6, head: recordedHead, run: run.id, attempt: 1 };
  const [profileID] = pr6.profile_ids;
  const comment = {
    id: 7177218621, html_url: pr6.comment_url, user: { id: 210813234 }, performed_via_github_app: { id: 1249875 },
    body: [
      '<!-- garnet-control-plane-pr-comment:v1:app.garnet.ai -->',
      `<!-- garnet:commit ${recordedHead} -->`,
      `<!-- garnet:summary ${JSON.stringify(pr6.envelope)} -->`,
      `<a href="https://github.com/${repo}/actions/runs/${run.id}/job/139590716442">Job log</a>`,
      `<a href="https://app.garnet.ai/public/runs/${run.id}?profile=${profileID}">Full record</a>`
    ].join('\n')
  };
  const recordedProfile = {
    ...profile(), id: profileID, runID: String(run.id),
    data: { scenarios: { github: { head_sha: recordedHead } }, network: { egress: { peers: [] } } }
  };
  const readMcp = item => async (name, args) => {
    assert.equal(name, 'profiles');
    assert.equal(args.runID, String(run.id));
    assert.equal(args.runAttempt, 1);
    assert.equal(args.job, 'runtime-build');
    return { items: [item], pageInfo: { hasNextPage: false } };
  };
  const writes = [];
  const github = appComment => async (path, body, method) => {
    if (path === 'pulls/6') return {
      state: 'open', head: { sha: recordedHead, repo: { full_name: repo } }, base: { ref: 'main', sha: recordedBase }
    };
    if (path === `actions/runs/${run.id}`) return run;
    if (path === 'issues/6/comments?per_page=100&page=1') return [appComment];
    if (path === `actions/runs/${run.id}/attempts/1/jobs?per_page=100`) return {
      total_count: 1, jobs: [{ id: 139590716442, name: 'runtime-build', run_attempt: 1, conclusion: 'success' }]
    };
    assert.ok(body);
    writes.push({ path, body, method });
    return { id: 1 };
  };
  assert.equal(await publish(run, repo, github(comment), (gh, context, base) =>
    evidence(gh, context, base, readMcp(recordedProfile))), `garnet/runtime-diff: nothing-new on ${recordedHead}`);
  assert.deepEqual(writes.map(({ path, body, method }) => [path, body.status, method]), [
    ['check-runs', 'in_progress', undefined], ['check-runs/1', 'completed', 'PATCH']
  ]);
  assert.equal(writes[0].body.head_sha, recordedHead);
  assert.equal(writes[1].body.conclusion, 'success');
  assert.equal(writes[1].body.output.title, 'No new runtime behavior recorded');
  assert.equal(await evidence(github({ ...comment, performed_via_github_app: { id: 1 } }),
    request, recordedBase, readMcp(recordedProfile)), null);
  assert.equal(await evidence(github(comment), request, recordedBase, readMcp({ ...recordedProfile, runAttempt: 2 })), null);
  assert.equal(await evidence(github(comment), request, recordedBase, readMcp({ ...recordedProfile, id })), null);
});

test('publishes head-bound checks; only observed changes hand work to Steward', async () => {
  for (const state of ['nothing-new', 'background-only', 'changed', 'removals-only', 'ci-failed', 'superseded', 'retargeted', 'untracked-base']) {
    const run = {
      id: 2, path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: head,
      run_attempt: 1, head_repository: { full_name: repo }, pull_requests: [{ number: 1 }],
      conclusion: state === 'ci-failed' ? 'failure' : 'success'
    };
    let reads = 0;
    let conclusion;
    const gh = async (path, payload, method) => {
      if (path === 'pulls/1') {
        reads++;
        const ref = state === 'untracked-base' ? 'other' :
          state === 'changed' || (state === 'retargeted' && reads >= 3) ? 'exhibit/playwright' : 'main';
        return {
          state: 'open', base: { sha: base, ref },
          head: { sha: reads >= 3 && state === 'superseded' ? base : head, repo: { full_name: repo } }
        };
      }
      if (path === 'check-runs') {
        assert.equal(payload.name, 'garnet/runtime-diff');
        assert.equal(payload.head_sha, head);
        assert.equal(payload.status, 'in_progress');
        assert.equal(payload.external_id, `1:${state === 'changed' ? 'exhibit/playwright' : 'main'}:${base}`);
        return { id: 57 };
      }
      if (path === 'actions/runs/2') return run;
      assert.equal(path, 'check-runs/57');
      assert.equal(method, 'PATCH');
      assert.equal(payload.status, 'completed');
      conclusion = payload.conclusion;
      assert.equal(payload.output.summary.includes('Steward receipt lookup selectors'), state === 'changed');
      if (state === 'removals-only') assert.equal(payload.output.title, 'Runtime destinations no longer seen');
      if (state === 'background-only') {
        assert.equal(payload.output.title, 'No new workload connections recorded');
        assert.match(payload.output.summary, /changes to connections not tied to a workflow step/);
      }
    };
    await publish(run, repo, gh, async (_gh, observed, baseline) => {
      assert.notEqual(state, 'ci-failed');
      assert.deepEqual(observed, context);
      assert.equal(baseline, base);
      return { verdict: ['superseded', 'retargeted'].includes(state) ? 'nothing-new' : state, url, profile: profile() };
    });
    assert.equal(conclusion, state === 'untracked-base' ? undefined :
      { 'nothing-new': 'success', 'background-only': 'success', changed: 'failure' }[state] ?? 'action_required');
    if (state === 'untracked-base') assert.equal(reads, 1);
  }
});

test('waits for late current-head evidence and fails closed when the wait expires', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const run = {
    id: 2, path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: head, run_attempt: 1,
    head_repository: { full_name: repo }, pull_requests: [{ number: 1 }], conclusion: 'success'
  };
  for (const [availableAfter, verdict, conclusion, elapsed] of [
    [32 * 60_000, 'changed', 'failure', 32 * 60_000],
    [Infinity, 'unknown', 'action_required', 45 * 60_000]
  ]) {
    const start = Date.now();
    const gh = async (path, body) => {
      if (path === 'pulls/1') {
        return { state: 'open', base: { ref: 'main', sha: base }, head: { sha: head, repo: { full_name: repo } } };
      }
      if (path === 'check-runs') return { id: 57 };
      if (path === 'actions/runs/2') return run;
      assert.equal(path, 'check-runs/57');
      assert.equal(body.conclusion, conclusion);
      assert.equal(Date.now() - start, elapsed);
    };
    const read = async () => Date.now() - start < availableAfter ? null : { verdict, url, profile: profile() };
    assert.equal(await publish(run, repo, gh, read, async ms => t.mock.timers.tick(ms)),
      `garnet/runtime-diff: ${verdict} on ${head}`);
  }
});

test('retargeting invalidates only old passing runtime checks for the same PR and head', async () => {
  const pull = {
    number: 1, state: 'open', base: { ref: 'exhibit/playwright', sha: base },
    head: { sha: head, repo: { full_name: repo } }
  };
  const event = { action: 'edited', changes: { base: { ref: { from: 'main' } } }, pull_request: pull };
  const outdated = {
    id: 1, name: 'garnet/runtime-diff', app: { id: 15368 }, conclusion: 'success',
    external_id: `1:main:${base}`,
    output: { summary: `[Garnet Runtime Review](${url}) · compared with \`${base}\`.` }
  };
  const writes = [];
  const gh = async (path, body, method) => {
    if (path === 'pulls/1') return pull;
    if (path === `commits/${head}/check-runs?check_name=garnet%2Fruntime-diff&filter=all&per_page=100&page=1`) return {
      check_runs: [
        outdated, { ...outdated, id: 2, external_id: '' },
        { ...outdated, id: 3, external_id: `1:exhibit/playwright:${base}` },
        { ...outdated, id: 4, app: { id: 1 } },
        { ...outdated, id: 5, output: { summary: outdated.output.summary.replace('/pull/1', '/pull/2') } },
        { ...outdated, id: 6, conclusion: 'failure' }
      ]
    };
    writes.push({ path, body, method });
  };
  assert.equal(await invalidateRetargetedChecks(event, repo, gh), 2);
  assert.deepEqual(writes.map(({ path, body, method }) => [path, body.status, body.conclusion, method]), [
    ['check-runs/1', 'completed', 'action_required', 'PATCH'],
    ['check-runs/2', 'completed', 'action_required', 'PATCH']
  ]);
  assert.equal(await invalidateRetargetedChecks({ ...event, changes: {} }, repo, async () => assert.fail('metadata edit')), undefined);
  assert.equal(await invalidateRetargetedChecks(event, repo, async path => {
    assert.equal(path, 'pulls/1');
    return { ...pull, base: { ...pull.base, ref: 'main' } };
  }), undefined);
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
