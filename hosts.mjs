// Model host adapters for repos-agent. Each one runs a single bounded,
// non-interactive turn of an installed coding-agent CLI inside one repository
// and returns the completion contract as a parsed object.
//
// Every supported CLI already constrains its final answer to a JSON schema in
// headless mode (codex --output-schema, claude --json-schema, grok
// --json-schema), so the adapters differ only in flags and in where the JSON
// lands. The CLI keeps its own authentication; no API key passes through here.
//
// Binary overrides, mainly for tests: REPOS_HOST_<NAME>_BIN and
// REPOS_HOST_<NAME>_BIN_ARGS (a JSON array). CODEX_BIN and CODEX_BIN_ARGS are
// still honored for compatibility.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: ['completed', 'blocked', 'declined'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['outcome', 'summary', 'evidence', 'tests', 'risks'],
};

// The completion outcome mapped onto the A2A-aligned message state.
export const OUTCOME_STATE = {
  completed: 'completed',
  blocked: 'input-required',
  declined: 'rejected',
};

export function validResult(result) {
  return Boolean(result)
    && ['completed', 'blocked', 'declined'].includes(result.outcome)
    && typeof result.summary === 'string'
    && Array.isArray(result.evidence)
    && Array.isArray(result.tests)
    && Array.isArray(result.risks);
}

export class HostError extends Error {
  constructor(message, { auth = false } = {}) {
    super(message);
    this.auth = auth;
  }
}

const AUTH_PATTERN = /not signed in|not logged in|please log ?in|oauth session expired|failed to authenticate|unauthori[sz]ed|invalid api key|run `?\w+ login/i;

function binFor(name) {
  const upper = name.toUpperCase();
  let bin = process.env[`REPOS_HOST_${upper}_BIN`] || (name === 'codex' ? process.env.CODEX_BIN : null);
  const rawArgs = process.env[`REPOS_HOST_${upper}_BIN_ARGS`] || (name === 'codex' ? process.env.CODEX_BIN_ARGS : null);
  let prefixArgs = [];
  if (rawArgs) {
    try { prefixArgs = JSON.parse(rawArgs); }
    catch { throw new HostError(`REPOS_HOST_${upper}_BIN_ARGS must be a JSON array`); }
    if (!Array.isArray(prefixArgs) || prefixArgs.some(arg => typeof arg !== 'string')) {
      throw new HostError(`REPOS_HOST_${upper}_BIN_ARGS must be a JSON array of strings`);
    }
  }
  if (!bin && name === 'codex' && process.platform === 'win32' && !rawArgs) {
    // npm's codex.cmd shim mangles long stdin prompts on Windows; run the
    // package entry point with this Node instead when it is installed.
    const npmEntry = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      : null;
    if (npmEntry && fs.existsSync(npmEntry)) return { bin: process.execPath, prefixArgs: [npmEntry] };
    return { bin: 'codex.cmd', prefixArgs };
  }
  return { bin: bin || name, prefixArgs };
}

function spawn(name, args, { cwd, input, timeoutMs }) {
  const { bin, prefixArgs } = binFor(name);
  const run = spawnSync(bin, [...prefixArgs, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: timeoutMs,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin),
  });
  if (run.error) {
    const missing = run.error.code === 'ENOENT';
    throw new HostError(missing ? `${name} is not installed or not on PATH` : `${name} failed: ${run.error.message}`);
  }
  return run;
}

function failOnExit(name, run) {
  if (run.status === 0) return;
  const detail = `${run.stderr || ''}\n${run.stdout || ''}`.trim();
  throw new HostError(`${name} exited ${run.status}: ${detail.slice(-2000)}`, { auth: AUTH_PATTERN.test(detail) });
}

/**
 * Finds the completion object in a CLI's JSON output. Tolerates a single JSON
 * document, NDJSON (the last parsable line wins), a wrapper that carries the
 * object under structured_output, and a wrapper that carries it as a JSON
 * string under result.
 */
export function extractResult(name, stdout) {
  const docs = [];
  const whole = tryParse(stdout);
  if (whole !== undefined) docs.push(whole);
  else {
    for (const line of String(stdout).split(/\r?\n/).reverse()) {
      const parsed = tryParse(line);
      if (parsed !== undefined) docs.push(parsed);
    }
  }
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue;
    if (doc.type === 'error' || doc.is_error === true) {
      const text = String(doc.message || doc.result || doc.error || 'unknown error');
      throw new HostError(`${name} reported an error: ${text}`, { auth: AUTH_PATTERN.test(text) });
    }
    for (const candidate of [doc, doc.structured_output, doc.structuredOutput, tryParse(doc.result), tryParse(doc.text)]) {
      if (validResult(candidate)) return candidate;
    }
  }
  throw new HostError(`${name} produced no result matching the completion contract`);
}

function tryParse(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

const HOSTS = {
  codex: {
    login: 'codex login',
    run({ repoPath, prompt, readOnly, model, timeoutMs, workDir }) {
      const schemaPath = path.join(workDir, 'result.schema.json');
      const outputPath = path.join(workDir, 'result.json');
      fs.writeFileSync(schemaPath, `${JSON.stringify(RESULT_SCHEMA, null, 2)}\n`, 'utf8');
      const args = [
        'exec',
        '--cd', repoPath,
        '--sandbox', readOnly ? 'read-only' : 'workspace-write',
        '--output-schema', schemaPath,
        '--output-last-message', outputPath,
        '--color', 'never',
      ];
      if (model) args.push('--model', model);
      args.push('-');
      const run = spawn('codex', args, { cwd: repoPath, input: prompt, timeoutMs });
      failOnExit('codex', run);
      if (!fs.existsSync(outputPath)) throw new HostError('codex produced no structured result');
      return extractResult('codex', fs.readFileSync(outputPath, 'utf8'));
    },
  },

  claude: {
    login: 'claude /login (or claude setup-token for a long-lived token)',
    run({ repoPath, prompt, readOnly, model, timeoutMs }) {
      const args = [
        '-p',
        '--output-format', 'json',
        '--json-schema', JSON.stringify(RESULT_SCHEMA),
        '--permission-mode', readOnly ? 'plan' : 'acceptEdits',
        '--no-session-persistence',
      ];
      if (model) args.push('--model', model);
      const run = spawn('claude', args, { cwd: repoPath, input: prompt, timeoutMs });
      // Claude reports API and auth failures as a JSON result with is_error,
      // sometimes with exit 0, so parse before trusting the exit code.
      try { return extractResult('claude', run.stdout); }
      catch (err) { failOnExit('claude', run); throw err; }
    },
  },

  grok: {
    login: 'grok login (or set XAI_API_KEY)',
    run({ repoPath, prompt, readOnly, model, timeoutMs, workDir }) {
      // Grok takes a single-turn prompt from a file, which avoids argument
      // length limits and keeps the prompt out of the process list.
      const promptPath = path.join(workDir, 'prompt.md');
      fs.writeFileSync(promptPath, prompt, 'utf8');
      const args = [
        '--prompt-file', promptPath,
        '--json-schema', JSON.stringify(RESULT_SCHEMA),
        '--output-format', 'json',
        '--cwd', repoPath,
        '--permission-mode', readOnly ? 'plan' : 'acceptEdits',
        '--no-subagents',
      ];
      if (model) args.push('--model', model);
      const run = spawn('grok', args, { cwd: repoPath, timeoutMs });
      try { return extractResult('grok', run.stdout); }
      catch (err) { failOnExit('grok', run); throw err; }
    },
  },
};

export const HOST_NAMES = Object.keys(HOSTS);

export function loginHint(name) {
  return HOSTS[name]?.login || `${name} login`;
}

/** Runs one bounded turn and returns a validated completion object. */
export function runHost(name, options) {
  const host = HOSTS[name];
  if (!host) throw new HostError(`unknown host ${name}; expected one of ${HOST_NAMES.join(', ')}`);
  const result = host.run(options);
  if (!validResult(result)) throw new HostError(`${name} result does not satisfy the completion contract`);
  return result;
}

/** Reports which host CLIs are installed. Never starts a model turn. */
export function probeHosts() {
  return HOST_NAMES.map(name => {
    try {
      const run = spawn(name, ['--version'], { cwd: process.cwd(), timeoutMs: 20000 });
      const version = `${run.stdout || ''}${run.stderr || ''}`.trim().split(/\r?\n/)[0];
      return { name, installed: run.status === 0, version: run.status === 0 ? version : null, login: loginHint(name) };
    } catch (err) {
      return { name, installed: false, version: null, error: err.message, login: loginHint(name) };
    }
  });
}
