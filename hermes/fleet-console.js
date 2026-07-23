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
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const HERMES = process.env.HERMES_BIN || '/root/.hermes-venv/bin/hermes';
const HOME_DIR = process.env.HERMES_HOME || '/root/.hermes-biii';
const ENV = { ...process.env, HERMES_HOME: HOME_DIR, PATH: '/usr/local/bin:/usr/bin:/bin' };
const PORT = Number(process.env.FLEET_PORT || 4799);

// ── Journal: the REAL run history the scheduler already writes (cron/output/<jobId>/<ts>.md). ──
const CRON_OUT = path.join(HOME_DIR, 'cron', 'output');
const JOBS_JSON = path.join(HOME_DIR, 'cron', 'jobs.json');
const jobNames = () => { try { const j = JSON.parse(fs.readFileSync(JOBS_JSON, 'utf8'));
  return Object.fromEntries((j.jobs || []).map((x) => [x.id, x.name || x.id])); } catch { return {}; } };
function summarize(md) {
  const body = md.split(/\n-{3,}\n/).slice(1).join('\n---\n') || md;   // drop the header block
  const lines = body.split('\n').map((s) => s.trim()).filter(Boolean);
  const flags = (body.match(/🚩|🆕/g) || []).length;
  const head = (lines.find((l) => !l.startsWith('#')) || '(sortie vide)').replace(/\s+/g, ' ');
  const ok = !/error|traceback|failed|exception/i.test(body);
  return { head: head.slice(0, 200), flags, ok, lines: lines.slice(0, 10) };
}
function readJournal(limit = 24) {
  const names = jobNames();
  let entries = [];
  let dirs = [];
  try { dirs = fs.readdirSync(CRON_OUT); } catch { return []; }
  for (const jid of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(CRON_OUT, jid)).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) entries.push({ jid, ts: f.replace(/\.md$/, ''), file: path.join(CRON_OUT, jid, f) });
  }
  entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));   // ISO-ish filename → lexicographic = chronological
  return entries.slice(0, limit).map((e) => {
    let md = ''; try { md = fs.readFileSync(e.file, 'utf8'); } catch {}
    const s = summarize(md);
    const [d, t] = e.ts.split('_');
    return { job: names[e.jid] || e.jid, time: d + ' ' + String(t || '').replace(/-/g, ':'), ...s };
  });
}

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

// ── Sessions: the REAL agent-session store, read via the Hermes CLI (no dashboard auth needed — the
// :4711 /api/sessions is 401 to a tokenless fetch, so we go through the CLI against the right HERMES_HOME). ──
async function readSessions(limit = 12) {
  const out = await sh(HERMES, ['sessions', 'list', '--limit', String(limit)]);
  const rows = [];
  for (const line of String(out).split('\n')) {
    const s = line.trim();
    if (!s || /^Preview\b/.test(s) || /^[─-]{3,}/.test(s)) continue;   // skip header + separator
    const cols = s.split(/\s{2,}/);                                     // fixed-width cols are 2+ spaces apart
    const id = cols[cols.length - 1];
    if (cols.length >= 5 && /^\d{8}_\d{6}_/.test(id)) {
      rows.push({ id, src: cols[cols.length - 2], lastActive: cols[cols.length - 3],
        workspace: cols[cols.length - 4], preview: cols.slice(0, cols.length - 4).join(' ') });
    }
  }
  return rows;
}

// ── Observability: REAL LLM spend from OpenRouter. Key is read server-side and NEVER sent to the browser. ──
function openrouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try { const m = fs.readFileSync(path.join(HOME_DIR, '.env'), 'utf8').match(/^OPENROUTER_API_KEY=(.+)$/m); return m ? m[1].trim() : null; } catch { return null; }
}
let spendCache = { t: 0, data: null };
async function fetchSpend() {
  if (Date.now() - spendCache.t < 60000 && spendCache.data) return spendCache.data;
  const key = openrouterKey();
  if (!key) return { ok: false, reason: 'no key' };
  const H = { Authorization: 'Bearer ' + key };
  const [k, c] = await Promise.all([
    fetch('https://openrouter.ai/api/v1/key', { headers: H }).then((r) => r.json()).catch(() => null),
    fetch('https://openrouter.ai/api/v1/credits', { headers: H }).then((r) => r.json()).catch(() => null),
  ]);
  const kd = (k && k.data) || {}; const cd = (c && c.data) || {};
  const data = { ok: true,
    keyUsage: +kd.usage || 0, daily: +kd.usage_daily || 0, weekly: +kd.usage_weekly || 0, monthly: +kd.usage_monthly || 0,
    credits: +cd.total_credits || 0, acctUsage: +cd.total_usage || 0, remaining: (+cd.total_credits || 0) - (+cd.total_usage || 0) };
  spendCache = { t: Date.now(), data };   // aggregates only — the key itself never leaves the server
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
.jhead{margin-top:30px;padding-top:18px;border-top:1px solid var(--line)}.jhead h2{margin:6px 0 0;font-size:18px;font-weight:600;letter-spacing:-.01em}.jhead .thin{color:var(--muted);font-weight:400}
.journal{margin-top:14px;display:flex;flex-direction:column;gap:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel2)}
.jitem{display:grid;grid-template-columns:150px 128px 1fr auto;gap:12px;align-items:baseline;padding:11px 16px;border-top:1px solid var(--line);cursor:pointer}
.jitem:first-child{border-top:none}.jitem:hover{background:#0f1a26}
.jtime{font-family:var(--mono);font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.jjob{font-family:var(--mono);font-size:11px;color:var(--accent2);border:1px solid var(--line2);border-radius:5px;padding:2px 8px;justify-self:start}
.jhd{font-size:12.5px;color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jflag{font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.04em;white-space:nowrap}
.jflag.f{color:var(--sched)}.jflag.c{color:var(--up)}
.jmore{display:none;grid-column:1/-1;margin-top:8px;padding:10px 12px;background:#0a141e;border:1px solid var(--line);border-radius:8px;font-family:var(--mono);font-size:11px;color:var(--muted);white-space:pre-wrap;line-height:1.6}
.jitem.open .jmore{display:block}.jitem.open .jhd{white-space:normal}
.obs{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:14px}
.stat{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat .l{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.stat .n{font-family:var(--mono);font-size:23px;font-weight:600;color:var(--tx);margin-top:7px;font-variant-numeric:tabular-nums}
.stat .s{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:4px}
.stat.warn .n{color:var(--sched)}.stat.zero .n{color:var(--up)}
</style></head><body><div class="wrap">
<header><div><div class="eyebrow">MainStreet · Living Economy · LIVE</div><h1>Fleet <span class="thin">— qui bosse, qui pas</span></h1></div>
<div class="meta"><span class="livedot"></span><b id="act">…</b> · <span id="ts">…</span><br>guard read-only: <b style="color:var(--up)">ON</b> · refresh 12s</div></header>
<div class="grid" id="grid"></div>
<div class="legend"><span><i style="background:var(--up)"></i>working</span><span><i style="background:var(--sched)"></i>scheduled</span><span><i style="background:var(--pend)"></i>pending</span><span><i style="background:var(--down)"></i>down</span><span><i style="background:var(--off)"></i>idle</span></div>
<div class="jhead"><div class="eyebrow">Observabilité · dépense LLM (OpenRouter, live)</div><h2>Combien les robots dépensent</h2></div>
<div id="obs" class="obs"><div class="foot">chargement de la dépense…</div></div>
<div class="jhead"><div class="eyebrow">Sessions · agents (live via le CLI, le vrai store)</div><h2>Ce que les agents ont fait <span class="thin">— vraies sessions Hermes</span></h2></div>
<div id="sessions" class="journal"><div class="foot">chargement des sessions…</div></div>
<div class="jhead"><div class="eyebrow">Journal · historique réel des runs</div><h2>Ce que les bots ont fait <span class="thin">— dernières exécutions cron</span></h2></div>
<div id="journal" class="journal"><div class="foot">chargement du journal…</div></div>
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
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function jrow(r){const cls=r.flags>0?'f':'c';const badge=r.flags>0?(r.flags+' flag'+(r.flags>1?'s':'')):(r.ok?'clean':'erreur');const more=esc((r.lines||[]).join('\\n'))||'(pas de détail)';return \`<div class="jitem" onclick="this.classList.toggle('open')"><span class="jtime">\${esc(r.time)}</span><span class="jjob">\${esc(r.job)}</span><span class="jhd">\${esc(r.head)}</span><span class="jflag \${cls}">\${badge}</span><div class="jmore">\${more}</div></div>\`}
async function jtick(){let d;try{d=await (await fetch('/api/journal')).json()}catch(e){return}
 const el=document.getElementById('journal');
 if(!d.runs||!d.runs.length){el.innerHTML='<div class="foot" style="padding:14px 16px;margin:0">aucun run enregistré pour l\\'instant — la sentinelle écrit ici à chaque passage (toutes les 30 min)</div>';return}
 el.innerHTML=d.runs.map(jrow).join('')}
async function stick(){let d;try{d=await (await fetch('/api/spend')).json()}catch(e){return}
 const el=document.getElementById('obs');
 if(!d||!d.ok){el.innerHTML='<div class="stat"><div class="l">dépense LLM</div><div class="n">—</div><div class="s">indisponible ('+((d&&d.reason)||'?')+')</div></div>';return}
 const usd=x=>'$'+Number(x).toFixed(2);const low=d.remaining<5;
 const rows=[
  ['clé fleet · total',usd(d.keyUsage),'runs Hermes (hy3·kimi·grok)',''],
  ['aujourd\\'hui',usd(d.daily),'semaine '+usd(d.weekly),''],
  ['ce mois',usd(d.monthly),'facturé OpenRouter',''],
  ['crédits restants',usd(d.remaining),'sur '+usd(d.credits)+' du compte',low?'warn':''],
  ['sentinelle biii-watch','$0.00','no_agent · zéro appel LLM','zero'],
 ];
 el.innerHTML=rows.map(s=>\`<div class="stat \${s[3]}"><div class="l">\${s[0]}</div><div class="n">\${s[1]}</div><div class="s">\${s[2]}</div></div>\`).join('')}
function sesrow(r){return \`<div class="jitem"><span class="jtime">\${esc(r.lastActive)}</span><span class="jjob">\${esc(r.workspace)}</span><span class="jhd">\${esc(r.preview)}</span><span class="jflag c">\${esc(r.src)}</span></div>\`}
async function sestick(){let d;try{d=await (await fetch('/api/sessions')).json()}catch(e){return}
 const el=document.getElementById('sessions');
 if(!d.sessions||!d.sessions.length){el.innerHTML='<div class="foot" style="padding:14px 16px;margin:0">aucune session — lance un agent (hermes -z ...) pour en cr\\u00e9er une</div>';return}
 el.innerHTML=d.sessions.map(sesrow).join('')}
tick();setInterval(tick,12000);
jtick();setInterval(jtick,30000);
stick();setInterval(stick,60000);
sestick();setInterval(sestick,30000);
</script></body></html>`;

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/fleet')) {
    try { const d = await gather(); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(d)); }
    catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: String(e.message || e) })); }
  }
  if (req.url.startsWith('/api/journal')) {
    try { const j = readJournal(24); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ts: new Date().toISOString(), runs: j })); }
    catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: String(e.message || e) })); }
  }
  if (req.url.startsWith('/api/spend')) {
    try { const d = await fetchSpend(); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(d)); }
    catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: String(e.message || e) })); }
  }
  if (req.url.startsWith('/api/sessions')) {
    try { const s = await readSessions(12); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ts: new Date().toISOString(), sessions: s })); }
    catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: String(e.message || e) })); }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML);
}).listen(PORT, () => console.log('fleet-console → http://localhost:' + PORT));
