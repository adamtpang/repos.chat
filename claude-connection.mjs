import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binFor } from './hosts.mjs';

// Speaks the subset of the Codex app-server protocol that LocalBridge uses,
// backed by Claude Code's own session files. Claude has no native writer lease,
// so any live process registered for the session in <home>/sessions counts as
// the writer, and the bridge never runs a turn beside it.
export class ClaudeConnection extends EventEmitter {
  kind = 'claude';
  constructor({ command, args, home = path.join(os.homedir(), '.claude'), timeout = 30000 } = {}) {
    super();
    const resolved = command ? { bin: command, prefixArgs: args || [] } : binFor('claude');
    this.command = resolved.bin; this.args = resolved.prefixArgs; this.home = home; this.timeout = timeout;
    this.runs = new Map(); this.closed = true;
  }
  async connect() { this.closed = false; return {}; }
  // Print mode never asks for permission, so there is nothing to answer.
  write() {}
  respond() { throw new Error('Claude print mode has no pending permission requests'); }
  async request(method, params = {}) {
    if (this.closed) throw new Error('Claude bridge is disconnected');
    if (method === 'thread/read') return { thread: this.read(params.threadId) };
    if (method === 'thread/resume') {
      const thread = this.read(params.threadId), writer = this.writer(params.threadId);
      if (writer) throw new Error(`Session already has an active writer (${writer.entrypoint || 'claude'} pid ${writer.pid}); close it there first`);
      return { thread };
    }
    if (method === 'turn/start') return this.start(params);
    if (method === 'turn/interrupt') {
      const run = this.runs.get(params.threadId); if (!run) throw new Error('No active turn');
      run.child.kill(); return {};
    }
    throw new Error(`Unsupported Claude bridge method ${method}`);
  }
  file(threadId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId || '')) throw new Error('Claude session IDs are UUIDs');
    const projects = path.join(this.home, 'projects');
    for (const dir of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
      const file = path.join(projects, dir, `${threadId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
    throw new Error('Unknown Claude session');
  }
  // A live process other than this bridge's own child that has the session open.
  writer(threadId) {
    const dir = path.join(this.home, 'sessions'), own = new Set([...this.runs.values()].map(r => r.child.pid));
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => /^\d+\.json$/.test(x)) : []) {
      let entry; try { entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
      if (entry.sessionId !== threadId || own.has(entry.pid)) continue;
      try { process.kill(entry.pid, 0); return entry; } catch (e) { if (e.code === 'EPERM') return entry; }
    }
    return null;
  }
  read(threadId) {
    const lines = fs.readFileSync(this.file(threadId), 'utf8').split('\n');
    const turns = []; let cwd = null, updatedAt = null;
    for (const line of lines) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      cwd ||= e.cwd;
      if (e.isSidechain || !['user', 'assistant'].includes(e.type)) continue;
      const content = e.message?.content, at = Date.parse(e.timestamp) / 1000;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      if (Number.isFinite(at)) updatedAt = at;
      if (e.type === 'user') {
        if (e.isMeta || !blocks.length || blocks.some(b => b.type === 'tool_result')) continue;
        const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
        if (text.startsWith('[Request interrupted by user')) { if (turns.length) turns.at(-1).status = 'interrupted'; continue; }
        if (/^<(command-|local-command-)/.test(text)) continue;
        // The message uuid is the receipt: the bridge sends the prompt with uuid = clientUserMessageId.
        turns.push({ id: e.uuid, status: 'completed', startedAt: at, completedAt: at, items: [{ type: 'userMessage', clientId: e.uuid, content: [{ type: 'text', text }] }] });
      } else if (turns.length) {
        const turn = turns.at(-1); turn.completedAt = at;
        for (const b of blocks) {
          if (b.type === 'text' && b.text.trim()) turn.items.push({ type: 'agentMessage', text: b.text });
          if (b.type === 'tool_use' && b.name === 'StructuredOutput') turn.items.push({ type: 'agentMessage', text: JSON.stringify(b.input), structured: true });
        }
      }
    }
    const writer = this.writer(threadId), active = this.runs.has(threadId) || !!writer;
    const latest = turns.at(-1);
    if (latest && (this.runs.has(threadId) || writer?.status === 'busy')) latest.status = 'inProgress';
    for (const turn of turns) {
      if (turn.status === 'inProgress') continue;
      const answers = turn.items.filter(x => x.type === 'agentMessage'), final = answers.findLast(x => x.structured) || answers.at(-1);
      if (final) final.phase = 'final_answer';
    }
    return { id: threadId, cwd, name: writer?.name || null, preview: turns[0]?.items[0].content[0].text.slice(0, 80) || null, status: { type: active ? 'active' : 'idle' }, updatedAt, turns };
  }
  start({ threadId, input, clientUserMessageId, outputSchema }) {
    if (this.runs.has(threadId)) return Promise.reject(new Error('A turn is already running in this session'));
    let cwd;
    try {
      const writer = this.writer(threadId);
      if (writer) throw new Error(`Session has another active writer (pid ${writer.pid}); do not run beside it`);
      cwd = this.read(threadId).cwd;
    } catch (e) { return Promise.reject(e); }
    const text = input.filter(x => x.type === 'text').map(x => x.text).join('');
    // No model, permission or instruction overrides: the session keeps its own settings.
    const args = [...this.args, '-p', '--resume', threadId, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      ...(outputSchema ? ['--json-schema', JSON.stringify(outputSchema)] : [])];
    const child = spawn(this.command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.runs.set(threadId, { child });
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
      const timer = setTimeout(() => settle(reject, new Error('turn/start timed out; do not automatically retry mutations')), this.timeout);
      child.on('error', error => { this.runs.delete(threadId); settle(reject, error); });
      child.on('exit', code => {
        this.runs.delete(threadId);
        this.emit('notification', { method: 'turn/completed', params: { threadId } });
        settle(reject, new Error(`Claude exited (${code}) before the turn started; reconcile before any retry`));
      });
      child.stderr.on('data', chunk => this.emit('diagnostic', chunk.toString()));
      createInterface({ input: child.stdout }).on('line', line => {
        let m; try { m = JSON.parse(line); } catch { return; }
        if (m.type === 'system' && m.subtype === 'init') {
          if (m.session_id !== threadId) { child.kill(); return settle(reject, new Error('Claude resumed a different session')); }
          this.emit('notification', { method: 'turn/started', params: { threadId } });
          settle(resolve, { turn: { id: clientUserMessageId, status: 'inProgress' } });
        }
        if (m.type === 'assistant') for (const b of m.message?.content || []) {
          if (b.type === 'text') this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, delta: b.text } });
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ type: 'user', uuid: clientUserMessageId, message: { role: 'user', content: text } }) + '\n');
    });
  }
  close() {
    this.closed = true;
    for (const run of this.runs.values()) run.child.kill();
    this.runs.clear();
  }
}
