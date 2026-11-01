// Stands in for `claude -p --output-format json --json-schema ...` in tests.
// Mirrors the real CLI's wrapper: the schema-constrained object arrives under
// structured_output, and failures arrive as is_error with the reason in result.
const args = process.argv.slice(2);
if (!args.includes('-p') || !args.includes('--json-schema')) process.exit(2);

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

if (process.env.FAKE_CLAUDE_AUTH_ERROR) {
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    is_error: true,
    result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
  })}\n`);
  process.exit(1);
}
if (!prompt.includes('Incoming repos.chat request')) process.exit(3);

const readOnly = args[args.indexOf('--permission-mode') + 1] === 'plan';
process.stdout.write(`${JSON.stringify({
  type: 'result',
  is_error: false,
  structured_output: {
    outcome: 'completed',
    summary: `Answered by the fake Claude agent${readOnly ? ' in read-only mode' : ''}. Saw history: ${prompt.includes('Earlier messages in this conversation')}.`,
    evidence: ['proof.txt'],
    tests: [],
    risks: [],
  },
})}\n`);
