import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { journalEntries } from './queue-ui/adventure.mjs';
import {rankedCards,eligible} from './queue-ui/briefing.mjs';

export async function serve(queue, port = 4317, bridge = null, desktop = null) {
  const token = randomBytes(32).toString('hex');
  const assets = new Map([
    ['/', [new URL('./queue-ui/index.html', import.meta.url), 'text/html']],
    ['/app.js', [new URL('./queue-ui/app.js', import.meta.url), 'text/javascript']],
    ['/story.mjs', [new URL('./queue-ui/story.mjs', import.meta.url), 'text/javascript']],
    ['/adventure.mjs', [new URL('./queue-ui/adventure.mjs', import.meta.url), 'text/javascript']],
    ['/briefing.mjs', [new URL('./queue-ui/briefing.mjs', import.meta.url), 'text/javascript']],
    ['/style.css', [new URL('./queue-ui/style.css', import.meta.url), 'text/css']],
  ]);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return json(403, { error: 'Local origin required' });
    const asset = assets.get(req.url);
    if (req.method === 'GET' && asset) { res.writeHead(200, { 'Content-Type': asset[1] }); res.end(fs.readFileSync(asset[0])); return; }
    const provided = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(401, { error: 'Open the private launch link from the local terminal' });
    try {
      if (req.method === 'GET' && req.url === '/api/queue') {
        const view=queue.view(),file=path.resolve(queue.root,'../adventure-scenes.json');
        const scenes=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
        view.cards=view.cards.map(card=>({...card,adventure:scenes[card.id]?.revision===card.revision && scenes[card.id]?.sourceResult===card.result ? scenes[card.id].chapter : null}));
        const briefingFile=path.resolve(queue.root,'../pet-briefings.json');
        const briefings=fs.existsSync(briefingFile)?JSON.parse(fs.readFileSync(briefingFile,'utf8')):{};
        view.cards=rankedCards(view.cards.map(card=>{
          const entry=briefings.cards?.[card.id];
          const valid=entry?.revision===card.revision;
          return {...card,briefing:valid?entry.briefing:null,priorityContext:valid?entry.priority:null,adventure:valid && entry.chapter?entry.chapter:card.adventure};
        }));
        view.current=view.cards.find(eligible)||null;
        view.priorityNote=briefings.note || null;
        return json(200, {...view,journal:journalEntries(queue.events()),bridge:bridge?.status || null,desktop:desktop?{enabled:true}:null});
      }
      if (req.method !== 'POST' || !['/api/draft', '/api/approve', '/api/cancel','/api/interrupt','/api/deny-permission','/api/bridge/stop','/api/desktop-send'].includes(req.url)) return json(404, { error: 'Not found' });
      if (req.headers['content-type'] !== 'application/json' || req.headers.origin !== origin) return json(403, { error: 'Same-origin JSON required' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 40000) return json(413, { error: 'Body too large' }); }
      const p = JSON.parse(body);
      if(req.url==='/api/desktop-send'){if(!desktop)throw new Error('Immediate desktop submission is not enabled.');return json(200,await desktop.send(p));}
      if(req.url==='/api/bridge/stop'){if(!bridge)throw new Error('Local bridge is not connected');await bridge.release();json(200,{ok:true});server.close();return;}
      if (req.url === '/api/interrupt') { if(!bridge)throw new Error('Local bridge is not connected');return json(200,{ok:true,result:await bridge.interrupt(p.threadId)}); }
      if (req.url === '/api/deny-permission') { if(!bridge)throw new Error('Local bridge is not connected');bridge.denyPermission(p.id);return json(200,{ok:true}); }
      if (req.url === '/api/cancel') return json(200, { ok: true, result: queue.cancel(p.requestId) });
      return json(200, req.url === '/api/draft' ? queue.draft(p.cardId, p) : queue.approve(p.cardId, p.draftId, p.prompt, p.destination));
    } catch (e) { return json(409, { error: e.message }); }
  });
  server.queueToken = token;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
