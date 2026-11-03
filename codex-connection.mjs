import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

// One private stdio connection. Never scans credentials, binds a provider port,
// takes over a writer lock, or retries a mutation after a timeout.
export class CodexConnection extends EventEmitter {
  constructor({ command, args, cwd, timeout = 30000 } = {}) {
    super();
    const launcher = process.env.APPDATA && path.join(process.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js');
    this.command = command || (launcher && fs.existsSync(launcher) ? process.execPath : 'codex');
    this.args = args || (launcher && fs.existsSync(launcher) ? [launcher, 'app-server', '--stdio'] : ['app-server', '--stdio']);
    this.cwd = cwd; this.timeout = timeout; this.pending = new Map(); this.nextId = 0; this.closed = true;
  }
  async connect() {
    if (this.child) throw new Error('Connection already started');
    this.child = spawn(this.command, this.args, { cwd: this.cwd, windowsHide: true, stdio: ['pipe','pipe','pipe'], shell:false });
    this.closed = false;
    this.child.stderr.on('data', chunk => this.emit('diagnostic', chunk.toString()));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('Codex connection closed; attempted work must be reconciled')));
    this.child.stdin.on('error', error => this.fail(error));
    this.lines = createInterface({ input:this.child.stdout });
    this.lines.on('line', line => {
      let message; try { message=JSON.parse(line); } catch { return this.fail(new Error('Invalid Codex protocol response')); }
      if (message.method) { this.emit(message.id == null ? 'notification' : 'permission',message); return; }
      const pending=this.pending.get(message.id); if(!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if(message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
    const result = await this.request('initialize',{clientInfo:{name:'repos_chat',title:'repos.chat',version:'0.1.0'},capabilities:{experimentalApi:true}});
    this.write({method:'initialized'}); return result;
  }
  write(message) { if(this.closed) throw new Error('Codex is disconnected'); this.child.stdin.write(JSON.stringify(message)+'\n'); }
  request(method,params={}) {
    if(this.closed) return Promise.reject(new Error('Codex is disconnected'));
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} timed out; do not automatically retry mutations`));},this.timeout);
      this.pending.set(id,{resolve,reject,timer});
      try {this.write({id,method,params});} catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  respond(id,result) {this.write({id,result});}
  fail(error) { if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('disconnect',error); }
  close() {this.fail(new Error('Connection stopped'));this.lines?.close();this.child?.stdin.end();this.child?.kill();}
}
