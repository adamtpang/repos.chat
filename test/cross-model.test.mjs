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

function exchange(id, withRepo, hostName) {
  return `  - id: ${id}\n    with: ${withRepo}\n    trigger: manual\n    asks: inspect proof\n    returns: evidence report\n    permission: read-only\n    approval: human-required\n    at: proof.txt\n${hostName ? `    host: ${hostName}\n` : ''}`;
}

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-chat-xmodel-'));
  const exchanges = {
    alpha: [exchange('ask-beta', 'beta'), exchange('ask-beta-grok', 'beta', 'grok'), exchange('ask-beta-claude', 'beta', 'claude')],
    beta: [exchange('ask-alpha', 'alpha')],
  };
  for (const [repo, kin] of [['alpha', 'beta'], ['beta', 'alpha']]) {
    const dir = path.join(root, repo);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'repos.yaml'),
      `repo: ${repo}\nis: Test repository ${repo}\nprovides:\n  - id: proof\n    what: test proof\n    at: proof.txt\nkin:\n  - repo: ${kin}\n    why: test relationship\nexchanges:\n${exchanges[repo].join('')}`);
    fs.writeFileSync(path.join(dir, 'proof.txt'), 'verified');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), `# ${repo} owner instructions\n`);
  }
  return root;
}

const run = (root, ...args) => execFileSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8' });
const json = (root, ...args) => JSON.parse(run(root, ...args));
const attempt = (root, ...args) => spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8' });

function propose(root, exchangeId, extra = []) {
  return json(root, 'trigger', '--from', 'alpha', '--exchange', exchangeId, '--event', 'manual',
    '--subject', `Ask via ${exchangeId}`, '--body', 'Explain proof.txt.', ...extra).proposal;
}

function approveProposal(root, proposal) {
  return json(root, 'approve', '--id', proposal.id, '--approve', `${proposal.id}:${proposal.payloadDigest.slice(0, 12)}`).message;
}

const fakeHosts = {
  ...process.env,
  REPOS_HOST_CLAUDE_BIN: process.execPath,
  REPOS_HOST_CLAUDE_BIN_ARGS: JSON.stringify([fixture('fake-claude.mjs')]),
  REPOS_HOST_GROK_BIN: process.execPath,
  REPOS_HOST_GROK_BIN_ARGS: JSON.stringify([fixture('fake-grok.mjs')]),
};

function agent(root, extra = [], env = fakeHosts) {
  return spawnSync(process.execPath, [host, 'run', '--root', root, '--repo', 'beta', ...extra], { encoding: 'utf8', env });
}

test('a recipe can pin the answering model without changing other recipe digests', () => {
  const root = workspace();
  const plain = propose(root, 'ask-beta');
  assert.equal('host' in plain.recipe, false, 'an unpinned recipe snapshot has no host key');
  const pinned = propose(root, 'ask-beta-grok');
  assert.equal(pinned.recipe.host, 'grok');
  assert.notEqual(plain.recipeDigest, pinned.recipeDigest);

  const request = approveProposal(root, pinned);
  assert.equal(request.authorization.host, 'grok', 'the approved host travels with the request');

  const yaml = path.join(root, 'alpha', 'repos.yaml');
  fs.writeFileSync(yaml, fs.readFileSync(yaml, 'utf8').replace('host: grok', 'host: gpt-9'));
  const refused = attempt(root, 'trigger', '--from', 'alpha', '--exchange', 'ask-beta-grok', '--event', 'manual', '--subject', 'S', '--body', 'B');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unsupported host: gpt-9/);
});

test('a Grok rep and a Claude rep hold one approved conversation', () => {
  const root = workspace();
  const first = approveProposal(root, propose(root, 'ask-beta-grok'));

  const grokTurn = agent(root);
  assert.equal(grokTurn.status, 0, grokTurn.stderr);
  const grokOut = JSON.parse(grokTurn.stdout);
  assert.equal(grokOut.host, 'grok', 'the recipe chose the model');
  assert.equal(grokOut.result.outcome, 'blocked');
  const grokReply = json(root, 'inbox', '--repo', 'alpha', '--json').messages.find(m => m.replyTo === first.id);
  assert.equal(grokReply.state, 'input-required', 'blocked maps to the A2A input-required state');
  assert.deepEqual(grokReply.host, { name: 'grok' });
  assert.equal(grokReply.conversationId, first.id);

  // alpha answers Grok's question with an approved follow-up, routed to Claude.
  const followUp = approveProposal(root, propose(root, 'ask-beta-claude', ['--reply-to', grokReply.id]));
  assert.equal(followUp.replyTo, grokReply.id);
  assert.equal(followUp.conversationId, first.id, 'the follow-up stays in the conversation');

  const dryRun = JSON.parse(agent(root, ['--dry-run']).stdout);
  assert.equal(dryRun.host, 'claude');
  assert.match(dryRun.prompt, /Earlier messages in this conversation/);
  assert.match(dryRun.prompt, /via grok/);

  const claudeTurn = agent(root);
  assert.equal(claudeTurn.status, 0, claudeTurn.stderr);
  const claudeReply = json(root, 'inbox', '--repo', 'alpha', '--json').messages.find(m => m.host?.name === 'claude');
  assert.equal(claudeReply.state, 'completed');
  assert.match(claudeReply.body, /read-only mode. Saw history: true/);

  const conversation = json(root, 'conversation', '--id', first.id, '--json');
  assert.deepEqual(conversation.messages.map(m => m.host?.name ?? m.from), ['alpha', 'grok', 'alpha', 'claude']);
  assert.match(run(root, 'conversation', '--id', claudeReply.id), /4 messages/);
});

test('a follow-up must continue a message the recipient sent to the requester', () => {
  const root = workspace();
  const request = approveProposal(root, propose(root, 'ask-beta'));
  const own = attempt(root, 'trigger', '--from', 'alpha', '--exchange', 'ask-beta', '--event', 'manual',
    '--subject', 'S', '--body', 'B', '--reply-to', request.id);
  assert.equal(own.status, 1, 'alpha cannot reply to its own outgoing request');
  assert.match(own.stderr, /must name a message beta sent to alpha/);
});

test('the operator --host overrides the recipe', () => {
  const root = workspace();
  approveProposal(root, propose(root, 'ask-beta-grok'));
  const out = agent(root, ['--host', 'claude']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).host, 'claude');
});

test('a host that is not signed in leaves the request open with a login hint', () => {
  const root = workspace();
  const request = approveProposal(root, propose(root, 'ask-beta-claude'));
  const failed = agent(root, [], { ...fakeHosts, FAKE_CLAUDE_AUTH_ERROR: '1' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /OAuth session expired/);
  assert.match(failed.stderr, /sign in first: claude \/login/);
  const open = json(root, 'inbox', '--repo', 'beta', '--json').messages;
  assert.deepEqual(open.map(m => m.id), [request.id], 'the request is still open for a retry on any host');
});

test('send keeps state for responses and refuses unknown hosts', () => {
  const root = workspace();
  for (const extra of [['--kind', 'notice', '--state', 'completed'], ['--kind', 'response', '--state', 'done'], ['--kind', 'notice', '--host', 'gpt-9']]) {
    const result = attempt(root, 'send', '--from', 'alpha', '--to', 'beta', '--subject', 'S', '--body', 'B', ...extra);
    assert.equal(result.status, 1, `${extra.join(' ')} should be refused`);
  }
  const ok = json(root, 'send', '--from', 'alpha', '--to', 'beta', '--kind', 'response', '--state', 'completed',
    '--host', 'claude', '--model', 'opus', '--subject', 'S', '--body', 'B').message;
  assert.equal(ok.state, 'completed');
  assert.deepEqual(ok.host, { name: 'claude', model: 'opus' });
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

test('the MCP server lets a live session propose work but never approve it', async () => {
  const root = workspace();
  const alpha = mcpSession(root, 'alpha');
  let proposalId;
  try {
    const init = await alpha.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.match(init.result.instructions, /You speak for repository alpha/);
    alpha.notify('notifications/initialized');

    const { result: list } = await alpha.request('tools/list', {});
    const names = list.tools.map(t => t.name).sort();
    assert.deepEqual(names, ['repos_ack', 'repos_conversation', 'repos_graph', 'repos_inbox', 'repos_proposals', 'repos_propose', 'repos_relay_send', 'repos_send', 'repos_sent', 'repos_whoami']);
    assert.equal(names.some(name => /approve/.test(name)), false, 'no tool can approve');

    const me = await alpha.call('repos_whoami');
    assert.equal(me.data.repo, 'alpha');
    assert.deepEqual(me.data.exchanges.map(e => e.id), ['ask-beta', 'ask-beta-grok', 'ask-beta-claude']);
    assert.equal(me.data.exchanges[1].host, 'grok');

    const proposed = await alpha.call('repos_propose', { exchange: 'ask-beta-grok', subject: 'Multi-line', body: 'line one\n"quoted" line two' });
    assert.equal(proposed.isError, false, proposed.data);
    assert.equal(proposed.data.delivered, false);
    assert.equal(proposed.data.proposal.body, 'line one\n"quoted" line two');
    assert.equal(proposed.data.proposal.payloadDigest, undefined, 'the approval digest is withheld');
    assert.doesNotMatch(JSON.stringify(proposed.data), /repos approve --id \S+ --approve/);
    proposalId = proposed.data.proposal.id;

    const pending = await alpha.call('repos_proposals');
    assert.deepEqual(pending.data.proposals.map(p => p.id), [proposalId]);
    assert.equal(pending.data.proposals[0].payloadDigest, undefined);

    const rawRequest = await alpha.call('repos_send', { to: 'beta', kind: 'request', subject: 'S', body: 'B' });
    assert.equal(rawRequest.isError, true, 'raw requests stay disabled');

    const spoof = await alpha.call('repos_send', { to: 'beta', subject: 'S', body: 'B', from: 'beta' });
    assert.equal(spoof.isError, true, 'a from argument is refused, not honored');

    const unknown = await alpha.request('tools/call', { name: 'repos_approve', arguments: {} });
    assert.equal(unknown.error.code, -32602);
  } finally {
    alpha.close();
  }

  // Nothing reached beta until a human approved it.
  assert.equal(json(root, 'inbox', '--repo', 'beta', '--json').messages.length, 0);
  const { proposals } = json(root, 'proposals', '--json');
  const delivered = approveProposal(root, proposals.find(p => p.id === proposalId));

  const beta = mcpSession(root, 'beta');
  try {
    await beta.request('initialize', { protocolVersion: '2024-11-05' });
    const inbox = await beta.call('repos_inbox');
    assert.deepEqual(inbox.data.messages.map(m => m.id), [delivered.id]);
    const reply = await beta.call('repos_send', { to: 'alpha', kind: 'response', subject: 'Re: Multi-line', body: 'got it', reply_to: delivered.id });
    assert.equal(reply.data.conversationId, delivered.conversationId);
    const acked = await beta.call('repos_ack', { id: delivered.id });
    assert.ok(acked.data.acknowledgedAt);
    const conversation = await beta.call('repos_conversation', { id: reply.data.id });
    assert.deepEqual(conversation.data.messages.map(m => m.from), ['alpha', 'beta']);
  } finally {
    beta.close();
  }
});

test('the MCP server refuses to start without an identity', () => {
  const result = spawnSync(process.execPath, [mcp, '--root', workspace()], { encoding: 'utf8', input: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--as REPO/);
});
