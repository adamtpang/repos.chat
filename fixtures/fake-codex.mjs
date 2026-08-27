import fs from 'node:fs';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex === -1 || !args[outputIndex + 1]) process.exit(2);

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (!prompt.includes('Incoming repos.chat request')) process.exit(3);

const result = {
  outcome: 'completed',
  summary: 'Handled by the fake test agent.',
  evidence: ['proof.txt'],
  tests: ['fake validation passed'],
  risks: [],
};
fs.writeFileSync(args[outputIndex + 1], `${JSON.stringify(result)}\n`, 'utf8');
