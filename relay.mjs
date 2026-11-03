// HTTPS (or loopback HTTP) relay for repos.chat.
//
// The bearer token admits a caller to this relay. The ed25519 signature says
// which agent they are. A signature that names a different agent is rejected.
// Storage is injected so tests can use memory and a host can use files or
// sqlite. This process does not deploy itself.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  WAKE_PROTOCOL,
  validateWebhookUrl,
  verifyEnvelope,
  verifyInboxPull,
  verifyRegistration,
  verifySessionClaim,
  verifyWatch,
} from './identity.mjs';
import { createStore } from './relay-store.mjs';

const MAX_BYTES = 256 * 1024;
const MAX_BODY = 100_000;
const MAX_SUBJECT = 300;
const KINDS = new Set(['notice', 'response']);

function json(status, body) {
  return { status, body };
}

function bearer(headers) {
  const value = headers.authorization || headers.Authorization || '';
  const match = /^Bearer\s+(\S+)$/.exec(String(value));
  return match ? match[1] : '';
}

function tokensEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length < 16 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function present(record) {
  return {
    seq: record.seq,
    id: record.id,
    clientMessageId: record.clientMessageId,
    from: record.envelope.from,
    to: record.to,
    receivedAt: record.receivedAt,
    envelope: record.envelope,
  };
}

function messageError(envelope) {
  const message = envelope.message || {};
  if (!KINDS.has(message.kind)) {
    return 'relay accepts notice and response only; work requests stay behind local human approval';
  }
  if (typeof message.subject !== 'string' || !message.subject.trim() || message.subject.length > MAX_SUBJECT) {
    return 'subject is missing or too long';
  }
  if (typeof message.body !== 'string' || !message.body || message.body.length > MAX_BODY) return 'body is missing or too long';
  if (typeof message.from !== 'string' || typeof message.to !== 'string') return 'message requires from and to';
  if (message.to !== envelope.to.id) return 'message recipient does not match the envelope target';
  if (typeof message.createdAt !== 'string' || !Number.isFinite(Date.parse(message.createdAt))) return 'createdAt must be an ISO 8601 time';
  if (message.replyTo !== undefined && message.replyTo !== null && !/^[A-Za-z0-9_-]{1,80}$/.test(message.replyTo)) {
    return 'replyTo contains unsupported characters';
  }
  return null;
}

function postWake(urlString, payload, secret) {
  const body = Buffer.from(JSON.stringify(payload));
  const target = new URL(urlString);
  const transport = target.protocol === 'https:' ? https : http;
  const headers = {
    'content-type': 'application/json',
    'content-length': body.length,
    'user-agent': 'repos.chat-relay/1',
  };
  if (secret) headers['x-repos-signature'] = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  return new Promise(resolve => {
    const req = transport.request(target, { method: 'POST', headers, timeout: 5000 }, response => {
      response.resume();
      const ok = response.statusCode >= 200 && response.statusCode < 300;
      resolve({ ok, status: response.statusCode });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'webhook timed out' });
    });
    req.on('error', error => resolve({ ok: false, error: error.message }));
    req.end(body);
  });
}

export function createRelay({ store, token, webhookSecret = '' } = {}) {
  if (!token || String(token).length < 16) throw new Error('REPOS_RELAY_TOKEN must be at least 16 characters');

  async function register(body) {
    const verified = verifyRegistration(body);
    if (!verified.ok) return json(403, { ok: false, error: verified.error });
    const webhook = validateWebhookUrl(body.webhookUrl);
    if (!webhook.ok) return json(400, { ok: false, error: webhook.error });
    const saved = store.register({
      agentId: body.agentId,
      publicKey: body.publicKey,
      repos: body.repos,
      webhookUrl: webhook.url,
    });
    if (!saved.ok) return json(saved.status || 403, { ok: false, error: saved.error });
    return json(saved.created ? 201 : 200, { ok: true, agent: { agentId: saved.agent.agentId, repos: saved.agent.repos, webhookUrl: saved.agent.webhookUrl } });
  }

  function sessions(body) {
    const verified = verifySessionClaim(body);
    if (!verified.ok) return json(403, { ok: false, error: verified.error });
    const who = store.identify(body.agentId, body.publicKey);
    if (!who.ok) return json(who.status, { ok: false, error: who.error });
    const claimed = store.claimSession(body.agentId, body.sessionId);
    if (!claimed.ok) return json(claimed.status || 409, { ok: false, error: claimed.error });
    return json(200, { ok: true, sessionId: claimed.sessionId, agentId: claimed.agentId });
  }

  async function messages(body) {
    const verified = verifyEnvelope(body);
    if (!verified.ok) return json(403, { ok: false, error: verified.error });
    const invalid = messageError(body);
    if (invalid) return json(400, { ok: false, error: invalid });
    const saved = store.putMessage(body);
    if (!saved.ok) return json(saved.status || 400, { ok: false, error: saved.error });
    let wake = null;
    if (!saved.reused && saved.recipient?.webhookUrl) {
      const payload = {
        protocol: WAKE_PROTOCOL,
        event: 'mail',
        id: saved.message.id,
        clientMessageId: saved.message.clientMessageId,
        from: body.from,
        to: body.to,
        subject: body.message.subject,
        createdAt: body.message.createdAt,
      };
      try {
        const posted = await postWake(saved.recipient.webhookUrl, payload, webhookSecret);
        wake = {
          delivered: posted.ok,
          ...(posted.status ? { status: posted.status } : {}),
          ...(posted.error ? { error: posted.error } : {}),
        };
      } catch (error) {
        wake = { delivered: false, error: error.message };
      }
    }
    if (!saved.reused) store.notify();
    return json(saved.reused ? 200 : 201, {
      ok: true,
      reused: Boolean(saved.reused),
      seq: saved.message.seq,
      id: saved.message.id,
      clientMessageId: saved.message.clientMessageId,
      wake,
    });
  }

  function pull(body) {
    const verified = verifyInboxPull(body);
    if (!verified.ok) return json(403, { ok: false, error: verified.error });
    const who = store.identify(body.agentId, body.publicKey);
    if (!who.ok) return json(who.status, { ok: false, error: who.error });
    const page = store.inbox(body.agentId, body.cursor);
    if (!page.ok) return json(page.status || 403, { ok: false, error: page.error });
    return json(200, { ok: true, cursor: page.cursor, messages: page.messages.map(present) });
  }

  async function watch(body) {
    const verified = verifyWatch(body);
    if (!verified.ok) return json(403, { ok: false, error: verified.error });
    const who = store.identify(body.agentId, body.publicKey);
    if (!who.ok) return json(who.status, { ok: false, error: who.error });
    const timeout = Math.min(25000, Math.max(0, Number(body.timeoutMs) || 0));
    const pending = timeout > 0 ? store.wait(timeout) : null;
    let page = store.inbox(body.agentId, body.cursor);
    if (!page.ok) {
      pending?.cancel();
      return json(page.status || 403, { ok: false, error: page.error });
    }
    if (!page.messages.length && pending) {
      await pending;
      page = store.inbox(body.agentId, body.cursor);
      if (!page.ok) return json(page.status || 403, { ok: false, error: page.error });
    } else if (pending) pending.cancel();
    return json(200, { ok: true, cursor: page.cursor, messages: page.messages.map(present) });
  }

  return {
    store,
    async handle(request) {
      const url = new URL(request.url, 'http://relay.local');
      if (request.method === 'GET' && url.pathname === '/v1/health') return json(200, { ok: true, protocol: 'repos.chat/relay/1' });
      if (!tokensEqual(bearer(request.headers), token)) return json(401, { ok: false, error: 'unauthorized' });
      let body = {};
      if (request.method !== 'GET') {
        try { body = JSON.parse(request.bodyText || '{}'); }
        catch { return json(400, { ok: false, error: 'body must be JSON' }); }
      }
      if (request.method === 'POST' && url.pathname === '/v1/register') return register(body);
      if (request.method === 'POST' && url.pathname === '/v1/sessions') return sessions(body);
      if (request.method === 'POST' && url.pathname === '/v1/messages') return messages(body);
      if (request.method === 'POST' && url.pathname === '/v1/inbox') return pull(body);
      if (request.method === 'POST' && url.pathname === '/v1/watch') return watch(body);
      return json(404, { ok: false, error: 'not found' });
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function listenRelay(relay, { host = '127.0.0.1', port = 8787, tls = null } = {}) {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback && !tls && process.env.REPOS_RELAY_INSECURE !== '1') {
    throw new Error('refusing to listen beyond loopback without TLS. Set REPOS_RELAY_TLS_CERT and REPOS_RELAY_TLS_KEY, or REPOS_RELAY_INSECURE=1 only on a network you trust.');
  }
  const handler = async (req, res) => {
    try {
      const bodyText = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
      const result = await relay.handle({ method: req.method, url: req.url, headers: req.headers, bodyText });
      const payload = JSON.stringify(result.body);
      res.writeHead(result.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      });
      res.end(payload);
    } catch (error) {
      const status = error.status || 500;
      const payload = JSON.stringify({ ok: false, error: status === 413 ? 'body too large' : 'relay failed' });
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(payload);
      if (status === 500) process.stderr.write(`relay error: ${error.message}\n`);
    }
  };
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
  server.requestTimeout = 120_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      const protocol = tls ? 'https' : 'http';
      const advertised = host === '0.0.0.0' || host === '::' ? host : host;
      resolve({ server, url: `${protocol}://${advertised}:${bound}`, port: bound });
    });
  });
}

export function relayDataDir(explicit) {
  return explicit || process.env.REPOS_RELAY_DATA_DIR || path.join(os.homedir(), '.repos-chat', 'relay');
}

export async function relayFromEnv(env = process.env) {
  const token = env.REPOS_RELAY_TOKEN;
  const kind = env.REPOS_RELAY_STORE || 'file';
  const dir = kind === 'memory' ? undefined : relayDataDir(env.REPOS_RELAY_DATA_DIR);
  const store = await createStore(kind, { dir });
  const relay = createRelay({ store, token, webhookSecret: env.REPOS_RELAY_WEBHOOK_SECRET || '' });
  return { relay, store, kind, dir: dir || null };
}

export function readTls(env = process.env) {
  const certPath = env.REPOS_RELAY_TLS_CERT;
  const keyPath = env.REPOS_RELAY_TLS_KEY;
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) throw new Error('set both REPOS_RELAY_TLS_CERT and REPOS_RELAY_TLS_KEY');
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return import.meta.url === pathToFileURL(path.resolve(entry)).href; }
  catch { return false; }
}

if (invokedDirectly()) {
  const env = { ...process.env };
  const dataFlag = process.argv.indexOf('--data');
  if (dataFlag > -1) env.REPOS_RELAY_DATA_DIR = process.argv[dataFlag + 1];
  const portFlag = process.argv.indexOf('--port');
  const hostFlag = process.argv.indexOf('--host');
  try {
    const { relay, kind } = await relayFromEnv(env);
    const tls = readTls(env);
    const host = hostFlag > -1 ? process.argv[hostFlag + 1] : (env.REPOS_RELAY_HOST || '127.0.0.1');
    const port = portFlag > -1 ? Number(process.argv[portFlag + 1]) : Number(env.REPOS_RELAY_PORT || 8787);
    const listening = await listenRelay(relay, { host, port, tls });
    process.stdout.write(`${JSON.stringify({ ok: true, url: listening.url, store: kind })}\n`);
    const stop = () => {
      // close() alone waits for keep-alive watchers that keep long-polling, so
      // Ctrl-C would hang while any agent is watching. Drop them; they retry.
      listening.server.close(() => process.exit(0));
      listening.server.closeAllConnections?.();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
