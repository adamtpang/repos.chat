import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {Queue,gitBin} from '../queue-store.mjs';import {LocalBridge,bridgeBindings} from '../local-bridge.mjs';import {ClaudeConnection} from '../claude-connection.mjs';import {chapterFor} from '../queue-ui/story.mjs';
const fixture=fileURLToPath(new URL('../fixtures/fake-claude-session.mjs',import.meta.url));
const ID='0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
function setup(t,{mode='ok'}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bridge-'));execFileSync(gitBin,['init','-q',root]);
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'claude-home-'));fs.mkdirSync(path.join(home,'projects','fictional-orchard'),{recursive:true});fs.mkdirSync(path.join(home,'sessions'));
 const file=path.join(home,'projects','fictional-orchard',`${ID}.jsonl`),at=new Date(Date.now()-60000).toISOString();
 fs.writeFileSync(file,[
  {type:'user',uuid:'u-old',sessionId:ID,cwd:root,timestamp:at,message:{role:'user',content:'Plant the fictional orchard.'}},
  {type:'assistant',uuid:'a-old',sessionId:ID,cwd:root,timestamp:at,message:{content:[{type:'text',text:'Previous result'}]}},
 ].map(e=>JSON.stringify(e)).join('\n')+'\n');
 const connection=new ClaudeConnection({command:process.execPath,args:[fixture,home,mode],home,timeout:10000});
 const queue=new Queue(root),bridge=new LocalBridge(queue,{connection,bindings:[{threadId:ID,cwd:root,host:'claude'}],interval:999999});
 t.after(()=>{bridge.stop();fs.rmSync(root,{recursive:true,force:true});fs.rmSync(home,{recursive:true,force:true});});
 const approve=()=>{const card=queue.view().cards[0];const d=queue.draft(card.id,{prompt:'Verify the orchard locally.',decision:'Verify',importance:1,urgency:0,reason:'Owner direction',dependencies:[]});return queue.approve(card.id,d.id,d.prompt,card.threadId);};
 const spawns=()=>fs.existsSync(path.join(home,'spawns.log'))?fs.readFileSync(path.join(home,'spawns.log'),'utf8').trim().split('\n').length:0;
 const idle=async()=>{for(let i=0;i<200 && connection.runs.size;i++)await new Promise(r=>setTimeout(r,25));};
 const writer=status=>fs.writeFileSync(path.join(home,'sessions',`${process.pid}.json`),JSON.stringify({pid:process.pid,sessionId:ID,status,entrypoint:'claude-desktop'}));
 return {bridge,queue,connection,file,home,approve,spawns,idle,writer};
}
test('bridge continues a bound Claude session once and imports its structured chapter',async t=>{
 const f=setup(t);await f.bridge.start();
 const card=f.queue.view().cards[0];assert.equal(card.id,`claude:local:${ID}`);assert.equal(card.result,'Previous result');assert.equal(card.provider,'claude-session');
 const r=f.approve();await f.bridge.tick();await f.idle();await f.bridge.tick();
 assert.equal(f.spawns(),1);const request=f.queue.state().requests[0];assert.equal(request.status,'accepted');
 // The receipt is the stored message's own uuid, so read-back proves this exact delivery.
 const stored=fs.readFileSync(f.file,'utf8').trim().split('\n').map(JSON.parse).find(e=>e.message?.content==='Verify the orchard locally.');
 assert.equal(stored.uuid,request.receiptId);assert.equal(request.turnId,request.receiptId);
 const after=f.queue.view().cards[0];assert.equal(after.returned,true);assert.equal(after.request.id,r.id);
 assert.equal(chapterFor(after).recap,'I verified the fictional orchard.');
});
test('a lost start is reconciled by receipt uuid and never resent',async t=>{
 const f=setup(t,{mode:'crash-before-init'});await f.bridge.start();f.approve();
 await f.bridge.tick();await f.idle();assert.match(f.bridge.status.sessions[ID].error,/before the turn started/);
 const lines=fs.readFileSync(f.file,'utf8');
 // Same text under another uuid is not this delivery.
 fs.writeFileSync(f.file,lines.replace(f.queue.state().requests[0].receiptId,'11111111-2222-4333-8444-555555555555'));
 await f.bridge.tick();assert.equal(f.queue.state().requests[0].status,'uncertain');
 fs.writeFileSync(f.file,lines);await f.bridge.tick();
 assert.equal(f.queue.state().requests[0].status,'accepted');assert.equal(f.spawns(),1);
});
test('a live Claude process holding the session blocks ownership',async t=>{
 const f=setup(t);f.writer('idle');await f.bridge.start();
 assert.equal(f.bridge.owned.size,0);assert.equal(f.queue.view().cards.length,0);assert.match(f.bridge.status.sessions[ID].error,/active writer/);
});
test('a writer that opens the session after approval stops dispatch',async t=>{
 const f=setup(t);await f.bridge.start();f.approve();f.writer('busy');
 await f.bridge.tick();assert.equal(f.spawns(),0);assert.equal(f.queue.state().requests[0].status,'approved');
 assert.equal(f.queue.view().cards[0].state,'running');
});
test('session parsing skips tool results, meta, sidechains and command echoes, and marks interrupts',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'claude-home-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const dir=path.join(home,'projects','x');fs.mkdirSync(dir,{recursive:true});const ts=new Date().toISOString();
 fs.writeFileSync(path.join(dir,`${ID}.jsonl`),[
  {type:'user',uuid:'u1',cwd:home,timestamp:ts,message:{content:'First'}},
  {type:'assistant',uuid:'a1',timestamp:ts,message:{content:[{type:'text',text:'Working'},{type:'tool_use',id:'t',name:'Bash',input:{}}]}},
  {type:'user',uuid:'r1',timestamp:ts,message:{content:[{type:'tool_result',tool_use_id:'t',content:'ok'}]}},
  {type:'user',uuid:'m1',isMeta:true,timestamp:ts,message:{content:'meta'}},
  {type:'user',uuid:'s1',isSidechain:true,timestamp:ts,message:{content:'side'}},
  {type:'user',uuid:'c1',timestamp:ts,message:{content:'<command-name>/clear</command-name>'}},
  {type:'assistant',uuid:'a2',timestamp:ts,message:{content:[{type:'text',text:'Done'}]}},
  {type:'user',uuid:'u2',timestamp:ts,message:{content:'Second'}},
  {type:'user',uuid:'i2',timestamp:ts,message:{content:[{type:'text',text:'[Request interrupted by user]'}]}},
 ].map(e=>JSON.stringify(e)).join('\n')+'\nnot json\n');
 const c=new ClaudeConnection({command:process.execPath,home});const thread=c.read(ID);
 assert.deepEqual(thread.turns.map(x=>[x.id,x.status]),[['u1','completed'],['u2','interrupted']]);
 assert.deepEqual(thread.turns[0].items.map(x=>[x.type,x.text||x.clientId,x.phase]),[['userMessage','u1',undefined],['agentMessage','Working',undefined],['agentMessage','Done','final_answer']]);
 assert.equal(thread.status.type,'idle');
 assert.throws(()=>c.read('../../etc/passwd'),/UUIDs/);
});
test('bindings accept a Claude host and refuse unknown hosts',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bind-'));fs.mkdirSync(path.join(root,'.repo-connect'));
 try{
  const write=data=>fs.writeFileSync(path.join(root,'.repo-connect','bridge-bindings.json'),JSON.stringify(data));
  write([{threadId:ID,cwd:root,host:'claude'}]);assert.equal(bridgeBindings(root)[0].host,'claude');
  write([{threadId:ID,cwd:root,host:'gemini'}]);assert.throws(()=>bridgeBindings(root),/Invalid bridge bindings/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
