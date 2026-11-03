// Agent identity for the repos.chat relay.
//
// A keypair proves who sent an envelope. The private key lives in the user
// profile or in environment variables, never in a repository. The relay
// binds an agent id to the first public key that registers it and rejects
// any later signature that does not match.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IDENTITY_PROTOCOL = 'repos.chat/identity/1';
export const RELAY_PROTOCOL = 'repos.chat/relay/1';
export const REGISTER_PROTOCOL = 'repos.chat/register/1';
export const WATCH_PROTOCOL = 'repos.chat/watch/1';
export const SESSION_PROTOCOL = 'repos.chat/session/1';
export const WAKE_PROTOCOL = 'repos.chat/wake/1';

export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const TARGET_KINDS = new Set(['agent', 'session', 'repo']);

export function defaultIdentityPath() {
  return path.join(os.homedir(), '.repos-chat', 'identity.json');
}

export function isInside(parent, child, pathImpl = path) {
  if (!parent || !child) return false;
  const base = pathImpl.resolve(parent);
  const target = pathImpl.resolve(child);
  const rel = pathImpl.relative(base, target);
  if (rel === '') return true;
  return !rel.startsWith('..') && !pathImpl.isAbsolute(rel);
}

export function assertIdentityOutside(file, roots, pathImpl = path) {
  const resolved = pathImpl.resolve(file);
  for (const root of roots) {
    if (root && isInside(root, resolved, pathImpl)) {
      throw new Error(`refusing to write a private key inside ${pathImpl.resolve(root)}; keep identity at ${defaultIdentityPath()} or set REPOS_AGENT_PRIVATE_KEY`);
    }
  }
  return resolved;
}

export function parseTarget(value) {
  if (typeof value !== 'string') return null;
  const match = /^(agent|session|repo):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(value.trim());
  if (!match) return null;
  return { kind: match[1], id: match[2] };
}

export function formatTarget(target) {
  if (!target || !TARGET_KINDS.has(target.kind) || !TARGET_ID.test(target.id || '')) return null;
  return `${target.kind}:${target.id}`;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function generateIdentity(agentId) {
  if (!AGENT_ID.test(agentId || '')) throw new Error('agent id must start with a letter or digit and contain only letters, digits, dots, underscores, and hyphens');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    version: 1,
    protocol: IDENTITY_PROTOCOL,
    agentId,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    createdAt: new Date().toISOString(),
  };
}

export function publicKeyFromPrivate(privateKeyB64) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
}

function privateKeyObject(identity) {
  return crypto.createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
}

function publicKeyObject(publicKeyB64) {
  return crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
}

export function signPayload(identity, payload) {
  return crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKeyObject(identity)).toString('base64');
}

export function verifyPayload(publicKeyB64, payload, signatureB64) {
  if (typeof publicKeyB64 !== 'string' || typeof signatureB64 !== 'string' || !signatureB64) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalJson(payload)),
      publicKeyObject(publicKeyB64),
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}

export function loadIdentity({ file, env = process.env } = {}) {
  if (env.REPOS_AGENT_ID || env.REPOS_AGENT_PRIVATE_KEY || env.REPOS_AGENT_PUBLIC_KEY) {
    if (!env.REPOS_AGENT_ID || !env.REPOS_AGENT_PRIVATE_KEY) {
      throw new Error('REPOS_AGENT_ID and REPOS_AGENT_PRIVATE_KEY must be set together');
    }
    if (!AGENT_ID.test(env.REPOS_AGENT_ID)) throw new Error('REPOS_AGENT_ID is not a safe agent id');
    const derived = publicKeyFromPrivate(env.REPOS_AGENT_PRIVATE_KEY);
    if (env.REPOS_AGENT_PUBLIC_KEY && env.REPOS_AGENT_PUBLIC_KEY !== derived) {
      throw new Error('REPOS_AGENT_PUBLIC_KEY does not match REPOS_AGENT_PRIVATE_KEY');
    }
    return {
      version: 1,
      protocol: IDENTITY_PROTOCOL,
      agentId: env.REPOS_AGENT_ID,
      publicKey: derived,
      privateKey: env.REPOS_AGENT_PRIVATE_KEY,
      source: 'env',
    };
  }
  const identityFile = file || env.REPOS_IDENTITY_FILE || defaultIdentityPath();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(identityFile, 'utf8')); }
  catch (error) {
    throw new Error(`could not read identity file ${identityFile}: ${error.message}. Run \`repos identity init --agent NAME\` or set REPOS_AGENT_ID and REPOS_AGENT_PRIVATE_KEY.`);
  }
  if (!raw || !AGENT_ID.test(raw.agentId || '') || typeof raw.privateKey !== 'string' || typeof raw.publicKey !== 'string') {
    throw new Error(`identity file ${identityFile} is missing agentId or keys`);
  }
  if (publicKeyFromPrivate(raw.privateKey) !== raw.publicKey) {
    throw new Error(`identity file ${identityFile} public key does not match its private key`);
  }
  return { ...raw, source: identityFile };
}

export function publicIdentity(identity) {
  return {
    agentId: identity.agentId,
    publicKey: identity.publicKey,
    createdAt: identity.createdAt || null,
    source: identity.source === 'env' ? 'env' : 'file',
  };
}

export function saveIdentity(file, identity) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify({
    version: identity.version,
    protocol: identity.protocol,
    agentId: identity.agentId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAt: identity.createdAt,
  }, null, 2)}\n`;
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeFileSync(fd, body, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(file, 0o600); } catch { /* Windows keeps the file in the user profile. */ }
}

export function signEnvelope(identity, fields) {
  const unsigned = {
    protocol: RELAY_PROTOCOL,
    version: 1,
    clientMessageId: fields.clientMessageId,
    from: { kind: 'agent', id: identity.agentId },
    to: { kind: fields.to.kind, id: fields.to.id },
    message: fields.message,
    signedAt: fields.signedAt || new Date().toISOString(),
    publicKey: identity.publicKey,
  };
  return { ...unsigned, signature: signPayload(identity, unsigned) };
}

export function verifyEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { ok: false, error: 'relay envelope must be an object' };
  if (envelope.protocol !== RELAY_PROTOCOL || envelope.version !== 1) return { ok: false, error: 'unsupported relay envelope' };
  if (!CLIENT_MESSAGE_ID.test(envelope.clientMessageId || '')) return { ok: false, error: 'client_message_id is missing or unsafe' };
  if (!envelope.from || envelope.from.kind !== 'agent' || !AGENT_ID.test(envelope.from.id || '')) return { ok: false, error: 'from must be exactly one agent target' };
  if (!formatTarget(envelope.to)) return { ok: false, error: 'to must be exactly one agent, session, or repo target' };
  if (!envelope.message || typeof envelope.message !== 'object' || Array.isArray(envelope.message)) return { ok: false, error: 'envelope is missing a message' };
  const { signature, ...unsigned } = envelope;
  if (!verifyPayload(envelope.publicKey, unsigned, signature)) return { ok: false, error: 'invalid signature' };
  return { ok: true };
}

export function envelopeDigest(envelope) {
  const { signature, signedAt, ...rest } = envelope;
  return canonicalJson(rest);
}

export function signRegistration(identity, { repos = [], webhookUrl = null, signedAt = new Date().toISOString() } = {}) {
  const unsigned = {
    protocol: REGISTER_PROTOCOL,
    agentId: identity.agentId,
    publicKey: identity.publicKey,
    repos,
    webhookUrl,
    signedAt,
  };
  return { ...unsigned, signature: signPayload(identity, unsigned) };
}

export function verifyRegistration(body) {
  if (!body || body.protocol !== REGISTER_PROTOCOL) return { ok: false, error: 'unsupported registration' };
  if (!AGENT_ID.test(body.agentId || '')) return { ok: false, error: 'agent id is unsafe' };
  if (!Array.isArray(body.repos) || body.repos.some(repo => !AGENT_ID.test(repo || ''))) return { ok: false, error: 'repos must be a list of safe repo ids' };
  const { signature, ...unsigned } = body;
  if (!verifyPayload(body.publicKey, unsigned, signature)) return { ok: false, error: 'invalid registration signature' };
  if (body.agentId !== unsigned.agentId) return { ok: false, error: 'spoofed from' };
  return { ok: true };
}

export function signSessionClaim(identity, sessionId, signedAt = new Date().toISOString()) {
  if (!TARGET_ID.test(sessionId || '')) throw new Error('session id is unsafe');
  const unsigned = {
    protocol: SESSION_PROTOCOL,
    agentId: identity.agentId,
    sessionId,
    publicKey: identity.publicKey,
    signedAt,
  };
  return { ...unsigned, signature: signPayload(identity, unsigned) };
}

export function verifySessionClaim(body) {
  if (!body || body.protocol !== SESSION_PROTOCOL) return { ok: false, error: 'unsupported session claim' };
  if (!AGENT_ID.test(body.agentId || '') || !TARGET_ID.test(body.sessionId || '')) return { ok: false, error: 'session claim ids are unsafe' };
  const { signature, ...unsigned } = body;
  if (!verifyPayload(body.publicKey, unsigned, signature)) return { ok: false, error: 'invalid session signature' };
  return { ok: true };
}

export function signWatch(identity, { cursor = 0, timeoutMs = 20000, signedAt = new Date().toISOString() } = {}) {
  const unsigned = {
    protocol: WATCH_PROTOCOL,
    agentId: identity.agentId,
    cursor: Number(cursor) || 0,
    timeoutMs,
    publicKey: identity.publicKey,
    signedAt,
  };
  return { ...unsigned, signature: signPayload(identity, unsigned) };
}

export function verifyWatch(body) {
  if (!body || body.protocol !== WATCH_PROTOCOL) return { ok: false, error: 'unsupported watch request' };
  if (!AGENT_ID.test(body.agentId || '')) return { ok: false, error: 'watch agent id is unsafe' };
  const { signature, ...unsigned } = body;
  if (!verifyPayload(body.publicKey, unsigned, signature)) return { ok: false, error: 'invalid watch signature' };
  return { ok: true };
}

export function signInboxPull(identity, { cursor = 0, signedAt = new Date().toISOString() } = {}) {
  const unsigned = {
    protocol: 'repos.chat/inbox/1',
    agentId: identity.agentId,
    cursor: Number(cursor) || 0,
    publicKey: identity.publicKey,
    signedAt,
  };
  return { ...unsigned, signature: signPayload(identity, unsigned) };
}

export function verifyInboxPull(body) {
  if (!body || body.protocol !== 'repos.chat/inbox/1') return { ok: false, error: 'unsupported inbox pull' };
  if (!AGENT_ID.test(body.agentId || '')) return { ok: false, error: 'inbox agent id is unsafe' };
  const { signature, ...unsigned } = body;
  if (!verifyPayload(body.publicKey, unsigned, signature)) return { ok: false, error: 'invalid inbox signature' };
  return { ok: true };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

export function validateWebhookUrl(value) {
  if (value == null || value === '') return { ok: true, url: null };
  if (typeof value !== 'string') return { ok: false, error: 'webhook URL must be a string' };
  let url;
  try { url = new URL(value); }
  catch { return { ok: false, error: 'webhook URL is invalid' }; }
  if (url.username || url.password) return { ok: false, error: 'webhook URL must not include credentials' };
  if (url.protocol === 'https:') return { ok: true, url: url.toString() };
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return { ok: true, url: url.toString() };
  return { ok: false, error: 'webhook URL must be https, or http on localhost' };
}
