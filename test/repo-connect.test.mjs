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

function manifest(repo, kin) {
  return `repo: ${repo}\nis: Test repository ${repo}\nprovides:\n  - id: proof\n    what: test proof\n    at: proof.txt\nkin:\n  - repo: ${kin}\n    why: test relationship\n`;
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
  ));

  assert.equal(sent.ok, true);
  assert.equal(sent.message.to, 'beta');
  assert.equal(sent.message.version, 2);
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
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /verified manifests/);
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

test('omits filesystem paths from inspector graph nodes', () => {
  const root = workspace();
  run(
    root,
    'send',
    '--from', 'alpha',
    '--to', 'beta',
    '--subject', 'Visible local envelope',
    '--body', 'This body is visible only in the localhost inspector.',
  );
  const output = execFileSync(process.execPath, [
    dashboard,
    '--root', root,
    '--snapshot',
  ], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.protocol, 'repos.chat/inspector/1');
  assert.equal(result.summary.repositories, 2);
  assert.equal(result.summary.assigned, 2);
  assert.equal(result.messages.length, 1);
  assert.equal('path' in result.nodes[0], false);
});
