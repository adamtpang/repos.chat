// Model host adapters for repos-agent. Each adapter only says how to invoke
// one installed coding-agent CLI for a single bounded, non-interactive turn
// and where its answer lands. Spawning, process-tree containment, leases,
// timeouts, and output limits stay in agent-host.mjs, identical for every
// model.
//
// Every supported CLI constrains its final answer to a JSON schema in
// headless mode (codex --output-schema, claude --json-schema, grok
// --json-schema), so one completion contract serves all of them. Each CLI
// keeps its own sign-in; no API key passes through repos.chat.
//
// Binary overrides, mainly for tests: REPOS_HOST_<NAME>_BIN and
// REPOS_HOST_<NAME>_BIN_ARGS (a JSON array). CODEX_BIN and CODEX_BIN_ARGS are
// still honored.

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

// The completion outcome mapped onto the A2A-aligned response state.
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

export const AUTH_PATTERN = /not signed in|not logged in|please log ?in|oauth session expired|failed to authenticate|unauthori[sz]ed|invalid api key|run `?\w+ login/i;

const LOGIN = {
  codex: 'codex login',
  claude: 'claude /login (or claude setup-token for a long-lived token)',
  grok: 'grok login (or set XAI_API_KEY)',
};

export const HOST_NAMES = Object.keys(LOGIN);

export function loginHint(name) {
  return LOGIN[name] || `${name} login`;
}

function tryParse(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

/**
 * Finds the completion object in a CLI's JSON output. Tolerates a single JSON
 * document, NDJSON (the last parsable line wins), a wrapper that carries the
 * object under structured_output, and a wrapper that carries it as a JSON
 * string under result. A reported error becomes a HostError, flagged as an
 * authentication failure when it reads like one.
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

export function binFor(name) {
  const upper = name.toUpperCase();
  let bin = process.env[`REPOS_HOST_${upper}_BIN`] || (name === 'codex' ? process.env.CODEX_BIN : null);
  const rawArgs = process.env[`REPOS_HOST_${upper}_BIN_ARGS`] || (name === 'codex' ? process.env.CODEX_BIN_ARGS : null);
  let prefixArgs = [];
  if (!bin && name === 'codex' && process.platform === 'win32') {
    // The npm shim is a .cmd wrapper, which is refused below; run the
    // package's JavaScript entry point with this Node instead.
    const npmEntry = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      : null;
    if (!npmEntry || !fs.existsSync(npmEntry)) {
      throw new HostError('could not locate the Codex JavaScript entry point; set CODEX_BIN to a real executable and CODEX_BIN_ARGS to its JSON argument prefix');
    }
    bin = process.execPath;
    prefixArgs = [npmEntry];
  }
  if (rawArgs) {
    try { prefixArgs = JSON.parse(rawArgs); }
    catch { throw new HostError(`REPOS_HOST_${upper}_BIN_ARGS must be a JSON array`); }
    if (!Array.isArray(prefixArgs) || prefixArgs.some(arg => typeof arg !== 'string')) {
      throw new HostError(`REPOS_HOST_${upper}_BIN_ARGS must be a JSON array of strings`);
    }
  }
  bin = bin || name;
  // A .cmd or .bat wrapper would route the prompt through cmd.exe parsing.
  if (/\.(cmd|bat)$/i.test(bin)) {
    throw new HostError(`${name} binary cannot be a .cmd or .bat wrapper; use a real executable`);
  }
  return { bin, prefixArgs };
}

/**
 * Builds one invocation. The caller writes `input` to stdin, then hands the
 * captured stdout to `readResult`. `writeCapable` is true only for an approved
 * branch-pr recipe; every other permission runs read-only.
 */
export function hostCommand(name, { repoPath, writeCapable, model, workDir, prompt }) {
  if (!HOST_NAMES.includes(name)) {
    throw new HostError(`unknown host ${name}; expected one of ${HOST_NAMES.join(', ')}`);
  }
  const { bin, prefixArgs } = binFor(name);
  const schemaJson = JSON.stringify(RESULT_SCHEMA);
  const modelArgs = model ? ['--model', model] : [];

  if (name === 'codex') {
    const schemaPath = path.join(workDir, 'result.schema.json');
    const outputPath = path.join(workDir, 'result.json');
    fs.writeFileSync(schemaPath, `${JSON.stringify(RESULT_SCHEMA, null, 2)}\n`, 'utf8');
    return {
      bin,
      args: [
        ...prefixArgs, 'exec',
        '--cd', repoPath,
        '--sandbox', writeCapable ? 'workspace-write' : 'read-only',
        '--output-schema', schemaPath,
        '--output-last-message', outputPath,
        '--color', 'never',
        ...modelArgs,
        '-',
      ],
      input: prompt,
      readResult() {
        if (!fs.existsSync(outputPath)) throw new HostError('codex produced no structured result');
        return extractResult('codex', fs.readFileSync(outputPath, 'utf8'));
      },
    };
  }

  if (name === 'claude') {
    return {
      bin,
      args: [
        ...prefixArgs, '-p',
        '--output-format', 'json',
        '--json-schema', schemaJson,
        // plan mode lets the model read and answer but not edit or run commands.
        '--permission-mode', writeCapable ? 'acceptEdits' : 'plan',
        '--no-session-persistence',
        ...modelArgs,
      ],
      input: prompt,
      readResult: stdout => extractResult('claude', stdout),
    };
  }

  // grok reads a single-turn prompt from a file, which keeps the prompt out
  // of the process list and clear of argument length limits.
  const promptPath = path.join(workDir, 'prompt.md');
  fs.writeFileSync(promptPath, prompt, 'utf8');
  return {
    bin,
    args: [
      ...prefixArgs,
      '--prompt-file', promptPath,
      '--json-schema', schemaJson,
      '--output-format', 'json',
      '--cwd', repoPath,
      '--permission-mode', writeCapable ? 'acceptEdits' : 'plan',
      '--no-subagents',
      ...modelArgs,
    ],
    input: '',
    readResult: stdout => extractResult('grok', stdout),
  };
}

/** Reports which host CLIs are installed. Never starts a model turn. */
export function probeHosts() {
  return HOST_NAMES.map(name => {
    try {
      const { bin, prefixArgs } = binFor(name);
      const run = spawnSync(bin, [...prefixArgs, '--version'], {
        encoding: 'utf8', timeout: 20000, windowsHide: true, shell: false,
      });
      if (run.error) throw new Error(run.error.code === 'ENOENT' ? `${name} is not installed or not on PATH` : run.error.message);
      const version = `${run.stdout || ''}${run.stderr || ''}`.trim().split(/\r?\n/)[0];
      return { name, installed: run.status === 0, version: run.status === 0 ? version : null, login: loginHint(name) };
    } catch (err) {
      return { name, installed: false, version: null, error: err.message, login: loginHint(name) };
    }
  });
}
