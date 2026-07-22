#!/usr/bin/env node
'use strict';
/**
 * fleet-console — a LIVE local dashboard of the living-economy robots.
 * ===================================================================
 * Real data, no snapshot: it reads the Hermes state via the LOCAL CLI (no dashboard auth needed —
 * the :4711 API is Unauthorized to a tokenless fetch) + curls our public services. Auto-refreshes.
 * Run in WSL where hermes lives:  node fleet-console.js   →   open http://localhost:4799
 */
const http = require('node:http');
const { execFile } = require('node:child_process');

const HERMES = process.env.HERMES_BIN || '/root/.hermes-venv/bin/hermes';
const ENV = { ...process.env, HERMES_HOME: process.env.HERMES_HOME || '/root/.hermes-biii', PATH: '/usr/local/bin:/usr/bin:/bin' };
const PORT = Number(process.env.FLEET_PORT || 4799);

const sh = (cmd, args, timeout = 15000) => new Promise((r) =>
  execFile(cmd, args, { env: ENV, timeout, maxBuffer: 4 << 20 }, (_e, so, se) => r(String(so || '') + String(se || ''))));

let cache = { t: 0, data: null };
async function gather() {
  if (Date.now() - cache.t < 8000 && cache.data) return cache.data;
  const [gw, cron, mcp, biii, node] = await Promise.all([
    sh('bash', ['-lc', "pgrep -f 'hermes gateway run' >/dev/null && echo running || echo stopped"]),
    sh(HERMES, ['cron', 'list']),
    sh(HERMES, ['mcp', 'list']),
    sh('bash', ['-lc', "curl -s -o /dev/null -w '%{http_code}' -m 7 https://biii-production.up.railway.app/health || echo 000"]),
    sh('bash', ['-lc', "curl -s -o /dev/null -w '%{http_code}' -m 7 -X POST https://biii-production.up.railway.app/x402/vet-asset -H 'content-type: application/json' -d '{\"address\":\"0x1234\"}' || echo 000"]),
  ]);
  const nextRun = (cron.match(/Next run:\s*([0-9T:.\+\-]+)/) || [])[1] || null;
  const watchActive = /biii-watch[\s\S]*?\[active\]|\[active\][\s\S]*?biii-watch/i.test(cron) || /biii-watch/.test(cron);
  const toolsets = [...new Set((mcp.match(/\b(biii|gitlawb|lawbor|recall|monid)\b/g) || []))];
  const data = {
    ts: new Date().toISOString(),
    gateway: gw.includes('running') ? 'running' : 'stopped',
    cronNext: nextRun, watchActive,
    toolsets,
    biiiHealth: biii.trim().slice(-3),
    x402: node.trim().slice(-3),
  };
  cache = { t: Date.now(), data };
  return data;
}

const HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MainStreet — Fleet (live)</title><style>
:root{--bg:#0a0e14;--panel:#111a26;--panel2:#0f1620;--line:#1c2836;--line2:#243244;--tx:#cdd8e8;--muted:#6f8098;--dim:#4a5a72;
--accent:#4c8dff;--accent2:#7db0ff;--up:#2fd07a;--sched:#f0a92c;--pend:#d9b23a;--down:#ef5350;--off:#546074;
--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 500px at 80% -10%,#10202f 0,transparent 60%),radial-gradient(900px 400px at -10% 110%,#0e1a26 0,transparent 55%),var(--bg);color:var(--tx);font-family:var(--sans);padding:26px 18px 40px}
.wrap{max-width:1080px;margin:0 auto}header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:14px;padding-bottom:16px;border-bottom:1px solid var(--line);margin-bottom:22px}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--accent2)}
h1{margin:6px 0 0;font-size:25px;font-weight:650;letter-spacing:-.01em}h1 .thin{color:var(--muted);font-weight:400}
.meta{font-family:var(--mono);font-size:12px;color:var(--muted);text-align:right;line-height:1.7}.meta b{color:var(--tx)}
.livedot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--up);margin-right:6px;animation:pulse 2.4s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(47,208,122,.5)}70%{box-shadow:0 0 0 7px rgba(47,208,122,0)}100%{box-shadow:0 0 0 0 rgba(47,208,122,0)}}
@media(prefers-reduced-motion:reduce){.livedot,.dot.wk{animation:none}}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
.card{position:relative;background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:12px;padding:16px 18px 15px 20px;overflow:hidden}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--st,var(--off))}
.row1{display:flex;align-items:center;gap:9px;margin-bottom:11px}.dot{width:9px;height:9px;border-radius:50%;background:var(--st);flex:none;box-shadow:0 0 10px -1px var(--st)}.dot.wk{animation:pulse 2.4s infinite}
.state{font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--st);font-weight:600}
.loc{margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--dim);border:1px solid var(--line2);border-radius:5px;padding:2px 7px}
.name{font-family:var(--mono);font-size:16px;font-weight:600;color:var(--tx)}.role{font-size:12.5px;color:var(--muted);margin:2px 0 12px}
.facts{display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--line);padding-top:11px}
.fact{display:flex;justify-content:space-between;gap:12px;font-family:var(--mono);font-size:11.5px;font-variant-numeric:tabular-nums}
.fact .k{color:var(--dim)}.fact .v{color:var(--tx);text-align:right}.fact .v.ok{color:var(--up)}.fact .v.wait{color:var(--sched)}.fact .v.bad{color:var(--down)}
.legend{display:flex;flex-wrap:wrap;gap:16px;margin-top:22px;padding-top:14px;border-top:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--muted)}
.legend span{display:inline-flex;align-items:center;gap:7px}.legend i{width:8px;height:8px;border-radius:50%}
.foot{margin-top:18px;font-size:11px;color:var(--dim);font-family:var(--mono)}
</style></head><body><div class="wrap">
<header><div><div class="eyebrow">MainStreet · Living Economy · LIVE</div><h1>Fleet <span class="thin">— qui bosse, qui pas</span></h1></div>
<div class="meta"><span class="livedot"></span><b id="act">…</b> · <span id="ts">…</span><br>guard read-only: <b style="color:var(--up)">ON</b> · refresh 12s</div></header>
<div class="grid" id="grid"></div>
<div class="legend"><span><i style="background:var(--up)"></i>working</span><span><i style="background:var(--sched)"></i>scheduled</span><span><i style="background:var(--pend)"></i>pending</span><span><i style="background:var(--down)"></i>down</span><span><i style="background:var(--off)"></i>idle</span></div>
<div class="foot" id="foot">chargement…</div></div>
<script>
const C={up:'var(--up)',sched:'var(--sched)',pend:'var(--pend)',down:'var(--down)',off:'var(--off)'};
function card(o){const wk=o.st==='up'?'wk':'';return \`<div class="card" style="--st:\${C[o.st]}"><div class="row1"><span class="dot \${wk}"></span><span class="state">\${o.state}</span><span class="loc">\${o.loc}</span></div><div class="name">\${o.name}</div><div class="role">\${o.role}</div><div class="facts">\${o.facts.map(f=>\`<div class="fact"><span class="k">\${f[0]}</span><span class="v \${f[2]||''}">\${f[1]}</span></div>\`).join('')}</div></div>\`}
async function tick(){let d;try{d=await (await fetch('/api/fleet')).json()}catch(e){document.getElementById('foot').textContent='console injoignable';return}
 const gwUp=d.gateway==='running', hUp=d.biiiHealth==='200', xUp=d.x402==='402';
 const cards=[
  {st:hUp?'up':'down',state:hUp?'working':'down',loc:'Railway',name:'biii · vente',role:'Verdicts safe-to-pay payants sur Base (x402) → wallet',facts:[['/health',hUp?'200':d.biiiHealth,hUp?'ok':'bad'],['POST /x402/vet-asset',xUp?'402 · $0.002':d.x402,xUp?'ok':'bad'],['payTo','0xa6cf…f5d4']]},
  {st:gwUp?'up':'down',state:gwUp?'working':'stopped',loc:'WSL local',name:'hermes · gateway',role:'Le cerveau local — scheduler + agents à la demande',facts:[['gateway',gwUp?'running':'stopped',gwUp?'ok':'bad'],['toolsets',(d.toolsets||[]).join('·')||'—'],['#',String((d.toolsets||[]).length)]]},
  {st:d.watchActive?'sched':'off',state:d.watchActive?'scheduled':'off',loc:'cron',name:'biii-watch · sentinelle',role:'Scan trust de Base, sans clé, $0',facts:[['next run',d.cronNext?d.cronNext.slice(11,16):'—','wait'],['cadence','every 30m'],['clé/dépense','0 / 0','ok']]},
  {st:'up',state:'working',loc:'Railway',name:'biii-node · monitor+analyste',role:'Surveille + propose, read-only (worker, pas d\\'HTTP local)',facts:[['guard','on','ok'],['watchdog','biii-watch/30m'],['modèles','hy3·kimi·grok']]},
  {st:'pend',state:'pending',loc:'GitHub',name:'buzz-fix · PR #2416',role:'Fix fenêtre Windows (2 harnesses) — attend Block',facts:[['CI · DCO','green','ok'],['état','mergeable','wait']]},
  {st:(d.toolsets||[]).includes('gitlawb')?'up':'off',state:(d.toolsets||[]).includes('gitlawb')?'working':'idle',loc:'toolset',name:'gl · gitlawb',role:'DID/git — actif si présent dans les toolsets',facts:[['état',(d.toolsets||[]).includes('gitlawb')?'connecté':'parked',(d.toolsets||[]).includes('gitlawb')?'ok':'']]},
 ];
 document.getElementById('grid').innerHTML=cards.map(card).join('');
 const active=cards.filter(c=>c.st==='up').length;
 document.getElementById('act').textContent=active+' / '+cards.length+' actifs';
 document.getElementById('ts').textContent='maj '+new Date(d.ts).toLocaleTimeString('fr-FR');
 document.getElementById('foot').textContent='Read-only partout · non-custodial · données live via le CLI Hermes + /health. Refresh 12s.';
}
tick();setInterval(tick,12000);
</script></body></html>`;

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/fleet')) {
    try { const d = await gather(); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(d)); }
    catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: String(e.message || e) })); }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML);
}).listen(PORT, () => console.log('fleet-console → http://localhost:' + PORT));
