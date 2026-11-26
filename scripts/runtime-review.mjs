import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const sha = /^[a-f0-9]{40}$/;
const repoName = /^[\w.-]+\/[\w.-]+$/;
const profileID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const captureWorkflow = '.github/workflows/ci.yml';
const captureJob = 'runtime-build';
const checkName = 'garnet/runtime-diff';
const actionsAppId = 15368;
const supportedBases = new Set(['main', 'exhibit/playwright']);
const endpoint = 'https://api.garnet.ai/api/v2/mcp';
const evidenceTimeoutMs = 45 * 60_000;
const evidencePollMs = 30_000;
const exec = promisify(execFile);

export async function mcp(name, args, fetchImpl = fetch) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Garnet MCP HTTP ${response.status}`);
  const body = await response.text();
  const message = response.headers.get('content-type')?.includes('text/event-stream')
    ? body.split(/\r?\n\r?\n/).flatMap(event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
      return data.length ? [JSON.parse(data.join('\n'))] : [];
    }).find(event => event.id === 1)
    : JSON.parse(body);
  if (message?.id !== 1 || message.error || message.result?.isError || !message.result?.structuredContent) {
    throw new Error('Garnet MCP did not return structured evidence');
  }
  return message.result.structuredContent;
}

function github(repo, token) {
  if (typeof repo !== 'string' || !repoName.test(repo)) throw new Error('Invalid repository');
  return async (path, body, method = 'POST') => {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { method, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    return response.json();
  };
}

export function decide(marker, head, base) {
  if (!sha.test(head) || !sha.test(base) ||
      marker?.commit !== head || marker.previous !== base || marker.status !== 'finalized' ||
      !['complete', 'best-effort'].includes(marker.capture_quality) || marker.incomplete !== 0 ||
      marker.jobs !== 1 || !['pr-base', 'base-ancestor'].includes(marker.scope)) return 'unknown';
  if (marker.outcome === 'changed' && marker.changed === 1) return 'changed';
  if (marker.outcome === 'changed' && marker.changed === 0 && marker.added === 0 &&
      marker.removed === 0 && marker.unattributed === 0 &&
      Number.isSafeInteger(marker.backgroundAdded) && marker.backgroundAdded > 0) return 'background-only';
  if (marker.outcome === 'unchanged' && marker.changed === 0 && marker.added === 0) {
    if (marker.removed === 0) return 'nothing-new';
    if (Number.isSafeInteger(marker.removed) && marker.removed > 0) return 'removals-only';
  }
  return 'unknown';
}

export function matchesRun(run, { repo, pr, head, run: id, attempt }) {
  return run?.id === id && run.path === captureWorkflow && run.event === 'pull_request' &&
    run.head_sha === head && run.run_attempt === attempt &&
    run.head_repository?.full_name === repo && run.pull_requests?.length === 1 &&
    run.pull_requests[0]?.number === pr;
}

export async function profileFor({ repo, head, run, attempt }, id, call = mcp) {
  if (typeof id !== 'string' || !profileID.test(id)) return null;
  const [githubOrg, name] = repo.split('/');
  const seen = new Set();
  let after;
  let match = null;
  do {
    const page = await call('profiles', {
      githubOrg, repo: name, runID: String(run), runAttempt: attempt, job: captureJob,
      pageArgs: { first: 10, ...(after === undefined ? {} : { after }) }
    });
    if (!Array.isArray(page.items) || typeof page.pageInfo?.hasNextPage !== 'boolean') return null;
    for (const item of page.items) {
      if (item?.id !== id) continue;
      const metadata = item.data?.scenarios?.github;
      if (match || item.githubOrg !== githubOrg || item.repo !== name ||
          String(item.runID) !== String(run) || item.runAttempt !== attempt || item.job !== captureJob ||
          (metadata?.head_sha && metadata.head_sha !== head) ||
          !Array.isArray(item.data?.network?.egress?.peers)) return null;
      // The App-provided profile ID ties the record to the head even if the
      // profile only carries a GitHub test-merge SHA.
      match = item;
    }
    if (!page.pageInfo.hasNextPage) return match;
    after = page.pageInfo.endCursor;
    if (typeof after !== 'string' || !after || seen.has(after) || seen.size >= 9) return null;
    seen.add(after);
  } while (true);
}

export function isGarnetComment(comment, { repo, pr }) {
  if (!Number.isSafeInteger(comment?.id) || comment.id <= 0 ||
      comment.html_url !== `https://github.com/${repo}/pull/${pr}#issuecomment-${comment.id}` ||
      comment.user?.id !== 210813234 ||
      comment.performed_via_github_app?.id !== 1249875 || typeof comment.body !== 'string') return false;
  return comment.body.split(/\r?\n/).includes('<!-- garnet-control-plane-pr-comment:v1:app.garnet.ai -->');
}

async function appComment(gh, context) {
  let match;
  for (let page = 1; page <= 5; page++) {
    const comments = await gh(`issues/${context.pr}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) return null;
    for (const comment of comments) {
      if (!isGarnetComment(comment, context)) continue;
      if (match) return null;
      match = comment;
    }
    if (comments.length < 100) return match;
  }
  return null;
}

export async function evidence(gh, context, base, call = mcp) {
  const { repo, head, run, attempt } = context;
  const comment = await appComment(gh, context);
  if (!comment) return null;
  const lines = comment.body.split(/\r?\n/);
  const commitMarkers = lines.filter(line => line.startsWith('<!-- garnet:commit '));
  if (commitMarkers.length !== 1 || commitMarkers[0] !== `<!-- garnet:commit ${head} -->`) return null;
  const markers = lines.filter(line => line.startsWith('<!-- garnet:summary '));
  const summary = markers.length === 1 && /^<!-- garnet:summary (\{.*\}) -->$/.exec(markers[0]);
  if (!summary) return null;
  let marker;
  try {
    marker = JSON.parse(summary[1]);
  } catch {
    return null;
  }
  const verdict = decide(marker, head, base);
  if (verdict === 'unknown') return null;

  const result = await gh(`actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`);
  if (!Array.isArray(result?.jobs) || result.total_count !== result.jobs.length) return null;
  const jobs = result.jobs.filter(job => job.name === captureJob);
  if (jobs.length !== 1 || jobs[0].conclusion !== 'success' ||
      (jobs[0].run_attempt !== undefined && jobs[0].run_attempt !== attempt) ||
      !Number.isSafeInteger(jobs[0].id) || jobs[0].id <= 0) return null;
  const jobPath = `/${repo}/actions/runs/${run}/job/${jobs[0].id}`;
  const profileIds = new Set();
  let linkedJob = false;
  for (const [, href] of comment.body.matchAll(/\bhref="([^"]+)"/g)) {
    let link;
    try {
      link = new URL(href.replaceAll('&amp;', '&'));
    } catch {
      continue;
    }
    if (link.origin === 'https://github.com' && link.pathname === jobPath) linkedJob = true;
    if (link.origin !== 'https://app.garnet.ai' || link.pathname !== `/public/runs/${run}`) continue;
    const ids = link.searchParams.getAll('profile');
    if (ids.length !== 1 || !profileID.test(ids[0])) return null;
    profileIds.add(ids[0]);
  }
  if (!linkedJob || profileIds.size !== 1) return null;
  const profile = await profileFor(context, [...profileIds][0], call);
  return profile ? { verdict, profile, url: comment.html_url } : null;
}

function selectors(repo, pr, head, run, attempt) {
  if (!repoName.test(repo) || !sha.test(head) ||
      ![pr, run, attempt].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid selectors');
  return { repo, pr, head, run, attempt };
}

function current(pull, context) {
  return pull.state === 'open' && pull.head?.sha === context.head &&
    pull.head.repo?.full_name === context.repo && supportedBases.has(pull.base?.ref) &&
    sha.test(pull.base.sha);
}

function sameBase(left, right) {
  return left?.ref === right?.ref && left?.sha === right?.sha;
}

function checkBase(pr, base) {
  return `${pr}:${base.ref}:${base.sha}`;
}

export async function invalidateRetargetedChecks(event, repo, gh) {
  const previous = event?.changes?.base?.ref?.from;
  const target = event?.pull_request?.base?.ref;
  if (event?.action !== 'edited' || !previous || previous === target || !supportedBases.has(target)) return;
  const { number: pr, head } = event.pull_request;
  if (!Number.isSafeInteger(pr) || pr <= 0 || !sha.test(head?.sha)) return;
  const pull = await gh(`pulls/${pr}`);
  if (!current(pull, { repo, head: head.sha }) || pull.base.ref !== target) return;
  const currentBase = checkBase(pr, pull.base);
  const commentPrefix = `[Garnet Runtime Review](https://github.com/${repo}/pull/${pr}#issuecomment-`;
  let invalidated = 0;
  for (let page = 1; ; page++) {
    const result = await gh(`commits/${head.sha}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=all&per_page=100&page=${page}`);
    if (!Array.isArray(result?.check_runs)) throw new Error('GitHub did not return check runs');
    for (const check of result.check_runs) {
      if (check.name !== checkName || check.app?.id !== actionsAppId || check.conclusion !== 'success' ||
          check.external_id === currentBase || !check.output?.summary?.startsWith(commentPrefix) ||
          !Number.isSafeInteger(check.id) || check.id <= 0) continue;
      await gh(`check-runs/${check.id}`, {
        status: 'completed', conclusion: 'action_required',
        output: { title: 'No usable runtime comparison', summary: 'The PR base changed. Waiting for a new capture and comparison.' }
      }, 'PATCH');
      invalidated++;
    }
    if (result.check_runs.length < 100) return invalidated;
  }
}

export async function publish(run, repo, gh, readEvidence = evidence, pause = wait) {
  if (run?.pull_requests?.length !== 1) throw new Error('Missing trusted run context');
  const context = selectors(repo, run.pull_requests[0].number, run.head_sha, run.id, run.run_attempt);
  const { pr, head } = context;
  if (!matchesRun(run, context)) throw new Error('Not a same-repository exhibit run');
  const getPR = () => gh(`pulls/${pr}`);
  const initial = await getPR();
  if (!current(initial, context)) return;
  const base = initial.base.sha;
  const check = await gh('check-runs', {
    name: checkName, head_sha: head, status: 'in_progress', external_id: checkBase(pr, initial.base),
    details_url: `https://github.com/${repo}/actions/runs/${run.id}`,
    output: { title: 'Waiting for Garnet evidence', summary: 'Only the current PR head is evaluated.' }
  });
  let result = null;
  if (run.conclusion === 'success') {
    const deadline = Date.now() + evidenceTimeoutMs;
    while (true) {
      const pull = await getPR();
      if (!current(pull, context) || !sameBase(pull.base, initial.base)) break;
      try {
        result = await readEvidence(gh, context, base);
      } catch {
        console.log('Garnet evidence not readable yet.');
      }
      const remaining = deadline - Date.now();
      if (result || remaining <= 0) break;
      await pause(Math.min(evidencePollMs, remaining));
    }
  }
  const latest = await getPR();
  const githubRun = await gh(`actions/runs/${run.id}`);
  const active = current(latest, context) && sameBase(latest.base, initial.base) && matchesRun(githubRun, context);
  const verdict = active ? (result?.verdict ?? 'unknown') : 'superseded';
  const args = [repo, pr, head, run.id, run.run_attempt].join(' ');
  const conclusion = ['nothing-new', 'background-only'].includes(verdict) ? 'success' :
    verdict === 'changed' ? 'failure' : 'action_required';
  const titles = {
    'nothing-new': 'No new runtime behavior recorded',
    'background-only': 'No new workload connections recorded',
    changed: 'Runtime behavior changed',
    'removals-only': 'Runtime destinations no longer seen'
  };
  const output = Object.hasOwn(titles, verdict)
    ? {
      title: titles[verdict],
      summary: [
        `[Garnet Runtime Review](${result.url}) · compared with \`${base}\` · capture is best-effort.`,
        `Head \`${head}\` · Linux run \`${run.id}\` attempt \`${run.run_attempt}\` · MCP profile \`${result.profile.id}\`.`,
        ...(verdict === 'background-only' ? ['Garnet reported changes to connections not tied to a workflow step.'] : []),
        ...(verdict === 'changed' ? [`Steward receipt lookup selectors: \`${args}\`.`] : []),
        ...(verdict === 'removals-only' ? ['The exhibit holds removal-only comparisons for a human; there is no Steward fix request.'] : [])
      ].join('\n\n')
    }
    : { title: 'No usable runtime comparison', summary: 'No passing gate was issued. Do not attempt a code fix from this check.' };
  await gh(`check-runs/${check.id}`, { status: 'completed', conclusion, output }, 'PATCH');
  return `${checkName}: ${verdict} on ${head}`;
}

function isWorkloadStep(step) {
  if (typeof step !== 'string') return false;
  const name = step.replace(/^\d+\.\s+/, '').trim();
  return !!name && !/^(?:<unknown>|Runner Processes|Set up job|Complete job|Post Run(?: .*)?)$/i.test(name);
}

export function workloadEgress(profile) {
  const peers = profile.data.network.egress.peers;
  const names = new Set();
  for (const peer of peers) {
    if (!Array.isArray(peer?.proc_trees) || !peer.proc_trees.some(proc => isWorkloadStep(proc?.github_step))) continue;
    const destinations = Array.isArray(peer.remote_names) && peer.remote_names.length
      ? peer.remote_names : [peer.remote_address];
    for (const name of destinations) {
      if (typeof name === 'string' && /^[a-zA-Z0-9.:[\]_-]{1,253}$/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

async function receipt(args) {
  const [repo, pr, head, run, attempt] = args;
  const context = selectors(repo, Number(pr), head, Number(run), Number(attempt));
  // Anthropic proxies the GitHub App credentials for gh, not Node's fetch.
  const gh = async path => {
    const { stdout } = await exec('gh', ['api', `repos/${repo}/${path}`], { timeout: 15_000 });
    return JSON.parse(stdout);
  };
  const pull = await gh(`pulls/${context.pr}`);
  const githubRun = await gh(`actions/runs/${context.run}`);
  if (!current(pull, context) || !matchesRun(githubRun, context)) throw new Error('Selectors do not match the current PR head and capture run');
  const result = await evidence(gh, context, pull.base.sha);
  const latest = await gh(`pulls/${context.pr}`);
  if (result?.verdict !== 'changed' || !current(latest, context) || !sameBase(latest.base, pull.base)) {
    throw new Error('No current changed receipt is available');
  }
  console.log(JSON.stringify({
    MCP: endpoint, tool: 'profiles', id: result.profile.id, ...context,
    job: captureJob, appComment: result.url, observedWorkloadDestinations: workloadEgress(result.profile)
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (['publish', 'invalidate-retarget'].includes(process.argv[2]) && process.argv.length === 3) {
      const { GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token, GITHUB_EVENT_PATH: event } = process.env;
      if (!token || !event) throw new Error('Missing trusted workflow context');
      const payload = JSON.parse(await readFile(event, 'utf8'));
      if (process.argv[2] === 'publish') {
        const status = await publish(payload.workflow_run, repo, github(repo, token));
        if (status) console.log(status);
      } else {
        const count = await invalidateRetargetedChecks(payload, repo, github(repo, token));
        if (count !== undefined) console.log(`Invalidated ${count} passing comparison(s) for the previous base.`);
      }
    } else if (process.argv[2] === 'receipt' && process.argv.length === 8) await receipt(process.argv.slice(3));
    else throw new Error('Use publish, invalidate-retarget, or receipt <owner/repo> <pr> <head> <run> <attempt>');
  } catch {
    console.error('Runtime Review stopped: selectors, evidence, or required GitHub access were not available.');
    process.exitCode = 1;
  }
}
