#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Queue, snapshot, checkout } from './queue-store.mjs';
import { CodexConnection } from './codex-connection.mjs';
import { ClaudeConnection } from './claude-connection.mjs';
import { serve } from './queue-server.mjs';
import { LocalBridge, bridgeBindings, SOURCES } from './local-bridge.mjs';
import {DesktopSubmitter} from './desktop-submit.mjs';

const connectionFor = host => host === 'claude' ? new ClaudeConnection() : new CodexConnection();

export async function main(args = process.argv.slice(2)) {
  const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i+1]; };
  const root = path.resolve(option('root', process.cwd()));
  const queue = new Queue(root);
  const file = () => JSON.parse(fs.readFileSync(option('file'), 'utf8'));
  let result;
  switch (args[0]) {
    case 'bind': {
      const threadId=option('thread'),cwd=option('checkout'),host=option('host','codex');
      if(!threadId || !cwd)throw new Error('bind requires --thread EXACT_ID --checkout ABSOLUTE_PATH [--host codex|claude]');
      if(!(host in SOURCES))throw new Error('--host must be codex or claude');
      if(fs.existsSync(path.resolve(root,'.repo-connect/bridge.lock')))throw new Error('Stop the bridge before changing session bindings');
      const connection=connectionFor(host);
      try{
        await connection.connect();const read=await connection.request('thread/read',{threadId,includeTurns:false});
        const identity=checkout(cwd);if(read.thread.id!==threadId || JSON.stringify(checkout(read.thread.cwd))!==JSON.stringify(identity))throw new Error('Existing session and exact checkout must match');
        const bindings=bridgeBindings(root).filter(b=>b.threadId!==threadId);bindings.push({threadId,cwd:identity.cwd,...(host==='claude'?{host}:{})});
        const target=path.resolve(root,'.repo-connect/bridge-bindings.json'),temp=target+'.tmp';
        fs.writeFileSync(temp,JSON.stringify(bindings,null,2),{mode:0o600});fs.renameSync(temp,target);result={bound:threadId,cwd:identity.cwd,note:host==='claude'?'Start with --bridge. A session open in another live Claude process is refused on connection and before every turn.':'Start with --bridge. Native writer ownership is checked on connection.'};
      }finally{connection.close();}
      break;
    }
    case 'import': result = queue.ingest(snapshot(file(), option('checkout'), option('observed-at'))); break;
    case 'draft': result = queue.draft(option('card'), file()); break;
    case 'claim': result = queue.claim(option('request')); break;
    case 'record-response': result = queue.recordResponse(option('request'), option('receipt'), file(), option('sender-thread', null)); break;
    case 'reconcile': result = queue.reconcile(option('request'), file()); break;
    case 'show': result = queue.view(); break;
    case 'serve': {
      if(args.includes('--desktop') && args.includes('--bridge'))throw new Error('Choose desktop submission or exclusive bridge, not both.');
      let bridge,lock;
      if(args.includes('--bridge')) {
        const bindings=bridgeBindings(root),hosts=new Set(bindings.map(b=>b.host || 'codex'));
        // One bridge drives one provider's sessions.
        if(hosts.size>1)throw new Error('Bindings mix Codex and Claude sessions; give each host its own --root');
        lock=path.resolve(root,'.repo-connect/bridge.lock');
        const fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));fs.closeSync(fd);
        bridge=new LocalBridge(queue,{bindings,connection:connectionFor([...hosts][0])});
        try{await bridge.start();}catch(e){bridge.stop();fs.unlinkSync(lock);throw e;}
        const cleanup=()=>{bridge.stop();if(fs.existsSync(lock))fs.unlinkSync(lock);};
        process.once('exit',cleanup);for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>process.exit(0));
      }
      let server;
      try{server = await serve(queue, Number(option('port', 4317)), bridge,args.includes('--desktop')?new DesktopSubmitter(queue):null);}catch(e){bridge?.stop();if(lock && fs.existsSync(lock))fs.unlinkSync(lock);throw e;}
      console.log(`Private queue: http://127.0.0.1:${server.address().port}/#${server.queueToken}`);
      return;
    }
    default: console.log('repos-queue serve|show|bind|import|draft|claim|record-response|reconcile --root DIR\nbind requires --thread EXACT_ID --checkout ABSOLUTE_PATH, plus --host claude for a Claude Code session.\nImport requires --file READ_THREAD_JSON --checkout VERIFIED_REPO. Draft requires --card ID --file JSON.\nApproval occurs only in the local UI. claim requires --request ID and fresh imported state.\nClaim outputs one supported tool call for the active Codex task relay; it never invokes a model or starts a session.\nRecord-response/reconcile require --request ID --file JSON. Record-response also requires --receipt ID. Uncertain attempts are never retried.'); return;
  }
  console.log(JSON.stringify(result ?? { ok: true }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
