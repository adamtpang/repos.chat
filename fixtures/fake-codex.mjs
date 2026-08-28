import fs from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex === -1 || !args[outputIndex + 1]) process.exit(2);
const sandboxIndex = args.indexOf('--sandbox');
if (process.env.EXPECT_SANDBOX && args[sandboxIndex + 1] !== process.env.EXPECT_SANDBOX) process.exit(4);

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (!prompt.includes('Incoming repos.chat request')) process.exit(3);

if (process.env.FAKE_DESCENDANT_MARKER) {
  const markerDelay = Math.max(0, Number(process.env.FAKE_DESCENDANT_MARKER_DELAY_MS || 1500));
  const markerScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(process.env.FAKE_DESCENDANT_MARKER)}, 'orphaned'), ${markerDelay})`;
  const descendant = spawn(process.execPath, ['-e', markerScript], {
    stdio: 'ignore',
    windowsHide: true,
    detached: process.env.FAKE_DESCENDANT_DETACHED === '1',
  });
  descendant.unref();
  if (process.env.FAKE_DESCENDANT_READY) {
    fs.writeFileSync(process.env.FAKE_DESCENDANT_READY, 'spawned');
  }
}
if (process.env.FAKE_DELAY_MS) {
  await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_DELAY_MS)));
}

const result = {
  outcome: 'completed',
  summary: process.env.FAKE_RESULT_SUMMARY || 'Handled by the fake test agent.',
  evidence: ['proof.txt'],
  tests: ['fake validation passed'],
  risks: [],
};
fs.writeFileSync(args[outputIndex + 1], `${JSON.stringify(result)}\n`, 'utf8');
