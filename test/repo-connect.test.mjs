import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'repos.mjs');
const host = path.resolve(here, '..', 'agent-host.mjs');
const dashboard = path.resolve(here, '..', 'dashboard.mjs');
const github = path.resolve(here, '..', 'github-app.mjs');

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
    '--operator',
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
    '--operator',
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
    '--operator',
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
    '--approve', triggered.proposal.id,
  ));
  assert.equal(approved.proposal.state, 'approved');
  assert.equal(approved.message.authorization.proposalId, triggered.proposal.id);
  assert.equal(JSON.parse(run(root, 'inbox', '--repo', 'beta', '--json')).messages.length, 1);
});

test('raw requests require an explicit operator boundary', () => {
  const root = workspace();
  const result = spawnSync(process.execPath, [
    cli, 'send', '--root', root,
    '--from', 'alpha', '--to', 'beta',
    '--subject', 'Unauthorized request', '--body', 'Must not be delivered.',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /require --operator/);
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
  const sent = JSON.parse(run(
    root,
    'send',
    '--from', 'alpha',
    '--to', 'beta',
    '--subject', 'Implement the bounded change',
    '--body', 'Inspect the code, make the change, and test it.',
    '--operator',
  ));
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
  const sent = JSON.parse(run(
    root,
    'send',
    '--from', 'alpha',
    '--to', 'beta',
    '--subject', 'Complete one bounded request',
    '--body', 'Use the repository evidence.',
    '--operator',
  ));

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

test('a watcher wakes a repo rep and handles one request without manual run', () => {
  const root = workspace();
  const sent = JSON.parse(run(
    root,
    'send',
    '--from', 'alpha',
    '--to', 'beta',
    '--subject', 'Wake automatically',
    '--body', 'Return verified evidence.',
    '--operator',
  ));
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
  fs.mkdirSync(watcherDir, { recursive: true });
  fs.writeFileSync(path.join(watcherDir, 'beta.json'), `${JSON.stringify({
    repo: 'beta',
    pid: 2147483647,
    claimedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  })}\n`);

  const output = execFileSync(process.execPath, [
    host,
    'watch',
    '--root', root,
    '--repo', 'beta',
    '--once',
  ], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).watched, true);
  assert.equal(fs.existsSync(path.join(watcherDir, 'beta.json')), false);
});

test('omits filesystem paths from inspector graph nodes', () => {
  const root = workspace();
  const sent = JSON.parse(run(
    root,
    'send',
    '--from', 'alpha',
    '--to', 'beta',
    '--subject', 'Visible local envelope',
    '--body', 'This body is visible only in the localhost inspector.',
    '--operator',
  ));
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
