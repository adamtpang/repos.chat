// Pluggable relay storage.
//
// file: a directory of JSON records. This is the zero-dependency default and
// survives process restarts on a normal disk.
// memory: process-local, used by tests and by an explicitly ephemeral server.
// sqlite: node:sqlite when this Node build provides it (Node 22.5+). No npm
// package is required. On a serverless host the file still disappears with
// the instance unless the operator mounts a persistent disk.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AGENT_ID, envelopeDigest } from './identity.mjs';

function notifyBase() {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  return {
    events,
    wait(timeoutMs) {
      let settled = false;
      let resolveWait;
      const promise = new Promise(resolve => { resolveWait = resolve; });
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        events.off('mail', onMail);
        resolveWait(value);
      };
      const onMail = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      events.on('mail', onMail);
      promise.cancel = () => finish(false);
      return promise;
    },
    notify() { events.emit('mail'); },
  };
}

function sameDigest(record, envelope) {
  return record.digest === envelopeDigest(envelope);
}

export class MemoryStore {
  constructor() {
    this.agents = new Map();
    this.repos = new Map();
    this.sessions = new Map();
    this.messages = [];
    this.byClient = new Map();
    this.seq = 0;
    Object.assign(this, notifyBase());
  }

  identify(agentId, publicKey) {
    const agent = this.agents.get(agentId);
    if (!agent) return { ok: false, status: 403, error: `agent ${agentId} is not registered` };
    if (agent.publicKey !== publicKey) {
      return { ok: false, status: 403, error: `spoofed from: signature key is not the registered key for ${agentId}` };
    }
    return { ok: true, agent };
  }

  register(agent) { return registerAgent(this, agent); }
  claimSession(agentId, sessionId) { return claimSession(this, agentId, sessionId); }
  putMessage(envelope) { return putMessage(this, envelope); }
  inbox(agentId, cursor) { return inboxFor(this, agentId, cursor); }
  close() {}
}

function agentRecord(agent) {
  return {
    agentId: agent.agentId,
    publicKey: agent.publicKey,
    repos: [...agent.repos],
    webhookUrl: agent.webhookUrl || null,
    registeredAt: agent.registeredAt || new Date().toISOString(),
  };
}

function registerAgent(store, agent) {
  const existing = store.agents.get(agent.agentId);
  if (existing && existing.publicKey !== agent.publicKey) {
    return { ok: false, status: 403, error: `spoofed from: ${agent.agentId} is already registered to a different key` };
  }
  for (const repo of agent.repos) {
    const owner = store.repos.get(repo);
    if (owner && owner !== agent.agentId) {
      return { ok: false, status: 409, error: `repo ${repo} is already claimed by ${owner}` };
    }
  }
  if (existing) {
    for (const repo of existing.repos) {
      if (!agent.repos.includes(repo) && store.repos.get(repo) === agent.agentId) store.repos.delete(repo);
    }
  }
  store.agents.set(agent.agentId, agentRecord(agent));
  for (const repo of agent.repos) store.repos.set(repo, agent.agentId);
  return { ok: true, agent: store.agents.get(agent.agentId), created: !existing };
}

function claimSession(store, agentId, sessionId) {
  const agent = store.agents.get(agentId);
  if (!agent) return { ok: false, status: 403, error: `agent ${agentId} is not registered` };
  const owner = store.sessions.get(sessionId);
  if (owner && owner !== agentId) return { ok: false, status: 409, error: `session ${sessionId} is already claimed by ${owner}` };
  store.sessions.set(sessionId, agentId);
  return { ok: true, sessionId, agentId };
}

function visible(store, agentId, message) {
  if (message.to.kind === 'agent') return message.to.id === agentId;
  if (message.to.kind === 'repo') return store.repos.get(message.to.id) === agentId;
  if (message.to.kind === 'session') return store.sessions.get(message.to.id) === agentId;
  return false;
}

function resolveRecipient(store, target) {
  if (target.kind === 'agent') return store.agents.get(target.id) || null;
  if (target.kind === 'repo') {
    const owner = store.repos.get(target.id);
    return owner ? store.agents.get(owner) : null;
  }
  if (target.kind === 'session') {
    const owner = store.sessions.get(target.id);
    return owner ? store.agents.get(owner) : null;
  }
  return null;
}

function innerFromAllowed(agent, message) {
  const from = message?.from;
  if (typeof from !== 'string' || !AGENT_ID.test(from)) return false;
  return from === agent.agentId || agent.repos.includes(from);
}

function targetsMatch(envelope) {
  const to = envelope.to;
  const message = envelope.message || {};
  if (message.to !== to.id) return false;
  if (message.target && (message.target.kind !== to.kind || message.target.id !== to.id)) return false;
  return true;
}

function putMessage(store, envelope) {
  const agent = store.agents.get(envelope.from.id);
  if (!agent) return { ok: false, status: 403, error: `agent ${envelope.from.id} is not registered` };
  if (agent.publicKey !== envelope.publicKey || envelope.from.id !== agent.agentId) {
    return { ok: false, status: 403, error: `spoofed from: signature key is not the registered key for ${envelope.from.id}` };
  }
  if (!innerFromAllowed(agent, envelope.message)) {
    return { ok: false, status: 403, error: `spoofed from: ${envelope.from.id} has not claimed ${envelope.message?.from}` };
  }
  if (!targetsMatch(envelope)) return { ok: false, status: 400, error: 'message recipient does not match the envelope target' };
  const clientKey = `${envelope.from.id}/${envelope.clientMessageId}`;
  const prior = store.byClient.get(clientKey);
  if (prior) {
    if (!sameDigest(prior, envelope)) {
      return { ok: false, status: 409, error: `client_message_id already exists with different content: ${envelope.clientMessageId}` };
    }
    return { ok: true, reused: true, message: prior, recipient: resolveRecipient(store, prior.to) };
  }
  const record = {
    seq: ++store.seq,
    id: `m${store.seq}-${crypto.randomBytes(4).toString('hex')}`,
    clientMessageId: envelope.clientMessageId,
    fromAgent: envelope.from.id,
    to: { kind: envelope.to.kind, id: envelope.to.id },
    digest: envelopeDigest(envelope),
    envelope,
    receivedAt: new Date().toISOString(),
  };
  store.messages.push(record);
  store.byClient.set(clientKey, record);
  const recipient = resolveRecipient(store, record.to);
  return { ok: true, reused: false, message: record, recipient };
}

function inboxFor(store, agentId, cursor) {
  const after = Number(cursor) || 0;
  const agent = store.agents.get(agentId);
  if (!agent) return { ok: false, status: 403, error: `agent ${agentId} is not registered` };
  const messages = store.messages.filter(message => message.seq > after && visible(store, agentId, message));
  const highest = store.messages.reduce((max, message) => Math.max(max, message.seq), after);
  return {
    ok: true,
    messages,
    cursor: messages.reduce((max, message) => Math.max(max, message.seq), after),
    tip: highest,
  };
}

function snapshotMemory(store) {
  return {
    seq: store.seq,
    agents: [...store.agents.values()],
    repos: [...store.repos.entries()],
    sessions: [...store.sessions.entries()],
    messages: store.messages,
  };
}

function restoreMemory(store, raw) {
  store.seq = raw.seq || 0;
  store.agents = new Map((raw.agents || []).map(agent => [agent.agentId, agent]));
  store.repos = new Map(raw.repos || []);
  store.sessions = new Map(raw.sessions || []);
  store.messages = raw.messages || [];
  store.byClient = new Map(store.messages.map(message => [`${message.fromAgent}/${message.clientMessageId}`, message]));
}

export class FileStore extends MemoryStore {
  constructor(dir) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'store.json');
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    try { restoreMemory(this, JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  transaction(fn) {
    return withLock(this.dir, () => {
      this.load();
      const result = fn();
      if (result?.ok) this.save();
      return result;
    });
  }

  save() {
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(snapshotMemory(this)), 'utf8');
    fs.renameSync(temp, this.file);
  }

  identify(agentId, publicKey) {
    return withLock(this.dir, () => {
      this.load();
      return MemoryStore.prototype.identify.call(this, agentId, publicKey);
    });
  }

  register(agent) { return this.transaction(() => super.register(agent)); }
  claimSession(agentId, sessionId) { return this.transaction(() => super.claimSession(agentId, sessionId)); }
  putMessage(envelope) { return this.transaction(() => super.putMessage(envelope)); }
  inbox(agentId, cursor) {
    return withLock(this.dir, () => {
      this.load();
      return super.inbox(agentId, cursor);
    });
  }
}

function withLock(dir, fn) {
  const lock = path.join(dir, '.lock');
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let alive = false;
      try {
        const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
        process.kill(pid, 0);
        alive = pid !== process.pid;
      } catch { alive = false; }
      if (!alive) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > 5000) throw new Error('relay store lock timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export class SqliteStore extends MemoryStore {
  constructor(db) {
    super();
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        repos_json TEXT NOT NULL,
        webhook_url TEXT,
        registered_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repo_claims (
        repo_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_claims (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY,
        client_key TEXT NOT NULL UNIQUE,
        from_agent TEXT NOT NULL,
        to_kind TEXT NOT NULL,
        to_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
    `);
  }

  loadIntoMemory() {
    const agents = this.db.prepare('SELECT * FROM agents').all();
    const repos = this.db.prepare('SELECT * FROM repo_claims').all();
    const sessions = this.db.prepare('SELECT * FROM session_claims').all();
    const messages = this.db.prepare('SELECT * FROM messages ORDER BY seq').all();
    const seqRow = this.db.prepare(`SELECT value FROM meta WHERE key = 'seq'`).get();
    restoreMemory(this, {
      seq: seqRow ? Number(seqRow.value) : messages.reduce((max, row) => Math.max(max, row.seq), 0),
      agents: agents.map(row => ({
        agentId: row.agent_id,
        publicKey: row.public_key,
        repos: JSON.parse(row.repos_json),
        webhookUrl: row.webhook_url,
        registeredAt: row.registered_at,
      })),
      repos: repos.map(row => [row.repo_id, row.agent_id]),
      sessions: sessions.map(row => [row.session_id, row.agent_id]),
      messages: messages.map(row => ({
        seq: row.seq,
        id: `m${row.seq}`,
        clientMessageId: row.client_key.split('/').slice(1).join('/'),
        fromAgent: row.from_agent,
        to: { kind: row.to_kind, id: row.to_id },
        digest: row.digest,
        envelope: JSON.parse(row.envelope_json),
        receivedAt: row.received_at,
      })),
    });
  }

  persistFromMemory() {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM agents; DELETE FROM repo_claims; DELETE FROM session_claims; DELETE FROM messages;');
      const agentStmt = this.db.prepare('INSERT INTO agents (agent_id, public_key, repos_json, webhook_url, registered_at) VALUES (?, ?, ?, ?, ?)');
      for (const agent of this.agents.values()) {
        agentStmt.run(agent.agentId, agent.publicKey, JSON.stringify(agent.repos), agent.webhookUrl, agent.registeredAt);
      }
      const repoStmt = this.db.prepare('INSERT INTO repo_claims (repo_id, agent_id) VALUES (?, ?)');
      for (const [repo, agentId] of this.repos) repoStmt.run(repo, agentId);
      const sessionStmt = this.db.prepare('INSERT INTO session_claims (session_id, agent_id) VALUES (?, ?)');
      for (const [sessionId, agentId] of this.sessions) sessionStmt.run(sessionId, agentId);
      const messageStmt = this.db.prepare('INSERT INTO messages (seq, client_key, from_agent, to_kind, to_id, digest, envelope_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const message of this.messages) {
        messageStmt.run(message.seq, `${message.fromAgent}/${message.clientMessageId}`, message.fromAgent, message.to.kind, message.to.id, message.digest, JSON.stringify(message.envelope), message.receivedAt);
      }
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(this.seq));
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already closed */ }
      throw error;
    }
  }

  transaction(fn) {
    this.loadIntoMemory();
    const result = fn();
    if (result?.ok) this.persistFromMemory();
    return result;
  }

  identify(agentId, publicKey) {
    this.loadIntoMemory();
    return MemoryStore.prototype.identify.call(this, agentId, publicKey);
  }

  register(agent) { return this.transaction(() => super.register(agent)); }
  claimSession(agentId, sessionId) { return this.transaction(() => super.claimSession(agentId, sessionId)); }
  putMessage(envelope) { return this.transaction(() => super.putMessage(envelope)); }
  inbox(agentId, cursor) {
    this.loadIntoMemory();
    return super.inbox(agentId, cursor);
  }

  close() { this.db.close(); }
}

export async function createStore(kind = 'file', { dir } = {}) {
  if (kind === 'memory') return new MemoryStore();
  if (kind === 'file' || kind === 'files') {
    if (!dir) throw new Error('file store requires a data directory');
    return new FileStore(dir);
  }
  if (kind === 'sqlite') {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import('node:sqlite')); }
    catch {
      throw new Error('sqlite store needs the built-in node:sqlite module (Node 22.5 or newer). Use REPOS_RELAY_STORE=file on older Node.');
    }
    if (!dir) throw new Error('sqlite store requires a data directory');
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'relay.sqlite'));
    return new SqliteStore(db);
  }
  throw new Error(`unknown relay store: ${kind}`);
}
