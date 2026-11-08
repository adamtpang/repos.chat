import fs from 'node:fs';
import path from 'node:path';
import { CodexConnection } from './codex-connection.mjs';
import { snapshot, checkout } from './queue-store.mjs';

export const chapterSchema = {
  type:'object',additionalProperties:false,required:['recap','paths'],properties:{
    recap:{type:'string',description:'In first person, briefly explain the work actually completed, its verification, and any blocker. Do not claim unperformed work.'},
    paths:{type:'array',minItems:3,maxItems:3,items:{type:'object',additionalProperties:false,required:['title','description','prompt'],properties:{
      title:{type:'string',description:'A short concrete next action, specific to this result.'},
      description:{type:'string',description:'One sentence describing its expected outcome and tradeoff.'},
      prompt:{type:'string',description:'A self-contained bounded follow-up prompt the human can edit and approve. Recommend a distinct path. Never treat it as already authorized.'},
    }}},
  },
};
// Explicit normalization of app-server evidence into the existing queue contract.
// The original provider response remains attached to every delivery reconciliation.
export const SOURCES={codex:'codex-app-server',claude:'claude-session'};
export function nativeEvidence(thread,kind='codex') {
  return {thread:{...thread,kind,hostId:'local',title:thread.name || thread.preview || path.basename(thread.cwd)},page:{order:'newest_first'},turns:[...(thread.turns||[])].reverse(),nativeSource:SOURCES[kind],nativeThread:thread};
}
export class LocalBridge {
  constructor(queue,{connection=new CodexConnection(),bindings=[],interval=2000}={}) {
    this.queue=queue;this.connection=connection;this.bindings=bindings;this.interval=interval;this.owned=new Set();this.busy=false;this.stopped=false;
    this.kind=connection.kind || 'codex';
    this.status={connected:false,provider:SOURCES[this.kind],sessions:{}};this.permissions=new Map();
  }
  async start() {
    this.connection.on('disconnect',error=>{this.status.connected=false;this.status.error=error.message;});
    this.connection.on('permission',message=>{
      const id=message.params?.threadId;
      if(!this.owned.has(id)) {this.connection.write({id:message.id,error:{code:-32601,message:'Session not owned by this bridge'}});return;}
      // Keep the provider request pending. No implicit allow or permission downgrade.
      this.permissions.set(message.id,message);
      Object.assign(this.status.sessions[id],{permission:{id:message.id,method:message.method,details:message.params},state:'needs permission'});
    });
    this.connection.on('notification',message=>{
      const id=message.params?.threadId;if(!this.owned.has(id))return;
      if(message.method==='item/agentMessage/delta') this.status.sessions[id].progress=(this.status.sessions[id].progress || '')+message.params.delta;
      if(message.method==='turn/started') Object.assign(this.status.sessions[id],{state:'working',progress:''});
      if(message.method==='turn/completed') {this.status.sessions[id].state='returned';this.status.sessions[id].progress='';}
    });
    await this.connection.connect();this.status.connected=true;
    for(const binding of this.bindings) {
      this.status.sessions[binding.threadId]={state:'connecting'};
      try {
        // Read identity before resume; do not override cwd, model, instructions or permissions.
        const read=await this.connection.request('thread/read',{threadId:binding.threadId,includeTurns:false});
        if(JSON.stringify(checkout(read.thread.cwd))!==JSON.stringify(checkout(binding.cwd)))throw new Error('Session checkout does not match its binding');
        // Native writer lease is authoritative across desktop and bridge processes.
        const resumed=await this.connection.request('thread/resume',{threadId:binding.threadId});
        if(resumed.thread.id!==binding.threadId)throw new Error('Provider resumed a different session');
        this.owned.add(binding.threadId);this.status.sessions[binding.threadId].state='connected';
        await this.refresh(binding);
      }catch(error){this.status.sessions[binding.threadId]={state:'unavailable',error:error.message};}
    }
    await this.tick();this.timer=setInterval(()=>this.tick(),this.interval);
  }
  async read(threadId) {
    const {thread}=await this.connection.request('thread/read',{threadId,includeTurns:true});
    if(thread.historyMode==='paginated') {
      const page=await this.connection.request('thread/turns/list',{threadId,limit:10,sortDirection:'desc',itemsView:'full'});
      thread.turns=[...page.data].reverse();
    }
    return nativeEvidence(thread,this.kind);
  }
  async refresh(binding) {
    const evidence=await this.read(binding.threadId);
    const card={...snapshot(evidence,binding.cwd),provider:SOURCES[this.kind],source:this.kind==='claude'?'claude session file':'codex app-server thread/read',bridgeBound:true};
    const old=this.queue.state().cards.find(c=>c.id===card.id);
    if(!old || old.revision!==card.revision || old.result!==card.result || Date.now()-Date.parse(old.observedAt)>30000)this.queue.ingest(card);
    return {card,evidence};
  }
  async tick() {
    if(this.busy || this.stopped || !this.status.connected)return;this.busy=true;
    try{
      for(const binding of this.bindings) {
        if(!this.owned.has(binding.threadId))continue;
        try{
          const {card,evidence}=await this.refresh(binding);
          const requests=this.queue.state().requests.filter(r=>r.threadId===binding.threadId && r.status!=='cancelled');
          for(const request of requests) {
            if(request.status==='uncertain') {
              try{this.queue.reconcile(request.id,evidence);this.status.sessions[binding.threadId].error=null;}catch{ /* Read-back only; never resend an uncertain turn. */ }
            }
          }
          const approved=requests.find(r=>r.status==='approved');
          if(!approved || this.permissions.size)continue;
          // Always persist a fresh snapshot immediately before the atomic claim.
          this.queue.ingest(card);
          const claim=this.queue.claim(approved.id);
          const response=await this.connection.request('turn/start',{threadId:binding.threadId,input:[{type:'text',text:claim.arguments.prompt,text_elements:[]}],clientUserMessageId:claim.receiptId,outputSchema:chapterSchema});
          this.queue.recordResponse(approved.id,claim.receiptId,response);
          this.status.sessions[binding.threadId].state='working';
        }catch(error){this.status.sessions[binding.threadId].error=error.message;}
      }
    }finally{this.busy=false;}
  }
  async interrupt(threadId) {
    if(!this.owned.has(threadId))throw new Error('Session is not owned by this bridge');
    const evidence=await this.read(threadId),turn=evidence.turns.find(t=>t.status==='inProgress');
    if(!turn)throw new Error('No active turn');
    return this.connection.request('turn/interrupt',{threadId,turnId:turn.id});
  }
  denyPermission(id) {
    const message=this.permissions.get(id);if(!message)throw new Error('Permission request is no longer pending');
    // First slice exposes denial only. Approving arbitrary provider actions needs
    // typed forms for every request variant; unknown requests stay paused.
    const results={'item/commandExecution/requestApproval':{decision:'decline'},'item/fileChange/requestApproval':{decision:'decline'}};
    if(!results[message.method])throw new Error('This request type requires a provider-specific control');
    this.connection.respond(id,results[message.method]);this.permissions.delete(id);delete this.status.sessions[message.params.threadId].permission;
  }
  async release() {
    if(this.busy)throw new Error('Bridge is refreshing; try again in a moment');
    this.stopped=true;
    try{for(const binding of this.bindings){if(!this.owned.has(binding.threadId))continue;const evidence=await this.read(binding.threadId);if(evidence.turns.some(t=>t.status==='inProgress'))throw new Error('Stop the active step before disconnecting');}}
    catch(e){this.stopped=false;throw e;}
    this.stop();
  }
  stop(){this.stopped=true;this.status.connected=false;clearInterval(this.timer);this.connection.close();}
}

export function bridgeBindings(root) {
  const file=path.resolve(root,'.repo-connect/bridge-bindings.json');
  if(!fs.existsSync(file))return [];
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!Array.isArray(data) || data.some(b=>typeof b.threadId!=='string'||!path.isAbsolute(b.cwd)||!(b.host===undefined||b.host in SOURCES)) || new Set(data.map(b=>b.threadId)).size!==data.length)throw new Error('Invalid bridge bindings');
  return data;
}
