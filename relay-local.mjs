// Local paths for relay outbox, inbox, and hook commands.
// Every path is built with path.join so Windows and POSIX stay inside the
// workspace. Segments are ids, never raw user paths.

import fs from 'node:fs';
import path from 'node:path';
import { CLIENT_MESSAGE_ID, TARGET_KINDS, formatTarget } from './identity.mjs';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function portablePath(value) {
  return String(value).replace(/\\/g, '/');
}

export function assertSegment(value, label = 'id') {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new Error(`unsafe ${label}`);
  }
  return value;
}

export function joinInside(root, segments, pathImpl = path) {
  if (!root || typeof root !== 'string') throw new Error('unsafe root');
  for (const segment of segments) {
    if (typeof segment !== 'string' || !segment || segment === '.' || segment === '..') throw new Error('unsafe path segment');
    if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) throw new Error('unsafe path segment');
  }
  const resolvedRoot = pathImpl.resolve(root);
  const full = pathImpl.join(resolvedRoot, ...segments);
  const rel = pathImpl.relative(resolvedRoot, full);
  if (!rel || rel.startsWith('..') || pathImpl.isAbsolute(rel)) throw new Error('path escapes the workspace');
  return full;
}

export function relayDir(root, pathImpl = path) {
  return joinInside(root, ['.repo-connect', 'relay'], pathImpl);
}

export function outboxFile(root, clientMessageId, pathImpl = path) {
  if (!CLIENT_MESSAGE_ID.test(clientMessageId || '')) throw new Error('unsafe client_message_id');
  return joinInside(root, ['.repo-connect', 'relay', 'outbox', `${clientMessageId}.json`], pathImpl);
}

export function cursorFile(root, pathImpl = path) {
  return joinInside(root, ['.repo-connect', 'relay', 'cursor.json'], pathImpl);
}

export function relayInboxFile(root, kind, id, clientMessageId, pathImpl = path) {
  if (!TARGET_KINDS.has(kind)) throw new Error('unsafe target kind');
  if (!formatTarget({ kind, id })) throw new Error('unsafe target');
  if (!CLIENT_MESSAGE_ID.test(clientMessageId || '')) throw new Error('unsafe client_message_id');
  return joinInside(root, ['.repo-connect', 'relay', 'inbox', kind, id, `${clientMessageId}.json`], pathImpl);
}

export function formatHookCommand({ nodeBin = 'node', hookPath, root, repo, event, host, agent }) {
  assertSegment(repo, 'repo');
  assertSegment(host, 'host');
  if (agent) assertSegment(agent, 'agent');
  if (event !== 'UserPromptSubmit' && event !== 'SessionStart') throw new Error('unsupported hook event');
  const quote = value => `"${portablePath(value)}"`;
  let command = `${nodeBin} ${quote(hookPath)} --root ${quote(root)} --repo ${repo} --event ${event} --host ${host}`;
  if (agent) command += ` --agent ${agent}`;
  return command;
}

function samePayload(left, right) {
  return ['from', 'to', 'kind', 'subject', 'body', 'replyTo', 'clientMessageId'].every(key => (left?.[key] ?? null) === (right?.[key] ?? null))
    && JSON.stringify(left?.target || null) === JSON.stringify(right?.target || null)
    && JSON.stringify(left?.origin || null) === JSON.stringify(right?.origin || null);
}

export function writeExclusiveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.closeSync(fd);
    return { ok: true, message: value, reused: false };
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed or never fully created */ }
    }
    if (error.code !== 'EEXIST') return { ok: false, error: error.message };
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!samePayload(existing, value)) return { ok: false, error: `client_message_id already exists with different content: ${value.clientMessageId}` };
      return { ok: true, message: existing, reused: true };
    } catch {
      return { ok: false, error: `client_message_id already exists but is unreadable: ${value.clientMessageId}` };
    }
  }
}

export function readJsonDir(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith('.json')); }
  catch { return []; }
  const rows = [];
  for (const name of names) {
    try { rows.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); }
    catch { /* one bad file does not hide the rest */ }
  }
  return rows;
}

export function listRelayInbox(root, kind, id) {
  let dir;
  try { dir = joinInside(root, ['.repo-connect', 'relay', 'inbox', kind, id]); }
  catch { return []; }
  return readJsonDir(dir).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function localMessageFromEnvelope(envelope) {
  const message = envelope.message || {};
  const to = envelope.to;
  return {
    version: 3,
    protocol: 'repos.chat/1',
    id: envelope.clientMessageId,
    clientMessageId: envelope.clientMessageId,
    conversationId: message.conversationId || envelope.clientMessageId,
    from: message.from,
    to: to.id,
    kind: message.kind,
    subject: message.subject,
    body: message.body,
    createdAt: message.createdAt,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(message.state ? { state: message.state } : {}),
    ...(message.host ? { host: message.host } : {}),
    ...(message.expiresAt ? { expiresAt: message.expiresAt } : {}),
    ...(message.authorization ? { authorization: message.authorization } : {}),
    target: { kind: to.kind, id: to.id },
    origin: { kind: 'agent', id: envelope.from.id },
    receiptRepo: to.kind === 'repo' ? to.id : `${to.kind}.${to.id}`,
  };
}
