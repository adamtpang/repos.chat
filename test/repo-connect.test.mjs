import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'repos.mjs');
const host = path.resolve(here, '..', 'agent-host.mjs');
const dashboard = path.resolve(here, '..', 'dashboard.mjs');
const github = path.resolve(here, '..', 'github-app.mjs');
const publicRoot = path.resolve(here, '..', 'public');
const gitBin = process.env.GIT_BIN || (process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe'].find(fs.existsSync) || 'git.exe'
  : 'git');

function manifest(repo, kin) {
  return `repo: ${repo}\nis: Test repository ${repo}\nprovides:\n  - id: proof\n    what: test proof\n    at: proof.txt\nkin:\n  - repo: ${kin}\n    why: test relationship\nexchanges:\n  - id: ask-${kin}\n    with: ${kin}\n    trigger: manual\n    asks: inspect proof\n    returns: evidence report\n    permission: read-only\n    approval: human-required\n    at: proof.txt\n`;
}

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-chat-'));
  for (const [repo, kin] of [['alpha', 'beta'], ['beta', 'alpha']]) {
    const dir = path.join(root, repo);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'repos.yaml'), manifest(repo, kin));
    fs.writeFileSync(path.join(dir, 'proof.txt'), 'verified');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), `# ${repo} owner instructions\n`);
  }
  return root;
}

function run(root, ...args) {
  return execFileSync(process.execPath, [cli, ...args, '--root', root], {
    encoding: 'utf8',
  });
}

function proposalApproval(proposal) {
  return `${proposal.id}:${proposal.payloadDigest.slice(0, 12)}`;
}

function approvedRequest(root, subject = 'Approved test request', body = 'Return verified evidence.') {
  const triggered = JSON.parse(run(
    root,
    'trigger',
    '--from', 'alpha',
    '--exchange', 'ask-beta',
    '--event', 'manual',
    '--subject', subject,
    '--body', body,
  ));
  return JSON.parse(run(
    root,
    'approve',
    '--id', triggered.proposal.id,
    '--approve', proposalApproval(triggered.proposal),
  ));
}

function runGit(dir, ...args) {
  return execFileSync(gitBin, ['-C', dir, ...args], { encoding: 'utf8' });
}

function startDashboard(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dashboard, '--root', root, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`dashboard did not start: ${stderr}`));
    }, 5000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const lineEnd = stdout.indexOf('\n');
      if (lineEnd === -1) return;
      try {
        const status = JSON.parse(stdout.slice(0, lineEnd));
        clearTimeout(timeout);
        resolve({ child, port: Number(new URL(status.url).port) });
      } catch (error) {
        clearTimeout(timeout);
        child.kill();
        reject(error);
      }
    });
    child.once('exit', code => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`dashboard exited ${code}: ${stderr}`));
      }
    });
  });
}

function requestDashboard(port, pathname, { method = 'GET', hostHeader = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: { Host: hostHeader },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body,
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function stopDashboard(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

test('verifies evidence-backed manifests', () => {
  const root = workspace();
  const output = run(root, 'verify');
  assert.match(output, /2 claims confirmed by a real path, 0 unverifiable, 0 broken/);
});

test('rejects exchange recipes without real evidence', () => {
  const root = workspace();
  const file = path.join(root, 'alpha', 'repos.yaml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
    'approval: human-required\n    at: proof.txt',
    'approval: human-required\n    at: missing-contract.ts',
  ));
  const result = spawnSync(process.execPath, [cli, 'verify', '--root', root], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /exchange ask-beta: evidence missing-contract\.ts does not exist/);
});

test('rejects evidence paths that escape the represented repository', () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'outside.txt'), 'must not authorize an exchange');
  const file = path.join(root, 'alpha', 'repos.yaml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('at: proof.txt', 'at: ../outside.txt'));
  const result = spawnSync(process.execPath, [cli, 'verify', '--root', root], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /escapes the represented repository/);
});

test('reports whether a repository has an assigned Repo Rep', () => {
  const root = workspace();
  const result = JSON.parse(run(root, 'status', '--repo', 'beta', '--json'));
  assert.equal(result.repo, 'beta');
  assert.equal(result.assigned, true);
  assert.equal(result.manifest.valid, true);
  assert.equal(result.instructions.agents, true);
  assert.equal(result.connections, 1);
  assert.equal(result.role, 'repo-rep');
  assert.equal(result.presence.state, 'offline');
  assert.equal(result.presence.proactive, false);
});

test('prints command help without requiring a workspace', () => {
  const output = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(output, /repos status/);
  assert.match(output, /live watcher lease makes it proactive and observable/);
});

test('sends, reads, and acknowledges durable messages', () => {
  const root = workspace();
  const sent = JSON.parse(run(
    root,
    'send',
    '--from', 'alpha',
    '--to', 'beta',
    '--subject', 'Need evidence',
    '--body', 'Return the proof path.',
    '--kind', 'notice',
  ));

  assert.equal(sent.ok, true);
  assert.equal(sent.message.to, 'beta');
  assert.equal(sent.message.version, 3);
  assert.equal(sent.message.protocol, 'repos.chat/1');
  assert.equal(sent.message.conversationId, sent.message.id);

  const open = JSON.parse(run(root, 'inbox', '--repo', 'beta', '--json'));
  assert.equal(open.messages.length, 1);
  assert.equal(open.messages[0].subject, 'Need evidence');

  const acknowledged = JSON.parse(run(
    root,
    'ack',
    '--repo', 'beta',
    '--id', sent.message.id,
  ));
  assert.ok(acknowledged.message.acknowledgedAt);

  const after = JSON.parse(run(root, 'inbox', '--repo', 'beta', '--json'));
  assert.equal(after.messages.length, 0);

  const history = JSON.parse(run(root, 'inbox', '--repo', 'beta', '--json', '--all'));
  assert.equal(history.messages.length, 1);
});

test('emits manifest, kin, and inbox as agent context', () => {
  const root = workspace();
  run(
    root,
    'send',
    '--from', 'alpha',
    '--to', 'beta',
    '--subject', 'Context request',
    '--body', 'Use verified context.',
    '--kind', 'notice',
  );
  const context = JSON.parse(run(root, 'context', '--repo', 'beta'));
  assert.equal(context.protocol, 'repo-connect/agent-context/v1');
  assert.equal(context.repo.id, 'beta');
  assert.equal(context.kin[0].repo, 'alpha');
  assert.equal(context.inbox.length, 1);
});

test('rejects unknown repository ids', () => {
  const root = workspace();
  const result = spawnSync(process.execPath, [
    cli,
    'send',
    '--root', root,
    '--from', 'alpha',
    '--to', 'missing',
    '--subject', 'No route',
    '--body', 'This must fail.',
    '--kind', 'notice',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /verified manifests/);
});

test('turns a recipe trigger into a proposal and requires exact human approval', () => {
  const root = workspace();
  const triggered = JSON.parse(run(
    root,
    'trigger',
    '--from', 'alpha',
    '--exchange', 'ask-beta',
    '--event', 'manual',
    '--subject', 'Review the proof',
    '--body', 'Return the verified evidence path.',
  ));
  assert.equal(triggered.delivered, false);
  assert.equal(triggered.proposal.state, 'proposed');
  assert.match(triggered.next, new RegExp(`${triggered.proposal.id}:[a-f0-9]{12}`));
  assert.equal(JSON.parse(run(root, 'inbox', '--repo', 'beta', '--json')).messages.length, 0);

  const denied = spawnSync(process.execPath, [
    cli, 'approve', '--root', root,
    '--id', triggered.proposal.id,
    '--approve', 'wrong-id',
  ], { encoding: 'utf8' });
  assert.notEqual(denied.status, 0);
  assert.equal(JSON.parse(run(root, 'inbox', '--repo', 'beta', '--json')).messages.length, 0);

  const approved = JSON.parse(run(
    root,
    'approve',
    '--id', triggered.proposal.id,
    '--approve', proposalApproval(triggered.proposal),
  ));
  assert.equal(approved.proposal.state, 'approved');
  assert.equal(approved.message.authorization.proposalId, triggered.proposal.id);
  assert.equal(JSON.parse(run(root, 'inbox', '--repo', 'beta', '--json')).messages.length, 1);
});

test('rejects a changed proposal payload or exchange authority after review', () => {
  const root = workspace();
  const changedPayload = JSON.parse(run(
    root, 'trigger', '--from', 'alpha', '--exchange', 'ask-beta', '--event', 'manual',
    '--subject', 'Reviewed subject', '--body', 'Reviewed body.',
  ));
  const proposalFile = path.join(root, '.repo-connect', 'proposals', `${changedPayload.proposal.id}.json`);
  const proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8'));
  proposal.body = 'Changed after review.';
  fs.writeFileSync(proposalFile, `${JSON.stringify(proposal, null, 2)}\n`);
  const mutable = spawnSync(process.execPath, [
    cli, 'approve', '--root', root, '--id', proposal.id, '--approve', proposalApproval(changedPayload.proposal),
  ], { encoding: 'utf8' });
  assert.notEqual(mutable.status, 0);
  assert.match(mutable.stderr, /immutable payload check/);

  const stale = JSON.parse(run(
    root, 'trigger', '--from', 'alpha', '--exchange', 'ask-beta', '--event', 'manual',
    '--subject', 'Reviewed authority', '--body', 'Use the reviewed permission.',
  ));
  const manifestFile = path.join(root, 'alpha', 'repos.yaml');
  fs.writeFileSync(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace(
    'permission: read-only', 'permission: propose-change',
  ));
  const changedRecipe = spawnSync(process.execPath, [
    cli, 'approve', '--root', root, '--id', stale.proposal.id, '--approve', proposalApproval(stale.proposal),
  ], { encoding: 'utf8' });
  assert.notEqual(changedRecipe.status, 0);
  assert.match(changedRecipe.stderr, /exchange recipe changed/);
});

test('raw requests are disabled in favor of content-bound recipe approval', () => {
  const root = workspace();
  const result = spawnSync(process.execPath, [
    cli, 'send', '--root', root,
    '--from', 'alpha', '--to', 'beta',
    '--kind', 'request',
    '--subject', 'Unauthorized request', '--body', 'Must not be delivered.',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /raw requests are disabled/);
  assert.equal(JSON.parse(run(root, 'inbox', '--repo', 'beta', '--json')).messages.length, 0);
});

test('reports GitHub App readiness without exposing credential values', () => {
  const output = execFileSync(process.execPath, [github, 'status'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REPOS_CHAT_GITHUB_APP_ID: '12345',
      REPOS_CHAT_GITHUB_INSTALLATION_ID: '67890',
      REPOS_CHAT_GITHUB_PRIVATE_KEY: 'secret-private-key',
    },
  });
  const result = JSON.parse(output);
  assert.equal(result.configured, true);
  assert.equal(result.appId, 'present');
  assert.doesNotMatch(output, /12345|67890|secret-private-key/);
  assert.equal(result.requestedPermissions.pullRequests, 'write');
});

test('builds a bounded dry-run prompt for the recipient repository', () => {
  const root = workspace();
  const sent = approvedRequest(root, 'Implement the bounded change', 'Inspect the code and return evidence.');
  const output = execFileSync(process.execPath, [
    host,
    'run',
    '--root', root,
    '--repo', 'beta',
    '--dry-run',
  ], { encoding: 'utf8' });
  const dryRun = JSON.parse(output);
  assert.equal(dryRun.state, 'dry-run');
  assert.equal(dryRun.message.id, sent.message.id);
  assert.match(dryRun.prompt, /Work only inside/);
  assert.match(dryRun.prompt, /Do not send external messages/);
  assert.equal(fs.existsSync(path.join(root, '.repo-connect', 'locks', 'beta.json')), false);
});

test('runs a host, replies to the sender, and acknowledges the request', () => {
  const root = workspace();
  const sent = approvedRequest(root, 'Complete one bounded request', 'Use the repository evidence.');

  const fakeCodex = path.resolve(here, '..', 'fixtures', 'fake-codex.mjs');

  const output = execFileSync(process.execPath, [
    host,
    'run',
    '--root', root,
    '--repo', 'beta',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_BIN: process.execPath,
      CODEX_BIN_ARGS: JSON.stringify([fakeCodex]),
      EXPECT_SANDBOX: 'read-only',
    },
  });
  const completed = JSON.parse(output);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.requestId, sent.message.id);

  const recipient = JSON.parse(run(root, 'inbox', '--repo', 'beta', '--json'));
  assert.equal(recipient.messages.length, 0);

  const sender = JSON.parse(run(root, 'inbox', '--repo', 'alpha', '--json'));
  assert.equal(sender.messages.length, 1);
  assert.equal(sender.messages[0].kind, 'response');
  assert.equal(sender.messages[0].replyTo, sent.message.id);
  assert.equal(sender.messages[0].conversationId, sent.message.conversationId);

  const claim = JSON.parse(fs.readFileSync(
    path.join(root, '.repo-connect', 'claims', `${sent.message.id}.json`),
    'utf8',
  ));
  assert.equal(claim.outcome, 'completed');
  assert.ok(claim.completedAt);
  assert.equal(claim.responseId, completed.responseId);
  assert.equal(fs.existsSync(path.join(root, '.repo-connect', 'locks', 'beta.json')), false);
});

test('resumes after a durable response without invoking the model twice', () => {
  const root = workspace();
  const sent = approvedRequest(root, 'Recover response', 'Do not duplicate completed work.');
  const result = {
    outcome: 'completed', summary: 'Already completed.', evidence: ['proof.txt'], tests: ['passed'], risks: [],
  };
  const claimDir = path.join(root, '.repo-connect', 'claims');
  fs.mkdirSync(claimDir, { recursive: true });
  fs.writeFileSync(path.join(claimDir, `${sent.message.id}.json`), `${JSON.stringify({
    repo: 'beta', messageId: sent.message.id, host: 'codex',
    expectedResponseId: `${sent.message.id}-response`,
    resultDigest: crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    result, outcome: result.outcome, respondingAt: new Date().toISOString(),
  }, null, 2)}\n`);
  const output = execFileSync(process.execPath, [host, 'run', '--root', root, '--repo', 'beta'], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: 'definitely-not-a-real-model-binary' },
  });
  const resumed = JSON.parse(output);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.responseId, `${sent.message.id}-response`);
  assert.equal(JSON.parse(run(root, 'inbox', '--repo', 'beta', '--json')).messages.length, 0);
});

test('does not trust a pre-planted response without a resumable claim', () => {
  const root = workspace();
  const sent = approvedRequest(root, 'Reject planted response', 'Run only from a valid claim.');
  const responseDir = path.join(root, '.repo-connect', 'mail', 'alpha');
  fs.mkdirSync(responseDir, { recursive: true });
  fs.writeFileSync(path.join(responseDir, `${sent.message.id}-response.json`), `${JSON.stringify({
    version: 3, protocol: 'repos.chat/1', id: `${sent.message.id}-response`,
    conversationId: sent.message.conversationId, from: 'beta', to: 'alpha', kind: 'response',
    subject: 'Re: Reject planted response', body: JSON.stringify({
      outcome: 'completed', summary: 'Forged.', evidence: [], tests: [], risks: [],
    }),
    replyTo: sent.message.id, createdAt: new Date().toISOString(),
  }, null, 2)}\n`);
  const denied = spawnSync(process.execPath, [host, 'run', '--root', root, '--repo', 'beta'], {
    encoding: 'utf8', env: { ...process.env, CODEX_BIN: 'definitely-not-a-real-model-binary' },
  });
  assert.notEqual(denied.status, 0);
  assert.equal(JSON.parse(run(root, 'inbox', '--repo', 'beta', '--json')).messages.length, 1);
});

test('fails closed instead of launching a command wrapper through a shell', () => {
  const root = workspace();
  approvedRequest(root, 'Reject shell wrapper', 'Treat metacharacters as data only.');
  const denied = spawnSync(process.execPath, [
    host, 'run', '--root', root, '--repo', 'beta', '--model', 'safe&unexpected-command',
  ], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_BIN: 'unsafe-wrapper.cmd' },
  });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /cannot be a \.cmd or \.bat wrapper/);
});

test('a watcher wakes a repo rep and handles one request without manual run', () => {
  const root = workspace();
  const sent = approvedRequest(root, 'Wake automatically', 'Return verified evidence.');
  const fakeCodex = path.resolve(here, '..', 'fixtures', 'fake-codex.mjs');
  const output = execFileSync(process.execPath, [
    host,
    'watch',
    '--root', root,
    '--repo', 'beta',
    '--once',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_BIN: process.execPath,
      CODEX_BIN_ARGS: JSON.stringify([fakeCodex]),
      EXPECT_SANDBOX: 'read-only',
    },
  });
  const watched = JSON.parse(output);
  assert.equal(watched.watched, true);

  const sender = JSON.parse(run(root, 'inbox', '--repo', 'alpha', '--json'));
  assert.equal(sender.messages.length, 1);
  assert.equal(sender.messages[0].replyTo, sent.message.id);
  const status = JSON.parse(run(root, 'status', '--repo', 'beta', '--json'));
  assert.equal(status.presence.state, 'offline');
  assert.equal(status.presence.lastOutcome, 'completed');
});

test('a watcher immediately reclaims a lock whose process is dead', () => {
  const root = workspace();
  const watcherDir = path.join(root, '.repo-connect', 'watchers');
  const staleLock = path.join(watcherDir, 'beta.json');
  fs.mkdirSync(staleLock, { recursive: true });
  fs.writeFileSync(path.join(staleLock, 'owner.json'), `${JSON.stringify({
    repo: 'beta',
    pid: 2147483647,
    ownerToken: 'stale-test-owner',
    claimedAt: new Date(Date.now() - 2000).toISOString(),
    heartbeatAt: new Date(Date.now() - 2000).toISOString(),
  })}\n`);

  const output = execFileSync(process.execPath, [
    host,
    'watch',
    '--root', root,
    '--repo', 'beta',
    '--once',
  ], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).watched, true);
  assert.equal(fs.existsSync(staleLock), false);
});

test('a fresh lock cannot be stolen or deleted by a second watcher', () => {
  const root = workspace();
  const lock = path.join(root, '.repo-connect', 'watchers', 'beta.json');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify({
    repo: 'beta', pid: process.pid, ownerToken: 'current-owner',
    claimedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  })}\n`);
  const result = spawnSync(process.execPath, [
    host, 'watch', '--root', root, '--repo', 'beta', '--once',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already running/);
  assert.equal(fs.existsSync(path.join(lock, 'owner.json')), true);
});

test('ignores malformed mailbox identities and rejects unapproved envelopes', () => {
  const root = workspace();
  const inbox = path.join(root, '.repo-connect', 'mail', 'beta');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'mismatched.json'), `${JSON.stringify({
    version: 3, protocol: 'repos.chat/1', id: '..\\..\\outside', conversationId: 'bad',
    from: 'alpha', to: 'beta', kind: 'request', subject: 'Escape', body: 'No.', createdAt: new Date().toISOString(),
  })}\n`);
  const idle = JSON.parse(execFileSync(process.execPath, [host, 'run', '--root', root, '--repo', 'beta'], { encoding: 'utf8' }));
  assert.equal(idle.state, 'idle');
  assert.equal(fs.existsSync(path.join(root, 'outside.json')), false);

  fs.writeFileSync(path.join(inbox, 'unauthorized.json'), `${JSON.stringify({
    version: 3, protocol: 'repos.chat/1', id: 'unauthorized', conversationId: 'unauthorized',
    from: 'alpha', to: 'beta', kind: 'request', subject: 'No approval', body: 'No.', createdAt: new Date().toISOString(),
  })}\n`);
  const queue = path.join(root, '.repo-connect', 'queue', 'beta');
  fs.mkdirSync(queue, { recursive: true });
  fs.writeFileSync(path.join(queue, 'unauthorized.json'), '{"id":"unauthorized","to":"beta"}\n');
  const denied = spawnSync(process.execPath, [host, 'run', '--root', root, '--repo', 'beta'], { encoding: 'utf8' });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /not authorized by a current approved recipe/);
});

test('omits filesystem paths from inspector graph nodes', () => {
  const root = workspace();
  const sent = approvedRequest(root, 'Visible local envelope', 'This body is visible only in the localhost inspector.');
  const presenceDir = path.join(root, '.repo-connect', 'presence');
  fs.mkdirSync(presenceDir, { recursive: true });
  fs.writeFileSync(path.join(presenceDir, 'beta.json'), `${JSON.stringify({
    state: 'working',
    proactive: true,
    pid: process.pid,
    watcherPid: process.pid,
    heartbeatAt: new Date().toISOString(),
    leaseMs: 15000,
    messageId: sent.message.id,
  })}\n`);
  const output = execFileSync(process.execPath, [
    dashboard,
    '--root', root,
    '--snapshot',
  ], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.protocol, 'repos.chat/inspector/2');
  assert.equal(result.summary.repositories, 2);
  assert.equal(result.summary.assigned, 2);
  assert.equal(result.summary.working, 1);
  assert.equal(result.messages.length, 1);
  assert.equal('path' in result.nodes[0], false);
  const working = result.nodes.find(node => node.id === 'beta');
  assert.equal(working.activity.label, 'Questing');
  assert.equal(working.activity.detail, 'Visible local envelope');

  const focused = JSON.parse(execFileSync(process.execPath, [
    dashboard,
    '--root', root,
    '--snapshot',
    '--focus', 'alpha',
  ], { encoding: 'utf8' }));
  assert.deepEqual(focused.focus, ['alpha']);
  assert.equal(focused.summary.repositories, 1);
  assert.equal(focused.edges.length, 0);
  assert.equal(focused.messages.length, 0);
});

test('rejects invalid proposal triggers and repeated approval', () => {
  const root = workspace();
  const wrongEvent = spawnSync(process.execPath, [
    cli, 'trigger', '--root', root,
    '--from', 'alpha', '--exchange', 'ask-beta', '--event', 'ci',
    '--subject', 'Wrong event', '--body', 'Must remain local.',
  ], { encoding: 'utf8' });
  assert.notEqual(wrongEvent.status, 0);
  assert.match(wrongEvent.stderr, /accepts manual, not ci/);

  const missingSubject = spawnSync(process.execPath, [
    cli, 'trigger', '--root', root,
    '--from', 'alpha', '--exchange', 'ask-beta', '--event', 'manual',
    '--body', 'Missing a subject.',
  ], { encoding: 'utf8' });
  assert.notEqual(missingSubject.status, 0);
  assert.match(missingSubject.stderr, /requires --subject/);

  const triggered = JSON.parse(run(
    root,
    'trigger',
    '--from', 'alpha',
    '--exchange', 'ask-beta',
    '--event', 'manual',
    '--subject', 'Approve once',
    '--body', 'Deliver exactly once.',
  ));
  run(root, 'approve', '--id', triggered.proposal.id, '--approve', proposalApproval(triggered.proposal));
  const repeated = JSON.parse(run(
    root, 'approve', '--id', triggered.proposal.id,
    '--approve', proposalApproval(triggered.proposal),
  ));
  assert.equal(repeated.message.id, `${triggered.proposal.id}-request`);
  assert.equal(JSON.parse(run(root, 'inbox', '--repo', 'beta', '--json')).messages.length, 1);
});

test('rejects unsafe message metadata and unreadable body files', () => {
  const root = workspace();
  const cases = [
    {
      args: ['--subject', 'Bad reply', '--body', 'No.', '--kind', 'response', '--reply-to', 'bad/id'],
      message: /reply-to contains unsupported characters/,
    },
    {
      args: ['--subject', 'Bad conversation', '--body', 'No.', '--kind', 'notice', '--conversation-id', 'bad/id'],
      message: /conversation-id contains unsupported characters/,
    },
    {
      args: ['--subject', 'Missing body file', '--body-file', path.join(root, 'missing.txt'), '--kind', 'notice'],
      message: /could not read --body-file/,
    },
    {
      args: ['--subject', 'Bad kind', '--body', 'No.', '--kind', 'unsupported'],
      message: /kind must be one of/,
    },
  ];
  for (const item of cases) {
    const result = spawnSync(process.execPath, [
      cli, 'send', '--root', root, '--from', 'alpha', '--to', 'beta', ...item.args,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, item.message);
  }
  assert.equal(JSON.parse(run(root, 'inbox', '--repo', 'beta', '--json')).messages.length, 0);
});

test('distinguishes expired watchers, dead watchers, and dead workers', () => {
  const root = workspace();
  const presenceDir = path.join(root, '.repo-connect', 'presence');
  const presenceFile = path.join(presenceDir, 'beta.json');
  fs.mkdirSync(presenceDir, { recursive: true });

  fs.writeFileSync(presenceFile, `${JSON.stringify({
    state: 'idle', proactive: true, pid: process.pid, watcherPid: process.pid,
    heartbeatAt: '2000-01-01T00:00:00.000Z', leaseMs: 1,
  })}\n`);
  const expired = JSON.parse(run(root, 'status', '--repo', 'beta', '--json'));
  assert.equal(expired.presence.state, 'offline');
  assert.equal(expired.presence.proactive, false);
  assert.equal(expired.presence.proof, 'watcher lease expired');

  fs.writeFileSync(presenceFile, `${JSON.stringify({
    state: 'idle', proactive: true, pid: 2147483647, watcherPid: 2147483647,
    heartbeatAt: new Date().toISOString(), leaseMs: 15000,
  })}\n`);
  const deadWatcher = JSON.parse(run(root, 'status', '--repo', 'beta', '--json'));
  assert.equal(deadWatcher.presence.state, 'offline');
  assert.equal(deadWatcher.presence.proof, 'watcher process is not live');

  const leaseId = 'live-watcher-test-lease';
  const watcherLock = path.join(root, '.repo-connect', 'watchers', 'beta.json');
  fs.mkdirSync(watcherLock, { recursive: true });
  fs.writeFileSync(path.join(watcherLock, 'owner.json'), `${JSON.stringify({
    repo: 'beta', pid: process.pid, ownerToken: leaseId,
    claimedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  })}\n`);
  fs.writeFileSync(presenceFile, `${JSON.stringify({
    state: 'working', proactive: true, pid: 2147483647, watcherPid: process.pid,
    heartbeatAt: new Date().toISOString(), leaseMs: 15000, leaseId, messageId: 'request-1',
  })}\n`);
  const deadWorker = JSON.parse(run(root, 'status', '--repo', 'beta', '--json'));
  assert.equal(deadWorker.presence.state, 'blocked');
  assert.equal(deadWorker.presence.proactive, true);
  assert.equal(deadWorker.presence.messageId, 'request-1');
  assert.equal(deadWorker.presence.proof, 'worker process is not live');
});

test('serves the local dashboard and enforces its loopback HTTP boundary', async () => {
  const root = workspace();
  const { child, port } = await startDashboard(root);
  try {
    const page = await requestDashboard(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(page.body, /Repo Pet habitat/);

    const api = await requestDashboard(port, '/api/state?focus=alpha');
    assert.equal(api.status, 200);
    assert.deepEqual(JSON.parse(api.body).focus, ['alpha']);

    const forbidden = await requestDashboard(port, '/', { hostHeader: 'example.com' });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body, 'loopback host required');

    const wrongMethod = await requestDashboard(port, '/', { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, 'GET');

    const missing = await requestDashboard(port, '/missing');
    assert.equal(missing.status, 404);
  } finally {
    await stopDashboard(child);
  }
});

test('rejects invalid dashboard ports before listening', () => {
  const root = workspace();
  const invalid = spawnSync(process.execPath, [
    dashboard, '--root', root, '--port', '70000',
  ], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /integer from 0 to 65535/);
});

test('reports an unconfigured GitHub App without making a request', () => {
  const env = { ...process.env };
  delete env.REPOS_CHAT_GITHUB_APP_ID;
  delete env.REPOS_CHAT_GITHUB_INSTALLATION_ID;
  delete env.REPOS_CHAT_GITHUB_PRIVATE_KEY;
  delete env.REPOS_CHAT_GITHUB_PRIVATE_KEY_FILE;
  const result = JSON.parse(execFileSync(process.execPath, [github, 'status'], {
    encoding: 'utf8',
    env,
  }));
  assert.equal(result.configured, false);
  assert.equal(result.appId, 'missing');
  assert.equal(result.installationId, 'missing');
  assert.equal(result.privateKey, 'missing');
});

test('requires an approved branch-pr proposal before GitHub planning', () => {
  const proposedRoot = workspace();
  const proposed = JSON.parse(run(
    proposedRoot,
    'trigger',
    '--from', 'alpha',
    '--exchange', 'ask-beta',
    '--event', 'manual',
    '--subject', 'Still proposed',
    '--body', 'Do not plan yet.',
  ));
  const unapproved = spawnSync(process.execPath, [
    github, 'plan', '--root', proposedRoot, '--repo', 'beta',
    '--proposal', proposed.proposal.id, '--files', 'proof.txt', '--tests', 'node --test',
  ], { encoding: 'utf8' });
  assert.notEqual(unapproved.status, 0);
  assert.match(unapproved.stderr, /explicitly approved and delivered first/);

  run(proposedRoot, 'approve', '--id', proposed.proposal.id, '--approve', proposalApproval(proposed.proposal));
  const wrongPermission = spawnSync(process.execPath, [
    github, 'plan', '--root', proposedRoot, '--repo', 'beta',
    '--proposal', proposed.proposal.id, '--files', 'proof.txt', '--tests', 'node --test',
  ], { encoding: 'utf8' });
  assert.notEqual(wrongPermission.status, 0);
  assert.match(wrongPermission.stderr, /permission must be branch-pr/);
});

test('creates only hash-locked GitHub plans and rejects unsafe or unchanged files', () => {
  const root = workspace();
  const manifestFile = path.join(root, 'alpha', 'repos.yaml');
  fs.writeFileSync(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace(
    'permission: read-only',
    'permission: branch-pr',
  ));
  const triggered = JSON.parse(run(
    root,
    'trigger',
    '--from', 'alpha',
    '--exchange', 'ask-beta',
    '--event', 'manual',
    '--subject', 'Prepare a guarded plan',
    '--body', 'Return a reviewed proof update.',
  ));
  run(root, 'approve', '--id', triggered.proposal.id, '--approve', proposalApproval(triggered.proposal));

  const repoDir = path.join(root, 'beta');
  runGit(repoDir, 'init');
  runGit(repoDir, 'remote', 'add', 'origin', 'https://github.com/example/metrics-service.git');
  runGit(repoDir, 'add', '.');
  runGit(repoDir, '-c', 'user.name=Repo Chat Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'baseline');
  fs.writeFileSync(path.join(repoDir, 'proof.txt'), 'reviewed update');

  const traversal = spawnSync(process.execPath, [
    github, 'plan', '--root', root, '--repo', 'beta',
    '--proposal', triggered.proposal.id, '--files', '../outside.txt', '--tests', 'node --test',
  ], { encoding: 'utf8' });
  assert.notEqual(traversal.status, 0);
  assert.match(traversal.stderr, /file must stay inside the represented repository/);

  const unchanged = spawnSync(process.execPath, [
    github, 'plan', '--root', root, '--repo', 'beta',
    '--proposal', triggered.proposal.id, '--files', 'AGENTS.md', '--tests', 'node --test',
  ], { encoding: 'utf8' });
  assert.notEqual(unchanged.status, 0);
  assert.match(unchanged.stderr, /file has no uncommitted change/);

  const output = JSON.parse(execFileSync(process.execPath, [
    github, 'plan', '--root', root, '--repo', 'beta',
    '--proposal', triggered.proposal.id, '--files', 'proof.txt',
    '--tests', 'node --test: passing', '--title', 'Guarded proof update',
  ], { encoding: 'utf8' }));
  assert.equal(output.externalChange, false);
  assert.equal(output.plan.state, 'planned');
  assert.equal(output.plan.remote.owner, 'example');
  assert.equal(output.plan.remote.repo, 'metrics-service');
  assert.equal(output.plan.files[0].path, 'proof.txt');
  assert.equal(output.plan.files[0].operation, 'upsert');
  assert.match(output.plan.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(output.plan.digest, /^[a-f0-9]{64}$/);
  assert.match(output.next, new RegExp(`${output.plan.id}:[a-f0-9]{12}`));
  assert.equal(fs.existsSync(path.join(
    root, '.repo-connect', 'github', 'plans', `${output.plan.id}.json`,
  )), true);

  const planFile = path.join(root, '.repo-connect', 'github', 'plans', `${output.plan.id}.json`);
  const changedPlan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  changedPlan.title = 'Changed after review';
  fs.writeFileSync(planFile, `${JSON.stringify(changedPlan, null, 2)}\n`);
  const denied = spawnSync(process.execPath, [
    github, 'open', '--root', root, '--id', output.plan.id,
    '--approve', `${output.plan.id}:${output.plan.digest.slice(0, 12)}`,
  ], { encoding: 'utf8' });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /plan changed after review/);
});

test('keeps the public build free of private workspace records', () => {
  const files = fs.readdirSync(publicRoot).filter(name => fs.statSync(path.join(publicRoot, name)).isFile());
  assert.ok(files.includes('index.html'));
  assert.ok(files.includes('llms.txt'));
  assert.equal(files.some(name => /repos\.ya?ml|\.json$/i.test(name)), false);
  const output = files.map(name => fs.readFileSync(path.join(publicRoot, name), 'utf8')).join('\n');
  const localDenylist = String(process.env.REPOS_CHAT_PRIVATE_DENYLIST || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  for (const privateValue of [
    'private-repository.example',
    'PRIVATE_HOME_SENTINEL',
    '.repo-connect/mail',
    ...localDenylist,
  ]) {
    assert.doesNotMatch(output, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.match(fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8'), /research-agent/);
  assert.match(fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8'), /metrics-service/);
});
