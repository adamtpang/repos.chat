// Stands in for `claude -p --resume ID --input-format stream-json --output-format
// stream-json` in bridge tests. Usage: node fake-claude-session.mjs HOME MODE ...flags.
// Like the real CLI, it stores the stream-json user message under the uuid it was
// given and records a --json-schema result as a StructuredOutput tool call.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const [home, mode, ...args] = process.argv.slice(2);
const id = args[args.indexOf('--resume') + 1];
if (!args.includes('-p') || !id || !args.includes('--json-schema')) process.exit(2);
fs.appendFileSync(path.join(home, 'spawns.log'), `${id}\n`);

let input = '';
for await (const chunk of process.stdin) input += chunk;
const message = JSON.parse(input.trim());
const projects = path.join(home, 'projects');
const file = fs.readdirSync(projects).map(dir => path.join(projects, dir, `${id}.jsonl`)).find(f => fs.existsSync(f));
const at = () => new Date().toISOString();
const write = entry => fs.appendFileSync(file, `${JSON.stringify({ sessionId: id, cwd: process.cwd(), timestamp: at(), ...entry })}\n`);

if (mode !== 'crash-before-init') process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: id })}\n`);
write({ type: 'user', uuid: message.uuid, message: message.message });
const chapter = { recap: 'I verified the fictional orchard.', paths: ['Check', 'Plan', 'Explore'].map(title => ({ title, description: 'A bounded choice', prompt: `${title} locally` })) };
const call = randomUUID();
write({ type: 'assistant', uuid: randomUUID(), message: { content: [{ type: 'tool_use', id: call, name: 'StructuredOutput', input: chapter }] } });
write({ type: 'user', uuid: randomUUID(), message: { content: [{ type: 'tool_result', tool_use_id: call, content: 'Structured output provided successfully' }] } });
if (mode === 'crash-before-init') process.exit(1);
process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: id, structured_output: chapter })}\n`);
