// Delivery receipts and message freshness, shared by the CLI, the session
// hook, and the MCP server.
//
// Three facts about a message are kept apart on purpose:
//   queued: it is in the recipient's mailbox; nobody has seen it.
//   seen:   it was injected into a live agent session in the recipient repo.
//   acked:  the recipient marked it handled (acknowledgedAt on the message).
// Seeing is not handling, and handling is not agreeing with the claims.
//
// Each sighting is its own file, created exclusively:
//   .repo-connect/receipts/<repo>/<messageId>/<host>-<session>.json
// so concurrent sessions never race on a shared record, and the file doubles
// as the "already shown to this session" marker that keeps a hook from
// repeating a message.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const SAFE_MESSAGE_ID = /^[A-Za-z0-9_-]+$/;

export function receiptsRoot(root) {
  return path.join(root, '.repo-connect', 'receipts');
}

// Session ids come from the host. Keep them readable when they are already
// safe, and hash anything else so a hostile id can never become a path.
export function sessionKey(session) {
  const value = String(session || 'unknown');
  return /^[A-Za-z0-9-]{1,80}$/.test(value)
    ? value
    : crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function receiptDir(root, repo, messageId) {
  if (!SAFE_ID.test(repo) || !SAFE_MESSAGE_ID.test(messageId)) throw new Error('unsafe receipt path');
  return path.join(receiptsRoot(root), repo, messageId);
}

export function seenFile(root, repo, messageId, host, session) {
  if (!SAFE_ID.test(host)) throw new Error('unsafe host name');
  return path.join(receiptDir(root, repo, messageId), `${host}-${sessionKey(session)}.json`);
}

export function hasSeen(root, repo, messageId, host, session) {
  return fs.existsSync(seenFile(root, repo, messageId, host, session));
}

/**
 * Records one sighting. Returns false when this host and session already saw
 * the message, which is how a hook knows not to show it again.
 */
export function recordSeen(root, repo, messageId, { host, session, at = new Date().toISOString() }) {
  const file = seenFile(root, repo, messageId, host, session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify({ messageId, repo, host, session: sessionKey(session), seenAt: at })}\n`, 'utf8');
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

/** Every sighting of one message, oldest first. Unreadable files are skipped. */
export function readSeen(root, repo, messageId) {
  let names = [];
  try { names = fs.readdirSync(receiptDir(root, repo, messageId)).filter(name => name.endsWith('.json')); }
  catch { return []; }
  const seen = [];
  for (const name of names) {
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir(root, repo, messageId), name), 'utf8'));
      if (receipt && typeof receipt.seenAt === 'string') seen.push({ host: receipt.host, session: receipt.session, seenAt: receipt.seenAt });
    } catch {}
  }
  return seen.sort((a, b) => a.seenAt.localeCompare(b.seenAt));
}

/** Age and expiry of a message relative to now. */
export function freshness(message, { now = Date.now(), staleDays = STALE_DAYS } = {}) {
  const created = Date.parse(message.createdAt);
  const openDays = Number.isFinite(created) ? Math.floor((now - created) / DAY_MS) : null;
  const expiresAt = typeof message.expiresAt === 'string' ? Date.parse(message.expiresAt) : NaN;
  return {
    openDays,
    stale: !message.acknowledgedAt && openDays !== null && openDays >= staleDays,
    expired: Number.isFinite(expiresAt) && expiresAt <= now,
  };
}

/** The sender's view of one message: queued, seen, or acked. */
export function deliveryStatus(root, message, options = {}) {
  const seen = readSeen(root, message.to, message.id);
  const { stale, expired, openDays } = freshness(message, options);
  const status = message.acknowledgedAt ? 'acked' : seen.length ? 'seen' : 'queued';
  const first = seen[0];
  const label = status === 'acked'
    ? `acked at ${message.acknowledgedAt}`
    : status === 'seen'
      ? `seen by ${first.host} at ${first.seenAt}${seen.length > 1 ? ` (${seen.length} sessions)` : ''}, not yet acked`
      : 'queued, not seen yet';
  return {
    status,
    label: `${label}${expired ? ', expired' : stale ? `, open ${openDays} days` : ''}`,
    seen,
    acknowledgedAt: message.acknowledgedAt || null,
    stale,
    expired,
    openDays,
  };
}

/** Parses 30m, 48h, 7d, or 2w into milliseconds. */
export function parseDuration(text) {
  const match = /^(\d{1,6})(m|h|d|w)$/.exec(String(text || ''));
  if (!match) return null;
  const unit = { m: 60 * 1000, h: 60 * 60 * 1000, d: DAY_MS, w: 7 * DAY_MS }[match[2]];
  return Number(match[1]) * unit;
}
