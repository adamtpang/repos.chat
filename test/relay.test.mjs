import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { win32 } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateIdentity, parseTarget, signEnvelope, signPayload } from '../identity.mjs';
import { createRelay, listenRelay } from '../relay.mjs';
import { formatHookCommand, relayInboxFile } from '../relay-local.mjs';
import { createStore } from '../relay-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'repos.mjs');
const hook = path.resolve(here, '..', 'inbox-hook.mjs');
const mcp = path.resolve(here, '..', 'mcp.mjs');
const packageRoot = path.resolve(here, '..');
const TOKEN = 'relay-test-token-1';

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function manifestWorkspace(name = 'aether') {
  const root = temp('repos-chat-relay-ws-');
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'repos.yaml'), `repo: ${name}\nis: A test repository\nkin: []\n`);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# test\n');
  return root;
}

function run(root, args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function jsonRun(root, args, env = {}) {
  const result = run(root, args, env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function listenLine(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`relay did not listen\n${out}\n${err}`));
    }, 8000);
    child.stdout.on('data', chunk => {
      out += chunk;
      const index = out.indexOf('\n');
      if (index >= 0) {
        clearTimeout(timer);
        try { resolve(JSON.parse(out.slice(0, index))); }
        catch (error) { reject(error); }
      }
    });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`relay exited ${code}\n${err}`));
    });
  });
}

function startRelay(data, { store = 'file', env = {} } = {}) {
  const child = spawn(process.execPath, [
    cli, 'relay', 'serve', '--data', data, '--port', '0', '--store', store, '--token', TOKEN,
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  return listenLine(child).then(info => ({ child, ...info }));
}

async function waitUntil(predicate, ms = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function webhookServer() {
  // A separate process: the test uses spawnSync, which would freeze an
  // in-process server and make the relay's wake POST wait out its timeout.
  const script = `
    import fs from 'node:fs';
    import http from 'node:http';
    const line = value => fs.writeSync(1, JSON.stringify(value) + '\\n');
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        line({ headers: req.headers, body: JSON.parse(raw) });
        res.writeHead(204);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => line({ port: server.address().port }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const hits = [];
  let buffer = '';
  let raw = '';
  let ready;
  const port = new Promise((resolve, reject) => {
    ready = resolve;
    child.on('exit', code => reject(new Error(`webhook exited ${code}`)));
  });
  child.stdout.on('data', chunk => {
    raw += chunk;
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const line = JSON.parse(text);
        if (line.port) ready(line.port);
        else hits.push(line);
      } catch (error) {
        hits.push({ parseError: error.message, text });
      }
    }
  });
  return port.then(bound => ({
    hits,
    raw: () => raw,
    url: `http://127.0.0.1:${bound}/wake`,
    close: () => {
      child.kill('SIGTERM');
      return Promise.resolve();
    },
  }));
}

function relayEnv(url, identityFile) {
  return { REPOS_RELAY_URL: url, REPOS_RELAY_TOKEN: TOKEN, REPOS_IDENTITY_FILE: identityFile };
}

test('targets are exactly one agent, session, or repo', () => {
  assert.deepEqual(parseTarget('agent:maans'), { kind: 'agent', id: 'maans' });
  assert.deepEqual(parseTarget('session:01'), { kind: 'session', id: '01' });
  assert.deepEqual(parseTarget('repo:aether'), { kind: 'repo', id: 'aether' });
  for (const bad of ['maans', 'agent:', 'agents:maans', 'agent:maans,agent:bubba', 'repo:a/b', 'agent:../x', 'agent:maans agent:bubba', '']) {
    assert.equal(parseTarget(bad), null, bad);
  }
});

test('windows paths for hook commands and relay mail stay inside the workspace', () => {
  const root = 'C:\\Users\\adamp\\Aether';
  const file = relayInboxFile(root, 'agent', 'maans', 'msg1', win32);
  assert.equal(file, 'C:\\Users\\adamp\\Aether\\.repo-connect\\relay\\inbox\\agent\\maans\\msg1.json');
  assert.throws(() => relayInboxFile(root, 'agent', '..\\Windows', 'msg1', win32));
  assert.throws(() => relayInboxFile(root, 'agent', 'maans', '..\\..\\secret', win32));
  assert.throws(() => relayInboxFile(root, 'repo', 'aether', 'not safe', win32));
  const command = formatHookCommand({
    hookPath: 'C:\\Users\\adamp\\Aether\\inbox-hook.mjs',
    root,
    repo: 'notes',
    event: 'UserPromptSubmit',
    host: 'claude',
    agent: 'bubba',
  });
  assert.equal(command, 'node "C:/Users/adamp/Aether/inbox-hook.mjs" --root "C:/Users/adamp/Aether" --repo notes --event UserPromptSubmit --host claude --agent bubba');
  assert.equal(command.includes('\\'), false);
});

test('identity keys are refused inside a repository and are not printed', () => {
  const workspace = temp('repos-chat-id-ws-');
  const outside = temp('repos-chat-id-home-');
  const inside = run(workspace, ['identity', 'init', '--agent', 'bubba', '--file', path.join(workspace, 'identity.json')]);
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /refusing to write a private key/);
  assert.equal(fs.existsSync(path.join(workspace, 'identity.json')), false);

  const inPackage = run(workspace, ['identity', 'init', '--agent', 'bubba', '--file', path.join(packageRoot, 'identity.json')]);
  assert.equal(inPackage.status, 1);
  assert.equal(fs.existsSync(path.join(packageRoot, 'identity.json')), false);

  const file = path.join(outside, 'identity.json');
  const created = jsonRun(workspace, ['identity', 'init', '--agent', 'bubba', '--file', file]);
  assert.equal(created.agentId, 'bubba');
  assert.equal(created.privateKey, undefined);
  assert.equal(created.stdout, undefined);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.agentId, 'bubba');
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  const shown = jsonRun(workspace, ['identity', 'show', '--file', file]);
  assert.equal(shown.publicKey, saved.publicKey);
  assert.equal(shown.privateKey, undefined);
  const again = run(workspace, ['identity', 'init', '--agent', 'bubba', '--file', file]);
  assert.equal(again.status, 1, 'an existing key file is not overwritten');
});

test('gitignore covers identity files and relay data', () => {
  const ignored = spawnSync('git', ['check-ignore', '-v', 'identity.json', '.repos-chat/identity.json', 'relay-data/store.json', 'keys/agent.pem'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.match(ignored.stdout, /identity\.json/);
  assert.match(ignored.stdout, /relay-data/);
  assert.match(ignored.stdout, /\*\.pem/);
});

test('a client_message_id is one local message, and a different body conflicts', () => {
  const root = manifestWorkspace('beta');
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha', 'repos.yaml'), 'repo: alpha\nis: sender\nkin: []\n');
  const args = ['send', '--from', 'alpha', '--to', 'beta', '--kind', 'notice', '--subject', 'Once', '--body', 'Same body', '--client-message-id', 'retry-1'];
  const first = jsonRun(root, args);
  const second = jsonRun(root, args);
  assert.equal(second.reused, true);
  assert.equal(second.message.id, first.message.id);
  const mail = fs.readdirSync(path.join(root, '.repo-connect', 'mail', 'beta')).filter(name => name.endsWith('.json'));
  assert.deepEqual(mail, ['retry-1.json']);
  const conflict = run(root, ['send', '--from', 'alpha', '--to', 'beta', '--kind', 'notice', '--subject', 'Once', '--body', 'Different body', '--client-message-id', 'retry-1']);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /different content/);
  assert.equal(fs.readdirSync(path.join(root, '.repo-connect', 'mail', 'beta')).filter(name => name.endsWith('.json')).length, 1);
});

test('the relay rejects a bad signature and a spoofed from', async () => {
  const store = await createStore('memory');
  const relay = createRelay({ store, token: TOKEN });
  const maans = generateIdentity('maans');
  const eve = generateIdentity('eve');
  const registration = identity => {
    const signedAt = new Date().toISOString();
    const unsigned = {
      protocol: 'repos.chat/register/1',
      agentId: identity.agentId,
      publicKey: identity.publicKey,
      repos: [],
      webhookUrl: null,
      signedAt,
    };
    return { ...unsigned, signature: signPayload(identity, unsigned) };
  };
  const as = bodyText => relay.handle({
    method: 'POST', url: '/v1/register', headers: { authorization: `Bearer ${TOKEN}` }, bodyText: JSON.stringify(bodyText),
  });
  assert.equal((await as(registration(maans))).status, 201);
  assert.equal((await as(registration(eve))).status, 201);

  const message = {
    version: 3, protocol: 'repos.chat/1', id: 'spoof-1', clientMessageId: 'spoof-1', conversationId: 'spoof-1',
    from: 'maans', to: 'eve', target: { kind: 'agent', id: 'eve' }, kind: 'notice', subject: 'Hi', body: 'hello',
    createdAt: new Date().toISOString(),
  };
  const honest = signEnvelope(eve, { clientMessageId: 'spoof-1', to: { kind: 'agent', id: 'maans' }, message: { ...message, from: 'eve', to: 'maans', target: { kind: 'agent', id: 'maans' } } });
  const tampered = { ...honest, message: { ...honest.message, subject: 'changed' } };
  const spoofedUnsigned = {
    protocol: 'repos.chat/relay/1',
    version: 1,
    clientMessageId: 'spoof-2',
    from: { kind: 'agent', id: 'maans' },
    to: { kind: 'agent', id: 'eve' },
    message: { ...message, id: 'spoof-2', clientMessageId: 'spoof-2' },
    signedAt: new Date().toISOString(),
    publicKey: eve.publicKey,
  };
  const spoofed = { ...spoofedUnsigned, signature: signPayload(eve, spoofedUnsigned) };
  const post = body => relay.handle({
    method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${TOKEN}` }, bodyText: JSON.stringify(body),
  });
  const badSig = await post(tampered);
  assert.equal(badSig.status, 403);
  assert.match(badSig.body.error, /invalid signature/);
  const spoof = await post(spoofed);
  assert.equal(spoof.status, 403);
  assert.match(spoof.body.error, /spoofed from/);
  const unauth = await relay.handle({ method: 'POST', url: '/v1/messages', headers: { authorization: 'Bearer nope-not-the-token' }, bodyText: '{}' });
  assert.equal(unauth.status, 401);
  const missing = await relay.handle({ method: 'GET', url: '/v1/health', headers: {}, bodyText: '' });
  assert.equal(missing.status, 200);
});

test('file, memory, and sqlite stores dedupe one client_message_id', async () => {
  const dir = temp('repos-chat-stores-');
  for (const kind of ['memory', 'file', 'sqlite']) {
    const store = await createStore(kind, { dir: path.join(dir, kind) });
    const agent = generateIdentity('maans');
    const other = generateIdentity('bubba');
    assert.equal(store.register({ agentId: 'maans', publicKey: agent.publicKey, repos: [], webhookUrl: null }).ok, true);
    assert.equal(store.register({ agentId: 'bubba', publicKey: other.publicKey, repos: [], webhookUrl: null }).ok, true);
    const envelope = signEnvelope(agent, {
      clientMessageId: 'same-id',
      to: { kind: 'agent', id: 'bubba' },
      message: {
        version: 3, protocol: 'repos.chat/1', id: 'same-id', clientMessageId: 'same-id', conversationId: 'same-id',
        from: 'maans', to: 'bubba', target: { kind: 'agent', id: 'bubba' }, kind: 'notice', subject: 'Once', body: 'hello',
        createdAt: '2026-11-03T00:00:00.000Z',
      },
    });
    const first = store.putMessage(envelope);
    const second = store.putMessage({ ...envelope, signedAt: new Date().toISOString(), signature: envelope.signature });
    // A changed signedAt with the original signature fails verification at the edge.
    // The store itself dedupes equal digests, including a resigned retry.
    const resigned = signEnvelope(agent, {
      clientMessageId: 'same-id',
      to: envelope.to,
      message: envelope.message,
      signedAt: '2026-11-03T00:05:00.000Z',
    });
    const retry = store.putMessage(resigned);
    assert.equal(first.ok, true);
    assert.equal(retry.reused, true);
    assert.equal(store.inbox('bubba', 0).messages.length, 1);
    const conflict = signEnvelope(agent, {
      clientMessageId: 'same-id',
      to: envelope.to,
      message: { ...envelope.message, body: 'nope' },
    });
    const rejected = store.putMessage(conflict);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 409);
    store.close();
    void second;
  }
});

test('two agents exchange a message and a reply through a local relay, and a webhook fires once', async () => {
  const data = temp('repos-chat-relay-data-');
  const maansHome = temp('repos-chat-maans-');
  const bubbaHome = temp('repos-chat-bubba-');
  const maansRoot = temp('repos-chat-maans-ws-');
  const bubbaRoot = manifestWorkspace('aether');
  const wakeLog = path.join(bubbaHome, 'wake.json');
  const claudeLog = path.join(bubbaHome, 'claude.json');
  const hook = await webhookServer();
  const relay = await startRelay(data, { env: { REPOS_RELAY_WEBHOOK_SECRET: 'wake-secret' } });
  const maansFile = path.join(maansHome, 'identity.json');
  const bubbaFile = path.join(bubbaHome, 'identity.json');
  try {
    jsonRun(maansRoot, ['identity', 'init', '--agent', 'maans', '--file', maansFile]);
    jsonRun(bubbaRoot, ['identity', 'init', '--agent', 'bubba', '--file', bubbaFile]);
    const maans = relayEnv(relay.url, maansFile);
    const bubba = relayEnv(relay.url, bubbaFile);
    assert.equal(run(maansRoot, ['relay', 'register', '--webhook', hook.url], maans).status, 0);
    assert.equal(run(bubbaRoot, ['relay', 'register', '--repo', 'aether'], bubba).status, 0);

    const offline = run(bubbaRoot, ['relay', 'send', '--to', 'agent:nobody', '--subject', 'x', '--body', 'y', '--client-message-id', 'offline-1'], {
      ...bubba, REPOS_RELAY_URL: 'http://127.0.0.1:1',
    });
    assert.equal(offline.status, 1);
    assert.equal(fs.readdirSync(path.join(bubbaRoot, '.repo-connect', 'relay', 'outbox')).length, 1);

    const sent = jsonRun(bubbaRoot, [
      'relay', 'send', '--to', 'agent:maans', '--subject', 'From bubba', '--body', 'Are you there?', '--client-message-id', 'hello-1',
    ], bubba);
    assert.equal(sent.ok, true);
    const retry = jsonRun(bubbaRoot, [
      'relay', 'send', '--to', 'agent:maans', '--subject', 'From bubba', '--body', 'Are you there?', '--client-message-id', 'hello-1',
    ], bubba);
    assert.equal(retry.ok, true);
    await waitUntil(() => hook.hits.length >= 1);
    assert.equal(hook.hits.length, 1, 'a retry must not wake twice');
    assert.equal(hook.hits[0].body.protocol, 'repos.chat/wake/1');
    const mac = crypto.createHmac('sha256', 'wake-secret').update(JSON.stringify(hook.hits[0].body)).digest('hex');
    assert.equal(hook.hits[0].headers['x-repos-signature'], `sha256=${mac}`);
    assert.equal(hook.hits[0].body.subject, 'From bubba');
    assert.equal(hook.hits[0].body.body, undefined);
    assert.equal(hook.hits[0].body.from.id, 'bubba');
    assert.equal(hook.hits[0].body.to.id, 'maans');

    const conflict = run(bubbaRoot, [
      'relay', 'send', '--to', 'agent:maans', '--subject', 'From bubba', '--body', 'Different', '--client-message-id', 'hello-1',
    ], bubba);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /different content/);

    const got = jsonRun(maansRoot, ['relay', 'sync'], maans);
    assert.equal(got.imported.length, 1);
    assert.equal(got.imported[0].fresh, true);
    const inbox = jsonRun(maansRoot, ['relay', 'inbox'], maans);
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].body, 'Are you there?');
    const again = jsonRun(maansRoot, ['relay', 'sync'], maans);
    assert.equal(again.imported.length, 0);

    const reply = jsonRun(maansRoot, [
      'relay', 'send', '--to', 'agent:bubba', '--kind', 'response', '--subject', 'Re: From bubba', '--body', 'Yes.',
      '--reply-to', 'hello-1', '--client-message-id', 'reply-1',
    ], maans);
    assert.equal(reply.ok, true);
    const bubbaMail = jsonRun(bubbaRoot, ['relay', 'sync'], bubba);
    assert.equal(bubbaMail.imported.filter(item => item.fresh).length, 1);
    const bubbaInbox = jsonRun(bubbaRoot, ['relay', 'inbox'], bubba);
    assert.equal(bubbaInbox.messages[0].replyTo, 'hello-1');
    assert.equal(bubbaInbox.messages[0].conversationId, 'hello-1');

    const repoSend = jsonRun(maansRoot, [
      'relay', 'send', '--to', 'repo:aether', '--subject', 'For the repo', '--body', 'Please look at this.', '--client-message-id', 'repo-1',
    ], maans);
    assert.equal(repoSend.ok, true);
    const pulled = jsonRun(bubbaRoot, ['relay', 'sync'], bubba);
    assert.ok(pulled.imported.some(item => item.clientMessageId === 'repo-1'));
    const local = JSON.parse(fs.readFileSync(path.join(bubbaRoot, '.repo-connect', 'mail', 'aether', 'repo-1.json'), 'utf8'));
    assert.equal(local.to, 'aether');
    assert.equal(local.origin.id, 'maans');
    const seen = spawnSync(process.execPath, [hookPath(), '--root', bubbaRoot, '--repo', 'aether', '--host', 'claude', '--event', 'UserPromptSubmit'], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'claude-on-bubba' }),
    });
    assert.equal(seen.status, 0, seen.stderr);
    assert.match(seen.stdout, /For the repo/);
    assert.match(seen.stdout, /untrusted/);
    const seenAgain = spawnSync(process.execPath, [hookPath(), '--root', bubbaRoot, '--repo', 'aether', '--host', 'grok', '--event', 'UserPromptSubmit'], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'claude-on-bubba' }),
    });
    assert.match(seenAgain.stdout, /For the repo/, 'a different host still has not seen it');
    assert.equal(spawnSync(process.execPath, [hookPath(), '--root', bubbaRoot, '--repo', 'aether', '--host', 'grok', '--event', 'UserPromptSubmit'], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'claude-on-bubba' }),
    }).stdout, '');

    fs.writeFileSync(path.join(bubbaHome, 'on-mail.mjs'), 'import fs from "node:fs"; fs.writeFileSync(process.env.WAKE_LOG, process.env.REPOS_MAIL_ID);\n');
    fs.writeFileSync(path.join(bubbaHome, 'fake-claude.mjs'), 'import fs from "node:fs"; fs.writeFileSync(process.env.CLAUDE_LOG, JSON.stringify(process.argv.slice(2)));\n');
    const watched = jsonRun(bubbaRoot, [
      'relay', 'watch', '--once', '--timeout-ms', '200', '--claude-print',
      '--on-mail', process.execPath, '--on-mail-arg', path.join(bubbaHome, 'on-mail.mjs'),
    ], {
      ...bubba,
      WAKE_LOG: wakeLog,
      CLAUDE_LOG: claudeLog,
      REPOS_CLAUDE_BIN: process.execPath,
      REPOS_CLAUDE_BIN_ARGS: JSON.stringify([path.join(bubbaHome, 'fake-claude.mjs')]),
    });
    assert.equal(watched.imported.length, 0, 'cursor already passed the repo message');
    // A new agent message arrives while watch is the pull path.
    jsonRun(maansRoot, ['relay', 'send', '--to', 'agent:bubba', '--subject', 'Wake up', '--body', 'New mail.', '--client-message-id', 'wake-1'], maans);
    const awakened = jsonRun(bubbaRoot, [
      'relay', 'watch', '--once', '--timeout-ms', '200', '--claude-print',
      '--on-mail', process.execPath, '--on-mail-arg', path.join(bubbaHome, 'on-mail.mjs'),
    ], {
      ...bubba,
      WAKE_LOG: wakeLog,
      CLAUDE_LOG: claudeLog,
      REPOS_CLAUDE_BIN: process.execPath,
      REPOS_CLAUDE_BIN_ARGS: JSON.stringify([path.join(bubbaHome, 'fake-claude.mjs')]),
    });
    assert.equal(awakened.imported.some(item => item.clientMessageId === 'wake-1'), true);
    assert.equal(fs.readFileSync(wakeLog, 'utf8'), 'wake-1');
    assert.match(fs.readFileSync(claudeLog, 'utf8'), /untrusted/);
    assert.match(fs.readFileSync(claudeLog, 'utf8'), /Wake up/);

    const acked = jsonRun(bubbaRoot, ['relay', 'ack', '--id', 'wake-1', '--by', 'claude', '--session', 'claude-on-bubba'], bubba);
    assert.equal(acked.message.acknowledgedBy.agent, 'bubba');
    assert.equal(acked.message.acknowledgedBy.host, 'claude');
    assert.equal(jsonRun(bubbaRoot, ['relay', 'inbox'], bubba).messages.some(message => message.id === 'wake-1'), false);
  } finally {
    relay.child.kill('SIGTERM');
    await hook.close();
  }
});

function hookPath() {
  return hook;
}

test('the relay refuses to listen off loopback without TLS', async () => {
  const store = await createStore('memory');
  const relay = createRelay({ store, token: TOKEN });
  assert.throws(() => listenRelay(relay, { host: '0.0.0.0', port: 0 }), /without TLS/);
});

test('long-poll watch returns mail that arrives after the cursor', async () => {
  const data = temp('repos-chat-watch-');
  const left = temp('repos-chat-watch-a-');
  const right = temp('repos-chat-watch-b-');
  const relay = await startRelay(data, { store: 'memory' });
  const homes = temp('repos-chat-watch-ids-');
  const aFile = path.join(homes, 'a.json');
  const bFile = path.join(homes, 'b.json');
  try {
    jsonRun(left, ['identity', 'init', '--agent', 'left', '--file', aFile]);
    jsonRun(right, ['identity', 'init', '--agent', 'right', '--file', bFile]);
    const a = relayEnv(relay.url, aFile);
    const b = relayEnv(relay.url, bFile);
    assert.equal(run(left, ['relay', 'register'], a).status, 0);
    assert.equal(run(right, ['relay', 'register'], b).status, 0);
    jsonRun(left, ['relay', 'sync'], a);
    const watching = spawn(process.execPath, [cli, 'relay', 'watch', '--once', '--timeout-ms', '4000', '--root', left], {
      env: { ...process.env, ...a },
    });
    let out = '';
    watching.stdout.on('data', chunk => { out += chunk; });
    await new Promise(resolve => setTimeout(resolve, 400));
    jsonRun(right, ['relay', 'send', '--to', 'agent:left', '--subject', 'Ping', '--body', 'while you waited', '--client-message-id', 'ping-1'], b);
    const code = await new Promise(resolve => watching.on('exit', resolve));
    assert.equal(code, 0, out);
    const result = JSON.parse(out);
    assert.equal(result.imported[0].clientMessageId, 'ping-1');
  } finally {
    relay.child.kill('SIGTERM');
  }
});

test('session mail is delivered to the claiming agent only', async () => {
  const data = temp('repos-chat-session-');
  const home = temp('repos-chat-session-home-');
  const otherHome = temp('repos-chat-session-other-');
  const root = temp('repos-chat-session-ws-');
  const otherRoot = temp('repos-chat-session-ws2-');
  const relay = await startRelay(data);
  const file = path.join(home, 'id.json');
  const otherFile = path.join(otherHome, 'id.json');
  try {
    jsonRun(root, ['identity', 'init', '--agent', 'owner', '--file', file]);
    jsonRun(otherRoot, ['identity', 'init', '--agent', 'other', '--file', otherFile]);
    const owner = relayEnv(relay.url, file);
    const other = relayEnv(relay.url, otherFile);
    assert.equal(run(root, ['relay', 'register'], owner).status, 0);
    assert.equal(run(otherRoot, ['relay', 'register'], other).status, 0);
    jsonRun(root, ['relay', 'sync', '--session', 'live-1'], owner);
    jsonRun(otherRoot, ['relay', 'send', '--to', 'session:live-1', '--subject', 'In session', '--body', 'for you', '--client-message-id', 'sess-1'], other);
    const pulled = jsonRun(root, ['relay', 'sync', '--session', 'live-1'], owner);
    assert.equal(pulled.imported[0].clientMessageId, 'sess-1');
    const missed = jsonRun(otherRoot, ['relay', 'sync'], other);
    assert.equal(missed.imported.length, 0);
    const second = run(otherRoot, ['relay', 'sync', '--session', 'live-1'], other);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already claimed/);
  } finally {
    relay.child.kill('SIGTERM');
  }
});

test('MCP inbox records who saw and acked, and can send through the relay', async () => {
  const root = manifestWorkspace('beta');
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha', 'repos.yaml'), 'repo: alpha\nis: sender\nkin: []\n');
  fs.writeFileSync(path.join(root, 'alpha', 'AGENTS.md'), '# a\n');
  fs.writeFileSync(path.join(root, 'beta', 'AGENTS.md'), '# b\n');
  const sent = jsonRun(root, ['send', '--from', 'alpha', '--to', 'beta', '--kind', 'notice', '--subject', 'See me', '--body', 'body']);
  const child = spawn(process.execPath, [mcp, '--root', root, '--as', 'beta', '--host', 'claude', '--session', 'live-session'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const waiting = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let next = 1;
  const call = (name, args = {}) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => reject(new Error(`timeout ${name}`)), 8000);
    waiting.set(id, message => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
  try {
    const inbox = await call('repos_inbox');
    const body = JSON.parse(inbox.result.content[0].text);
    assert.equal(body.messages.length, 1);
    const receipt = path.join(root, '.repo-connect', 'receipts', 'beta', sent.message.id, 'claude-live-session.json');
    assert.equal(fs.existsSync(receipt), true);
    const sentView = jsonRun(root, ['sent', '--repo', 'alpha', '--json']);
    assert.equal(sentView.messages[0].delivery.status, 'seen');
    const acked = await call('repos_ack', { id: sent.message.id });
    const ackedBody = JSON.parse(acked.result.content[0].text);
    assert.equal(ackedBody.acknowledgedBy.host, 'claude');
    assert.equal(ackedBody.acknowledgedBy.session, 'live-session');
    assert.equal(ackedBody.acknowledgedBy.repo, 'beta');
    const again = jsonRun(root, ['ack', '--repo', 'beta', '--id', sent.message.id, '--by', 'grok', '--session', 'other']);
    assert.equal(again.message.acknowledgedBy.host, 'claude', 'the first acknowledgement records who');
  } finally {
    child.stdin.end();
  }

  const data = temp('repos-chat-mcp-relay-');
  const home = temp('repos-chat-mcp-id-');
  const maansRoot = temp('repos-chat-mcp-maans-');
  const relay = await startRelay(data);
  const file = path.join(home, 'id.json');
  try {
    jsonRun(root, ['identity', 'init', '--agent', 'bubba', '--file', file]);
    const env = relayEnv(relay.url, file);
    assert.equal(run(root, ['relay', 'register', '--repo', 'beta'], env).status, 0);
    const maansFile = path.join(home, 'maans.json');
    jsonRun(maansRoot, ['identity', 'init', '--agent', 'maans', '--file', maansFile]);
    assert.equal(run(maansRoot, ['relay', 'register'], relayEnv(relay.url, maansFile)).status, 0);
    const sender = spawn(process.execPath, [mcp, '--root', root, '--as', 'beta', '--host', 'claude', '--session', 'live-session'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let buf = '';
    const waiters = new Map();
    sender.stdout.on('data', chunk => {
      buf += chunk;
      let index;
      while ((index = buf.indexOf('\n')) >= 0) {
        const message = JSON.parse(buf.slice(0, index));
        buf = buf.slice(index + 1);
        waiters.get(message.id)?.(message);
      }
    });
    let id = 1;
    const tool = (name, args) => new Promise((resolve, reject) => {
      const current = id++;
      const timer = setTimeout(() => reject(new Error(`timeout ${name}\n${buf}`)), 8000);
      waiters.set(current, message => { clearTimeout(timer); resolve(message); });
      sender.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method: 'tools/call', params: { name, arguments: args } })}\n`);
    });
    try {
      const listed = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('list timeout')), 5000);
        waiters.set(1, message => { clearTimeout(timer); resolve(message); });
        sender.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
        id = 2;
      });
      const names = listed.result.tools.map(tool => tool.name);
      assert.ok(names.includes('repos_relay_send'));
      const sentRemote = await tool('repos_relay_send', {
        to: 'agent:maans', subject: 'Via MCP', body: 'from the session', client_message_id: 'mcp-1',
      });
      assert.equal(sentRemote.result.isError, false, sentRemote.result.content[0].text);
      const remote = jsonRun(maansRoot, ['relay', 'sync'], relayEnv(relay.url, maansFile));
      assert.equal(remote.imported[0].clientMessageId, 'mcp-1');
      const duplicated = await tool('repos_relay_send', {
        to: 'agent:maans', subject: 'Via MCP', body: 'from the session', client_message_id: 'mcp-1',
      });
      assert.equal(duplicated.result.isError, false);
      const stillOne = jsonRun(maansRoot, ['relay', 'sync'], relayEnv(relay.url, maansFile));
      assert.equal(stillOne.imported.length, 0);
    } finally {
      sender.stdin.end();
    }
  } finally {
    relay.child.kill('SIGTERM');
  }
});
