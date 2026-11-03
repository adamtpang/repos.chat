import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {EventEmitter} from 'node:events';
import {Queue,gitBin} from '../queue-store.mjs';import {LocalBridge,chapterSchema} from '../local-bridge.mjs';import {chapterFor} from '../queue-ui/story.mjs';
function setup(t,{lost=false,ownedElsewhere=false}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'repo-bridge-'));execFileSync(gitBin,['init','-q',root]);
 const initial={id:'old',status:'completed',startedAt:Date.now()/1000,completedAt:Date.now()/1000,items:[{type:'agentMessage',phase:'final_answer',text:'Previous result'}]};
 const thread={id:'test-session',name:'Fictional orchard',cwd:root,status:{type:'idle'},turns:[initial]};
 class Fake extends EventEmitter {
  sends=0;responses=[];async connect(){}close(){}
  respond(id,result){this.responses.push({id,result});}write(){}
  async request(method,p){
   if(method==='thread/resume' && ownedElsewhere)throw new Error('already has an active writer');
   if(method==='thread/read'||method==='thread/resume')return {thread:structuredClone(thread)};
   if(method==='turn/start') {this.sends++;assert.deepEqual(p.outputSchema,chapterSchema);thread.status={type:'active'};thread.turns.push({id:'new',startedAt:Date.now()/1000,status:'inProgress',items:[{type:'userMessage',clientId:p.clientUserMessageId,content:p.input}]});if(lost)throw new Error('lost response');return {turn:{id:'new'}};}
   throw new Error('Unexpected method '+method);
  }
 }
 const connection=new Fake(),queue=new Queue(root),bridge=new LocalBridge(queue,{connection,bindings:[{threadId:thread.id,cwd:root}],interval:999999});
 t.after(()=>{bridge.stop();fs.rmSync(root,{recursive:true,force:true});});
 const approve=()=>{const card=queue.view().cards[0];const d=queue.draft(card.id,{prompt:'Verify the orchard locally.',decision:'Verify',importance:1,urgency:0,reason:'Owner direction',dependencies:[]});return queue.approve(card.id,d.id,d.prompt,card.threadId);};
 return {bridge,queue,connection,thread,approve};
}
test('bridge automatically delivers once and imports the exact result into the same session',async t=>{
 const f=setup(t);await f.bridge.start();const r=f.approve();await f.bridge.tick();await f.bridge.tick();assert.equal(f.connection.sends,1);assert.equal(f.queue.state().requests[0].status,'accepted');
 f.thread.status={type:'idle'};Object.assign(f.thread.turns[1],{status:'completed',completedAt:Date.now()/1000});f.thread.turns[1].items.push({type:'agentMessage',phase:'final_answer',text:'Verified result'});await f.bridge.tick();
 const card=f.queue.view().cards[0];assert.equal(card.result,'Verified result');assert.equal(card.returned,true);assert.equal(card.request.id,r.id);assert.equal(card.threadId,'test-session');
});
test('lost native response is reconciled by receipt client ID without retry',async t=>{
 const f=setup(t,{lost:true});await f.bridge.start();f.approve();await f.bridge.tick();assert.equal(f.queue.state().requests[0].status,'uncertain');
 const item=f.thread.turns[1].items[0],real=item.clientId;item.clientId='wrong';await f.bridge.tick();assert.equal(f.queue.state().requests[0].status,'uncertain');item.clientId=real;await f.bridge.tick();assert.equal(f.queue.state().requests[0].status,'accepted');assert.equal(f.connection.sends,1);
});
test('existing native writer prevents bridge ownership and ingestion',async t=>{
 const f=setup(t,{ownedElsewhere:true});await f.bridge.start();assert.equal(f.bridge.owned.size,0);assert.equal(f.queue.view().cards.length,0);assert.match(f.bridge.status.sessions['test-session'].error,/active writer/);assert.equal(f.connection.sends,0);
});
test('provider permission requests stay pending until explicit denial',async t=>{
 const f=setup(t);await f.bridge.start();f.connection.emit('permission',{id:12,method:'item/commandExecution/requestApproval',params:{threadId:'test-session',command:'fictional command'}});assert.equal(f.connection.responses.length,0);assert.equal(f.bridge.permissions.size,1);f.bridge.denyPermission(12);assert.deepEqual(f.connection.responses,[{id:12,result:{decision:'decline'}}]);
});
test('chapter data needs three complete editable paths',()=>{
 assert.equal(chapterFor({result:'{"recap":"Done","paths":[]}'}),null);
 const data={recap:'Verified a fictional result',paths:['Check','Plan','Explore'].map(title=>({title,description:'A bounded choice',prompt:'Review locally'}))};assert.deepEqual(chapterFor({result:JSON.stringify(data)}),data);
});
