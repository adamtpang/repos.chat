// Stands in for `grok --prompt-file FILE --json-schema ... --output-format json`
// in tests. The prompt comes from a file rather than stdin, and the
// schema-constrained answer is emitted as a JSON string under result, the most
// indirect shape the adapter accepts.
import fs from 'node:fs';

const args = process.argv.slice(2);
const promptFile = args[args.indexOf('--prompt-file') + 1];
if (!promptFile || !args.includes('--json-schema') || !args.includes('--cwd')) process.exit(2);

const prompt = fs.readFileSync(promptFile, 'utf8');
if (!prompt.includes('Incoming repos.chat request')) process.exit(3);

process.stdout.write(`${JSON.stringify({
  type: 'result',
  result: JSON.stringify({
    outcome: 'blocked',
    summary: 'The fake Grok agent needs the sender to name the target file.',
    evidence: [],
    tests: [],
    risks: ['request was ambiguous'],
  }),
})}\n`);
