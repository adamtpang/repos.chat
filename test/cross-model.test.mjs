import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractResult, HostError } from '../hosts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'repos.mjs');
const host = path.resolve(here, '..', 'agent-host.mjs');
const mcp = path.resolve(here, '..', 'mcp.mjs');
const fixture = name => path.resolve(here, '..', 'fixtures', name);

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-chat-xmodel-'));
  for (const [repo, kin] of [['alpha', 'beta'], ['beta', 'alpha']]) {
    const dir = path.join(root, repo);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'repos.yaml'),
      `repo: ${repo}\nis: Test repository ${repo}\nprovides:\n  - id: proof\n    what: test proof\n    at: proof.txt\nkin:\n  - repo: ${kin}\n    why: test relationship\n`);
    fs.writeFileSync(path.join(dir, 'proof.txt'), 'verified');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), `# ${repo} owner instructions\n`);
  }
  return root;
}

const run = (root, ...args) => execFileSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8' });
const json = (root, ...args) => JSON.parse(run(root, ...args));

const fakeHosts = {
  ...process.env,
  REPOS_HOST_CLAUDE_BIN: process.execPath,
  REPOS_HOST_CLAUDE_BIN_ARGS: JSON.stringify([fixture('fake-claude.mjs')]),
  REPOS_HOST_GROK_BIN: process.execPath,
  REPOS_HOST_GROK_BIN_ARGS: JSON.stringify([fixture('fake-grok.mjs')]),
};

function agent(root, repo, extra = [], env = fakeHosts) {
  return spawnSync(process.execPath, [host, 'run', '--root', root, '--repo', repo, ...extra], { encoding: 'utf8', env });
}

test('messages carry a thread, a state, and the preferred host', () => {
  const root = workspace();
  const request = json(root, 'send', '--from', 'alpha', '--to', 'beta', '--subject', 'Q', '--body', 'B', '--want-host', 'grok').message;
  assert.equal(request.version, 2);
  assert.equal(request.threadId, request.id);
  assert.equal(request.state, 'submitted');
  assert.equal(request.wantHost, 'grok');

  const reply = json(root, 'send', '--from', 'beta', '--to', 'alpha', '--kind', 'response', '--state', 'completed',
    '--host', 'claude', '--model', 'opus', '--subject', 'Re: Q', '--body', 'done', '--reply-to', request.id).message;
  assert.equal(reply.threadId, request.id, 'a reply joins its parent thread');
  assert.deepEqual(reply.host, { name: 'claude', model: 'opus' });

  const notice = json(root, 'send', '--from', 'alpha', '--to', 'beta', '--kind', 'notice', '--subject', 'FYI', '--body', 'x').message;
  assert.equal(notice.state, undefined, 'notices carry no task state');
});

test('send rejects unknown states and hosts', () => {
  const root = workspace();
  for (const [flag, value] of [['--state', 'done'], ['--want-host', 'gpt-9'], ['--host', 'nobody']]) {
    const result = spawnSync(process.execPath, [cli, 'send', '--root', root, '--from', 'alpha', '--to', 'beta',
      '--subject', 'S', '--body', 'B', flag, value], { encoding: 'utf8' });
    assert.equal(result.status, 1, `${flag} ${value} should be rejected`);
  }
});

test('thread reads one conversation across mailboxes, including version 1 messages', () => {
  const root = workspace();
  const first = json(root, 'send', '--from', 'alpha', '--to', 'beta', '--subject', 'Start', '--body', 'one').message;
  const second = json(root, 'send', '--from', 'beta', '--to', 'alpha', '--kind', 'response', '--subject', 'Re', '--body', 'two', '--reply-to', first.id).message;
  json(root, 'send', '--from', 'alpha', '--to', 'beta', '--subject', 'Unrelated', '--body', 'other');

  // A version 1 reply with no threadId still resolves through its replyTo chain.
  const legacy = { version: 1, id: '20990101T000000000Z-legacy01', from: 'alpha', to: 'beta', kind: 'request',
    subject: 'Legacy follow-up', body: 'three', createdAt: '2099-01-01T00:00:00.000Z', replyTo: second.id };
  fs.writeFileSync(path.join(root, '.repo-connect', 'mail', 'beta', `${legacy.id}.json`), JSON.stringify(legacy));

  const thread = json(root, 'thread', '--id', legacy.id, '--json');
  assert.equal(thread.threadId, first.id);
  assert.deepEqual(thread.messages.map(m => m.body), ['one', 'two', 'three']);
  assert.match(run(root, 'thread', '--id', first.id), /3 messages/);
});

test('graph prints pure JSON for machine readers', () => {
  const root = workspace();
  const graph = json(root, 'graph');
  assert.equal(graph.nodes.length, 2);
});

test('a Grok agent and a Claude agent hold one conversation through the mailbox', () => {
  const root = workspace();
  const ask = json(root, 'send', '--from', 'alpha', '--to', 'beta', '--subject', 'Which file?',
    '--body', 'Explain the change.', '--want-host', 'grok').message;

  // beta answers on Grok because the sender asked for it.
  const grokTurn = agent(root, 'beta');
  assert.equal(grokTurn.status, 0, grokTurn.stderr);
  const grokOut = JSON.parse(grokTurn.stdout);
  assert.equal(grokOut.host, 'grok');
  assert.equal(grokOut.result.outcome, 'blocked');
  const grokReply = json(root, 'inbox', '--repo', 'alpha', '--json').messages[0];
  assert.equal(grokReply.state, 'input-required', 'blocked maps to the A2A input-required state');
  assert.deepEqual(grokReply.host, { name: 'grok' });
  assert.equal(grokReply.threadId, ask.id);

  // alpha follows up in the same thread; the operator routes it to Claude, read-only.
  const followUp = json(root, 'send', '--from', 'alpha', '--to', 'beta', '--subject', 'Re: Which file?',
    '--body', 'proof.txt', '--reply-to', grokReply.id).message;
  assert.equal(followUp.threadId, ask.id);
  const dryRun = JSON.parse(agent(root, 'beta', ['--host', 'claude', '--read-only', '--dry-run']).stdout);
  assert.match(dryRun.prompt, /Earlier messages in this conversation/);
  assert.match(dryRun.prompt, /via grok/);
  assert.match(dryRun.prompt, /read-only turn/);

  const claudeTurn = agent(root, 'beta', ['--host', 'claude', '--read-only']);
  assert.equal(claudeTurn.status, 0, claudeTurn.stderr);
  const claudeReply = json(root, 'inbox', '--repo', 'alpha', '--json').messages.find(m => m.host?.name === 'claude');
  assert.equal(claudeReply.state, 'completed');
  assert.match(claudeReply.body, /read-only mode. Saw history: true/);

  const thread = json(root, 'thread', '--id', ask.id, '--json').messages;
  assert.deepEqual(thread.map(m => m.host?.name ?? m.from), ['alpha', 'grok', 'alpha', 'claude']);
});

test('a host that is not signed in leaves the request open with a login hint', () => {
  const root = workspace();
  const ask = json(root, 'send', '--from', 'alpha', '--to', 'beta', '--subject', 'S', '--body', 'B', '--want-host', 'claude').message;
  const failed = agent(root, 'beta', [], { ...fakeHosts, FAKE_CLAUDE_AUTH_ERROR: '1' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /OAuth session expired/);
  assert.match(failed.stderr, /sign in first: claude \/login/);
  const open = json(root, 'inbox', '--repo', 'beta', '--json').messages;
  assert.deepEqual(open.map(m => m.id), [ask.id], 'the request is still open for a retry on any host');
  assert.equal(fs.existsSync(path.join(root, '.repo-connect', 'claims', `${ask.id}.json`)), false);
});

test('extractResult accepts each CLI output shape and surfaces errors', () => {
  const result = { outcome: 'completed', summary: 's', evidence: [], tests: [], risks: [] };
  assert.deepEqual(extractResult('x', JSON.stringify(result)), result);
  assert.deepEqual(extractResult('x', JSON.stringify({ structured_output: result })), result);
  assert.deepEqual(extractResult('x', JSON.stringify({ result: JSON.stringify(result) })), result);
  assert.deepEqual(extractResult('x', `{"type":"progress"}\n${JSON.stringify({ result: JSON.stringify(result) })}\n`), result);
  assert.throws(() => extractResult('grok', '{"type":"error","message":"Not signed in. Run grok login"}'),
    err => err instanceof HostError && err.auth);
  assert.throws(() => extractResult('x', '{"result":"plain prose"}'), /no result matching/);
});

function mcpSession(root, as) {
  const child = spawn(process.execPath, [mcp, '--root', root, '--as', as], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const waiting = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) > -1) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let next = 1;
  const request = (method, params) => new Promise(resolve => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const { result } = await request('tools/call', { name, arguments: args });
    return { isError: result.isError, data: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
  };
  return { request, call, close: () => child.stdin.end(), notify: m => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: m })}\n`) };
}

test('the MCP server lets a live session message another repository agent', async () => {
  const root = workspace();
  const alpha = mcpSession(root, 'alpha');
  try {
    const init = await alpha.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.match(init.result.instructions, /You speak for repository alpha/);
    alpha.notify('notifications/initialized');

    const { result: list } = await alpha.request('tools/list', {});
    assert.deepEqual(list.tools.map(t => t.name).sort(),
      ['repos_ack', 'repos_graph', 'repos_inbox', 'repos_send', 'repos_thread', 'repos_whoami']);

    const me = await alpha.call('repos_whoami');
    assert.equal(me.data.repo, 'alpha');
    assert.equal(me.data.kin[0].repo, 'beta');

    const sent = await alpha.call('repos_send', { to: 'beta', subject: 'Multi-line', body: 'line one\n"quoted" line two', want_host: 'claude' });
    assert.equal(sent.data.from, 'alpha', 'the sender is the launch identity');
    assert.equal(sent.data.wantHost, 'claude');
    assert.equal(sent.data.body, 'line one\n"quoted" line two');

    const spoof = await alpha.call('repos_send', { to: 'beta', subject: 'S', body: 'B', from: 'beta' });
    assert.equal(spoof.isError, true, 'a from argument is refused, not honored');

    const missing = await alpha.call('repos_send', { to: 'nobody', subject: 'S', body: 'B' });
    assert.equal(missing.isError, true);
    assert.match(missing.data, /verified manifests/);

    const unknown = await alpha.request('tools/call', { name: 'repos_delete_everything', arguments: {} });
    assert.equal(unknown.error.code, -32602);
  } finally {
    alpha.close();
  }

  // beta's own session sees the message, replies, and both see one thread.
  const beta = mcpSession(root, 'beta');
  try {
    await beta.request('initialize', { protocolVersion: '2024-11-05' });
    const inbox = await beta.call('repos_inbox');
    assert.equal(inbox.data.messages.length, 1);
    const incoming = inbox.data.messages[0];
    const reply = await beta.call('repos_send', { to: 'alpha', kind: 'response', subject: 'Re: Multi-line', body: 'got it', reply_to: incoming.id });
    assert.equal(reply.data.threadId, incoming.id);
    const acked = await beta.call('repos_ack', { id: incoming.id });
    assert.ok(acked.data.acknowledgedAt);
    const thread = await beta.call('repos_thread', { id: reply.data.id });
    assert.deepEqual(thread.data.messages.map(m => m.from), ['alpha', 'beta']);
  } finally {
    beta.close();
  }
});

test('the MCP server refuses to start without an identity', () => {
  const result = spawnSync(process.execPath, [mcp, '--root', workspace()], { encoding: 'utf8', input: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--as REPO/);
});
