#!/usr/bin/env node
// Guarded GitHub App adapter for repos.chat.
// Planning and syncing are local/read-only. `open` requires an exact plan-id
// confirmation before it creates an app-authored commit and draft pull request.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const command = args[0] || 'status';
const option = name => {
  const index = args.indexOf(`--${name}`);
  return index > -1 ? args[index + 1] : null;
};
const root = path.resolve(option('root') || process.cwd());
const repoId = option('repo');
const API = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const PLAN_ROOT = path.join(root, '.repo-connect', 'github', 'plans');
const PR_ROOT = path.join(root, '.repo-connect', 'github', 'pull-requests');
const GIT_BIN = process.env.GIT_BIN || (process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe'].find(fs.existsSync) || 'git.exe'
  : 'git');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value);
}

function atomicJson(dest, value) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, dest);
}

function repoDir() {
  if (!safeId(repoId)) fail('command requires a safe --repo id');
  const direct = path.join(root, repoId);
  if (fs.existsSync(path.join(direct, 'repos.yaml'))) return direct;
  if (repoId === path.basename(root) && fs.existsSync(path.join(root, 'repos.yaml'))) return root;
  fail(`could not find ${repoId}/repos.yaml under the workspace root`);
}

function git(dir, gitArgs) {
  try {
    return execFileSync(GIT_BIN, ['-C', dir, ...gitArgs], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    fail(`git ${gitArgs[0]} failed: ${String(error.stderr || error.message).trim()}`);
  }
}

function parseRemote(value) {
  const https = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  const ssh = value.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/i);
  const match = https || ssh;
  if (!match) fail('origin must be a github.com HTTPS or SSH repository URL');
  return { owner: match[1], repo: match[2] };
}

function remoteFor(dir) {
  return parseRemote(git(dir, ['remote', 'get-url', 'origin']));
}

function configured() {
  return Boolean(
    process.env.REPOS_CHAT_GITHUB_APP_ID
    && process.env.REPOS_CHAT_GITHUB_INSTALLATION_ID
    && (process.env.REPOS_CHAT_GITHUB_PRIVATE_KEY || process.env.REPOS_CHAT_GITHUB_PRIVATE_KEY_FILE)
  );
}

function privateKey() {
  if (process.env.REPOS_CHAT_GITHUB_PRIVATE_KEY) return process.env.REPOS_CHAT_GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
  const file = process.env.REPOS_CHAT_GITHUB_PRIVATE_KEY_FILE;
  if (!file) fail('missing REPOS_CHAT_GITHUB_PRIVATE_KEY or REPOS_CHAT_GITHUB_PRIVATE_KEY_FILE');
  try { return fs.readFileSync(path.resolve(file), 'utf8'); }
  catch (error) { fail(`could not read GitHub App private key: ${error.message}`); }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function appJwt() {
  const appId = process.env.REPOS_CHAT_GITHUB_APP_ID;
  if (!appId) fail('missing REPOS_CHAT_GITHUB_APP_ID');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey()).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function github(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'repos.chat-github-app',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!response.ok) throw new Error(`GitHub ${method} ${pathname} returned ${response.status}: ${data?.message || 'request failed'}`);
  return data;
}

async function installationToken() {
  const installation = process.env.REPOS_CHAT_GITHUB_INSTALLATION_ID;
  if (!installation) fail('missing REPOS_CHAT_GITHUB_INSTALLATION_ID');
  const result = await github(`/app/installations/${encodeURIComponent(installation)}/access_tokens`, {
    method: 'POST',
    token: appJwt(),
    body: {
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    },
  });
  return result.token;
}

function readProposal(id) {
  if (!safeId(id)) fail('plan requires a safe --proposal id');
  const dest = path.join(root, '.repo-connect', 'proposals', `${id}.json`);
  try { return JSON.parse(fs.readFileSync(dest, 'utf8')); }
  catch { fail(`approved proposal not found: ${id}`); }
}

function normalizeFiles(dir, raw) {
  if (!raw) fail('plan requires a comma-separated --files list');
  const files = [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))];
  if (!files.length) fail('plan requires at least one file');
  return files.map(relative => {
    if (path.isAbsolute(relative) || relative.includes('\0')) fail(`unsafe file path: ${relative}`);
    const absolute = path.resolve(dir, relative);
    const inside = path.relative(dir, absolute);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || inside.split(path.sep).includes('.git')) {
      fail(`file must stay inside the represented repository: ${relative}`);
    }
    const realRoot = fs.realpathSync(dir);
    const normalized = inside.split(path.sep).join('/');
    const exists = fs.existsSync(absolute);
    if (exists && fs.statSync(absolute).isDirectory()) fail(`file is a directory: ${relative}`);
    if (exists && fs.lstatSync(absolute).isSymbolicLink()) fail(`symbolic links cannot be placed in a GitHub plan: ${relative}`);
    const resolvedTarget = exists
      ? fs.realpathSync(absolute)
      : path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    const realInside = path.relative(realRoot, resolvedTarget);
    if (realInside.startsWith('..') || path.isAbsolute(realInside)) fail(`file resolves outside the represented repository: ${relative}`);
    const status = git(dir, ['status', '--porcelain', '--', normalized]);
    if (!status) fail(`file has no uncommitted change: ${relative}`);
    const content = exists ? fs.readFileSync(absolute) : null;
    if (content && content.length > 900_000) fail(`file exceeds the guarded 900 KB limit: ${relative}`);
    return {
      path: normalized,
      operation: exists ? 'upsert' : 'delete',
      sha256: content ? crypto.createHash('sha256').update(content).digest('hex') : null,
    };
  });
}

function plan() {
  const dir = repoDir();
  const proposalId = option('proposal');
  const proposal = readProposal(proposalId);
  if (proposal.state !== 'approved' || !proposal.messageId) fail('proposal must be explicitly approved and delivered first');
  if (proposal.to !== repoId) fail(`proposal is addressed to ${proposal.to}, not ${repoId}`);
  if (proposal.recipe?.permission !== 'branch-pr') fail('exchange permission must be branch-pr');
  const files = normalizeFiles(dir, option('files'));
  const title = option('title') || proposal.subject;
  const tests = option('tests');
  if (!tests) fail('plan requires --tests with the completed validation evidence');
  const now = new Date().toISOString();
  const id = `${now.replace(/[-:.]/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
  const remote = remoteFor(dir);
  const result = {
    version: 1,
    protocol: 'repos.chat/github-pr-plan/1',
    id,
    state: 'planned',
    repo: repoId,
    remote,
    proposalId,
    title,
    body: option('body') || `${proposal.body}\n\n## Repo Rep evidence\n\n- Proposal: ${proposalId}\n- Exchange: ${proposal.exchange}\n- Tests: ${tests}\n- Human approval: ${proposal.approvedAt}`,
    base: option('base') || 'main',
    files,
    tests,
    createdAt: now,
  };
  atomicJson(path.join(PLAN_ROOT, `${id}.json`), result);
  console.log(JSON.stringify({ ok: true, externalChange: false, plan: result, next: `repos-github open --root <workspace> --id ${id} --approve ${id}` }, null, 2));
}

function readPlan(id) {
  if (!safeId(id)) fail('open requires a safe --id');
  try { return JSON.parse(fs.readFileSync(path.join(PLAN_ROOT, `${id}.json`), 'utf8')); }
  catch { fail(`plan not found: ${id}`); }
}

function additionsFor(planValue, dir) {
  const additions = [], deletions = [];
  const realRoot = fs.realpathSync(dir);
  for (const file of planValue.files) {
    const absolute = path.resolve(dir, file.path);
    const inside = path.relative(dir, absolute);
    if (inside.startsWith('..') || path.isAbsolute(inside)) fail(`planned file escaped repository: ${file.path}`);
    if (file.operation === 'delete') {
      if (fs.existsSync(absolute)) fail(`planned deletion now exists again: ${file.path}`);
      deletions.push({ path: file.path });
      continue;
    }
    if (fs.lstatSync(absolute).isSymbolicLink()) fail(`planned file became a symbolic link: ${file.path}`);
    const realInside = path.relative(realRoot, fs.realpathSync(absolute));
    if (realInside.startsWith('..') || path.isAbsolute(realInside)) fail(`planned file resolves outside repository: ${file.path}`);
    const content = fs.readFileSync(absolute);
    const actual = crypto.createHash('sha256').update(content).digest('hex');
    if (actual !== file.sha256) fail(`planned file changed after review: ${file.path}`);
    additions.push({ path: file.path, contents: content.toString('base64') });
  }
  return { additions, deletions };
}

async function open() {
  const id = option('id');
  if (option('approve') !== id) fail('open requires an exact --approve PLAN_ID confirmation');
  if (!configured()) fail('GitHub App credentials are not configured; no external change was made');
  const planValue = readPlan(id);
  if (planValue.state !== 'planned') fail(`plan is already ${planValue.state}`);
  if (repoId && repoId !== planValue.repo) fail(`plan belongs to ${planValue.repo}`);
  const effectiveRepo = planValue.repo;
  const direct = path.join(root, effectiveRepo);
  const dir = fs.existsSync(path.join(direct, 'repos.yaml')) ? direct : root;
  const currentRemote = remoteFor(dir);
  if (currentRemote.owner !== planValue.remote.owner || currentRemote.repo !== planValue.remote.repo) fail('origin changed after planning');
  const fileChanges = additionsFor(planValue, dir);
  const token = await installationToken();
  const owner = encodeURIComponent(planValue.remote.owner);
  const repository = encodeURIComponent(planValue.remote.repo);
  const baseRef = await github(`/repos/${owner}/${repository}/git/ref/heads/${encodeURIComponent(planValue.base)}`, { token });
  const branch = `repos-chat/${effectiveRepo}/${planValue.proposalId.slice(-12)}`.replace(/[^A-Za-z0-9._/-]/g, '-');
  await github(`/repos/${owner}/${repository}/git/refs`, {
    method: 'POST', token, body: { ref: `refs/heads/${branch}`, sha: baseRef.object.sha },
  });
  const mutation = `mutation CreateRepoRepCommit($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } } }`;
  const commitResult = await github('/graphql', {
    method: 'POST', token, body: {
      query: mutation,
      variables: { input: {
        branch: { repositoryNameWithOwner: `${planValue.remote.owner}/${planValue.remote.repo}`, branchName: branch },
        message: { headline: planValue.title, body: `Repo-Rep-Proposal: ${planValue.proposalId}` },
        fileChanges,
        expectedHeadOid: baseRef.object.sha,
      } },
    },
  });
  if (commitResult.errors?.length) throw new Error(commitResult.errors.map(error => error.message).join('; '));
  const pull = await github(`/repos/${owner}/${repository}/pulls`, {
    method: 'POST', token, body: {
      title: planValue.title,
      body: planValue.body,
      head: branch,
      base: planValue.base,
      draft: true,
      maintainer_can_modify: true,
    },
  });
  const record = {
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    state: pull.state,
    draft: pull.draft,
    branch,
    commit: commitResult.data.createCommitOnBranch.commit,
    proposalId: planValue.proposalId,
    openedAt: new Date().toISOString(),
  };
  const prFile = path.join(PR_ROOT, `${effectiveRepo}.json`);
  let existing = { repo: effectiveRepo, pullRequests: [] };
  try { existing = JSON.parse(fs.readFileSync(prFile, 'utf8')); } catch {}
  existing.pullRequests = [record, ...(existing.pullRequests || []).filter(item => item.number !== record.number)];
  atomicJson(prFile, existing);
  planValue.state = 'opened';
  planValue.openedAt = record.openedAt;
  planValue.pullRequest = record;
  atomicJson(path.join(PLAN_ROOT, `${id}.json`), planValue);
  console.log(JSON.stringify({ ok: true, externalChange: true, pullRequest: record }, null, 2));
}

async function sync() {
  if (!configured()) fail('GitHub App credentials are not configured; no network request was made');
  const dir = repoDir();
  const remote = remoteFor(dir);
  const token = await installationToken();
  const pulls = await github(`/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}/pulls?state=all&per_page=20`, { token });
  const value = {
    repo: repoId,
    syncedAt: new Date().toISOString(),
    pullRequests: pulls.map(pull => ({
      number: pull.number, title: pull.title, url: pull.html_url,
      state: pull.state, draft: pull.draft, branch: pull.head?.ref,
      openedAt: pull.created_at, updatedAt: pull.updated_at,
    })),
  };
  atomicJson(path.join(PR_ROOT, `${repoId}.json`), value);
  console.log(JSON.stringify({ ok: true, externalChange: false, ...value }, null, 2));
}

function status() {
  const result = {
    protocol: 'repos.chat/github-app/1',
    configured: configured(),
    appId: process.env.REPOS_CHAT_GITHUB_APP_ID ? 'present' : 'missing',
    installationId: process.env.REPOS_CHAT_GITHUB_INSTALLATION_ID ? 'present' : 'missing',
    privateKey: (process.env.REPOS_CHAT_GITHUB_PRIVATE_KEY || process.env.REPOS_CHAT_GITHUB_PRIVATE_KEY_FILE) ? 'present' : 'missing',
    requestedPermissions: { metadata: 'read', contents: 'write', pullRequests: 'write' },
    behavior: 'app-authored commits, draft pull requests, and no merge permission',
  };
  console.log(JSON.stringify(result, null, 2));
}

try {
  if (command === 'status') status();
  else if (command === 'plan') plan();
  else if (command === 'open') await open();
  else if (command === 'sync') await sync();
  else fail('commands: status | plan | open | sync');
} catch (error) {
  fail(error.message);
}
