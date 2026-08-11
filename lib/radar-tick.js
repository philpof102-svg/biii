'use strict';
/**
 * radar-tick.js — faire tourner le radar LA OU la machine ne s'eteint pas.
 * ================================================================================================
 * ⚠️ CE CHIFFRE SE REFAIT, IL NE SE CITE PAS: `node hermes/economy/probe-couverture-refaisable.js`.
 * Remesure du 2026-08-11: **74,3 %** sur une fenetre de 393,5 h — les 101,2 h aveugles n'ont pas bouge,
 * mais le denominateur a grandi de 38 h sans nouveau trou. Le 68,9 % ci-dessous reste la mesure du
 * 2026-08-09 et le raisonnement qu'elle a justifie; il est PESSIMISTE aujourd'hui, pas faux.
 *
 * MESURE QUI JUSTIFIE CE FICHIER (2026-08-09, `data/token-radar/blackouts.json`): le collecteur local
 * a une couverture de 68,9 % — 101,2 h aveugles sur 325,5 h, huit trous, median 11,8 h, les quatre
 * derniers a 22,1 / 20,8 / 11,8 / 21,1 h. Le lanceur le dit lui-meme: « Close them to stop. » Un tiers
 * des lancements n'est jamais vu, et 31 % de cecite fausse tout taux par unite de temps (ce depot a
 * deja paye ce bug: un trou de 11,83 h gonflait les taux de 1,90x).
 *
 * ET LE MEME DEPLACEMENT REPARE UNE SECONDE CHOSE. Le `/mcp` heberge tourne dans ce service et
 * `bin/biii-mcp.js` charge `lib/funder-history`, qui lit `tokens.json`. Aujourd'hui il sert donc le
 * snapshot fige au dernier deploiement — exactement ce que `token-radar.sh` decrit: « the hosted node
 * and the npm package both served whatever snapshot happened to be committed alongside some unrelated
 * code change ».
 *
 * ⛔ `hermes/economy/token-radar.js` EST EPINGLE PAR SHA256 et `verify_payload` le controle a chaque
 * run du cron local: l'editer arreterait silencieusement la flotte. Ce module ne le touche pas. Il
 * l'appelle dans un PROCESSUS ENFANT et lui prepare son dossier de donnees autour.
 *
 * ⛔ ET IL NE DOIT JAMAIS FAIRE TOMBER LE SERVEUR PAYANT. Le radar tourne une heure sur deux dans le
 * meme conteneur que l'endpoint x402; un plantage, une fuite memoire ou une boucle infinie de sa part
 * ne peut pas avoir le droit de couper l'encaissement. D'ou: enfant separe, timeout dur, aucune
 * exception qui remonte, et un seul run a la fois.
 *
 * ⛔ INERTE PAR DEFAUT. Sans `RADAR_TICK_MINUTES`, rien ne se planifie et la raison est DITE — un
 * module qui ne fait rien en silence se lit comme un module qui marche.
 *
 * LA DECISION EST SEPAREE DE L'ACTION (`planRadarStorage` / `applyRadarStorage`) pour qu'elle se teste
 * sans toucher un disque ni un volume Railway.
 */
const path = require('node:path');
const { envNum } = require('./ratelimit');

/** Le fichier qui prouve qu'un dossier porte VRAIMENT une base de radar, et pas juste un dossier vide. */
const MARQUEUR = 'tokens.json';

/**
 * Ou le radar doit-il ecrire, et que faut-il preparer avant ?
 *
 * ⛔ LA REGLE QUI PORTE TOUT LE RESTE: si le volume porte DEJA une base, on n'y touche pas. Le depot
 * embarque un instantane commite; le recopier par-dessus des heures d'observations vivantes les
 * effacerait a chaque redeploiement — et un redeploiement est justement le moment ou personne ne
 * regarde. Le volume est la source de verite des qu'il en a une.
 *
 * @param {object} a
 * @param {string} a.repoDir      dossier que le radar epingle calcule tout seul (`<repo>/data/token-radar`)
 * @param {string|undefined} a.volumeRoot  `RAILWAY_VOLUME_MOUNT_PATH`, absent hors Railway
 * @param {(p:string)=>({exists:boolean,isSymlink?:boolean,hasDb?:boolean})} a.inspect  lecture injectee
 * @returns {{mode:'repo'|'volume', dir:string, actions:string[], raison:string}}
 */
function planRadarStorage({ repoDir, volumeRoot, inspect }) {
  if (typeof repoDir !== 'string' || !repoDir) {
    return { mode: 'repo', dir: repoDir, actions: [], raison: 'repoDir manquant — rien ne se prepare' };
  }
  if (typeof volumeRoot !== 'string' || !volumeRoot.trim()) {
    /* Hors Railway c'est le cas NORMAL, pas une panne: le radar local ecrit dans le depot depuis
     * toujours. La raison est rendue pour qu'un appelant ne lise pas ce retour comme un echec. */
    return { mode: 'repo', dir: repoDir, actions: [],
      raison: 'aucun volume monte (RAILWAY_VOLUME_MOUNT_PATH absent) — ecriture dans le depot, comme en local' };
  }
  /* ⛔ `path.posix`, PAS `path`. Le volume est un montage Linux (`/data`) quelle que soit la machine qui
   * calcule ce chemin: sur Windows `path.join('/data','token-radar')` rend `\data\token-radar`, et le
   * plan croit alors le volume VIDE — donc amorce, donc ECRASE la base vivante au redeploiement. Le
   * test l'a attrape ici avant la production. */
  const volDir = path.posix.join(volumeRoot, 'token-radar');
  const vol = inspect(volDir) || { exists: false };
  const repo = inspect(repoDir) || { exists: false };
  const actions = [];
  const notes = [];

  if (vol.hasDb) {
    notes.push('le volume porte deja une base — AUCUN ecrasement');
  } else if (repo.hasDb) {
    actions.push('seed');
    notes.push('volume vide, depot fourni: amorcage unique depuis l instantane commite');
  } else {
    actions.push('mkdir');
    notes.push('ni volume ni depot ne portent de base: dossier cree, le radar partira de zero');
  }

  /* Le radar epingle calcule `repoDir` en dur. Le seul moyen de le faire ecrire sur le volume sans
   * l'editer est de faire de `repoDir` un lien vers le volume. On ne relie pas ce qui l'est deja. */
  if (repo.isSymlink) notes.push('repoDir est deja un lien — rien a refaire');
  else actions.push('link');

  return { mode: 'volume', dir: volDir, actions, raison: notes.join(' · ') };
}

/**
 * Execute un plan. Toute erreur est RENDUE, jamais lancee: echouer a preparer le volume doit degrader
 * vers « le radar ecrit dans le conteneur » et non tuer le serveur au demarrage.
 * @returns {{ok:boolean, faites:string[], erreur:string|null}}
 */
function applyRadarStorage(plan, io) {
  const faites = [];
  try {
    for (const a of plan.actions) {
      if (a === 'seed') { io.mkdirp(plan.dir); io.copyDir(io.repoDir, plan.dir); faites.push('seed'); }
      else if (a === 'mkdir') { io.mkdirp(plan.dir); faites.push('mkdir'); }
      else if (a === 'link') { io.replaceWithLink(io.repoDir, plan.dir); faites.push('link'); }
    }
    return { ok: true, faites, erreur: null };
  } catch (e) {
    return { ok: false, faites, erreur: String((e && e.message) || e) };
  }
}

/**
 * Faut-il RATTRAPER au demarrage ?
 *
 * LE DEFAUT QUE CA CORRIGE: `setInterval` ne tire qu'a T+intervalle. Un conteneur qui redemarre plus
 * souvent que ca — deploiement, plantage, migration d'hote — ne collecterait JAMAIS rien, et le journal
 * dirait « ACTIF » a chaque fois. C'est la forme exacte du motif de ce depot: un instrument mort est
 * indiscernable d'un instrument vert.
 *
 * ⛔ MAIS UN RATTRAPAGE INCONDITIONNEL OUVRE UN AUTRE TROU. Sur une boucle de plantage, chaque
 * redemarrage relancerait une collecte complete, et ce depot a mesure qu'un seul endpoint sert des
 * `getLogs` larges sur Base — sans repli gratuit. Le rattrapage est donc conditionne a l'AGE DE LA BASE:
 * on ne rattrape que ce qui manque vraiment.
 *
 * ⚠️ ET « age inconnu » DECLENCHE le run, il ne l'annule pas. Ne pas pouvoir lire l'age n'est pas une
 * preuve que la base est fraiche — c'est l'absence de preuve qu'elle l'est.
 *
 * @param {{minutes:number, ageMinutes:number|null}} a
 * @returns {{run:boolean, raison:string}}
 */
function planDemarrage({ minutes, ageMinutes }) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { run: false, raison: 'radar inactif ici — aucun rattrapage' };
  }
  if (ageMinutes === null || ageMinutes === undefined || !Number.isFinite(ageMinutes)) {
    return { run: true, raison: 'age de la base ILLISIBLE — on collecte plutot que de supposer qu elle est fraiche' };
  }
  if (ageMinutes >= minutes) {
    return { run: true, raison: 'base en retard de ' + Math.round(ageMinutes) + ' min sur un intervalle de '
      + minutes + ' — rattrapage' };
  }
  return { run: false, raison: 'base fraiche (' + Math.round(ageMinutes) + ' min < ' + minutes
    + ') — rien a rattraper, le prochain tick suffit' };
}

/**
 * Age de la base, en minutes, lu sur l'observation la PLUS RECENTE qu'elle contient.
 *
 * ⛔ PAS le `mtime` du fichier. Ce depot a paye la confusion « horodatage d'ECRITURE lu comme horodatage
 * d'observation »: juste apres un amorcage, le fichier vient d'etre ecrit et paraitrait donc frais alors
 * que son CONTENU date du dernier run de la machine d'origine. C'est exactement le cas au premier
 * demarrage sur un volume vide.
 * @returns {number|null} null si rien de lisible — l'appelant traite ca comme « collecter ».
 */
function ageBaseMinutes(dir, maintenant = Date.now()) {
  try {
    const fs = require('node:fs');
    const db = JSON.parse(fs.readFileSync(path.join(dir, MARQUEUR), 'utf8'));
    let recent = 0;
    for (const k of Object.keys(db)) {
      const v = Date.parse(db[k] && db[k].lastSeen);
      if (Number.isFinite(v) && v > recent) recent = v;
    }
    if (!recent) return null;
    return (maintenant - recent) / 60_000;
  } catch { return null; }
}

/**
 * Faut-il lancer un tick maintenant ?
 * ⛔ UN SEUL RUN A LA FOIS. Le radar peut depasser son intervalle (il lit la chaine page par page);
 * empiler deux instances doublerait les appels RPC sur le seul endpoint qui sert des getLogs larges,
 * et deux ecritures concurrentes sur la meme base produiraient un fichier a moitie ecrit.
 * @returns {{run:boolean, raison:string}}
 */
function planTick({ minutes, running }) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { run: false, raison: 'RADAR_TICK_MINUTES absent ou invalide — le radar ne tourne PAS ici' };
  }
  if (running) return { run: false, raison: 'un run precedent n est pas termine — ce tick est saute' };
  return { run: true, raison: 'ok' };
}

/* ── LES IMPLEMENTATIONS REELLES ──────────────────────────────────────────────────────────────────────
 * Les tests injectent des doubles; la production a besoin de ces trois-la. Elles sont volontairement
 * minces: toute la DECISION est au-dessus, deja testee, et ce qui suit ne fait qu'obeir. */
function inspectReel(p) {
  const fs = require('node:fs');
  try {
    const st = fs.lstatSync(p);
    const isSymlink = st.isSymbolicLink();
    let hasDb = false;
    try { hasDb = fs.existsSync(path.posix.join(p.replace(/\\/g, '/'), MARQUEUR)); } catch { hasDb = false; }
    return { exists: true, isSymlink, hasDb };
  } catch { return { exists: false }; }
}
const ioReel = {
  mkdirp: (d) => require('node:fs').mkdirSync(d, { recursive: true }),
  copyDir: (src, dst) => require('node:fs').cpSync(src, dst, { recursive: true }),
  /* ⛔ L'ORDRE COMPTE ET IL EST GARANTI PAR LE PLAN: `seed` est pousse avant `link`, donc l'instantane
   * commite est deja sur le volume quand le dossier du depot disparait. Inverser les deux perdrait la
   * base au premier demarrage. */
  replaceWithLink: (repoDir, cible) => {
    const fs = require('node:fs');
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.symlinkSync(cible, repoDir, 'dir');
  },
};
/** Lance le radar EPINGLE dans un enfant. Jamais `require`: son plantage ne doit pas etre le notre. */
function lancerReel() {
  const { spawn } = require('node:child_process');
  const racine = path.join(__dirname, '..');
  const script = path.join('hermes', 'economy', 'token-radar.js');
  const limite = envNum('RADAR_TICK_TIMEOUT_MS', 20 * 60_000);   // < l intervalle, sinon deux runs se croisent
  return new Promise((resolve) => {
    const e = spawn(process.execPath, [script], { cwd: racine, stdio: 'inherit',
      env: { ...process.env, RADAR_CHAIN: process.env.RADAR_CHAIN || 'base' } });
    const minuteur = setTimeout(() => { try { e.kill('SIGKILL'); } catch { /* deja mort */ } }, limite);
    e.on('exit', (code, signal) => { clearTimeout(minuteur); resolve({ code: code === null ? -1 : code, signal }); });
    e.on('error', (err) => { clearTimeout(minuteur); resolve({ code: -1, signal: null, err: String(err.message || err) }); });
  });
}

/**
 * Cable le tout. Rend un objet qui DIT ce qu'il fait, pour qu'un demarrage muet soit impossible.
 * @returns {{actif:boolean, raison:string, minutes:number|null, dir:string|null, stop:()=>void}}
 */
function startRadarTicks(opts = {}) {
  const {
    /* ⛔ LE DOSSIER SE DERIVE DU FICHIER, PAS L'INVERSE — et ce n'est pas cosmetique. Le garde
     * `test/package-data.test.js` exige que tout chemin `data/...` cite par du code LIVRE soit classe
     * reference ou etat d'execution, et `npm pack` ne liste que des FICHIERS: un repertoire nu ne peut
     * entrer dans aucune des deux listes. Nommer `tokens.json` — deja classe comme la base d'observation
     * sans laquelle `till_funder_history` repond `no_database` — dit aussi mieux ce qui compte ici. */
    repoDir = path.dirname(path.join(__dirname, '..', 'data', 'token-radar', 'tokens.json')),
    volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH,
    minutes = envNum('RADAR_TICK_MINUTES', 0) || null,
    inspect = inspectReel, io = ioReel, lancer = lancerReel,
    log = console.log, planifier = setInterval, differer = setTimeout,
    ageMinutes,                                        // injecte par les tests; sinon lu sur la base
    delaiDemarrageMs = envNum('RADAR_TICK_BOOT_DELAY_MS', 20_000),
  } = opts;

  const m = Number.isFinite(minutes) ? minutes : null;
  const decision = planTick({ minutes: m, running: false });
  if (!decision.run) {
    log('radar-tick: INACTIF — ' + decision.raison);
    return { actif: false, raison: decision.raison, minutes: null, dir: null, stop: () => {} };
  }

  const plan = planRadarStorage({ repoDir, volumeRoot, inspect });
  const applique = plan.actions.length ? applyRadarStorage(plan, { ...io, repoDir }) : { ok: true, faites: [], erreur: null };
  log('radar-tick: stockage ' + plan.mode + ' → ' + plan.dir + '  [' + plan.raison + ']'
    + (applique.ok ? '' : '  ⛔ preparation ECHOUEE: ' + applique.erreur + ' — le radar ecrira dans le conteneur'));

  let running = false;
  const tick = async () => {
    const d = planTick({ minutes: m, running });
    if (!d.run) { log('radar-tick: saute — ' + d.raison); return; }
    running = true;
    const t0 = Date.now();
    try {
      const r = await lancer();
      log('radar-tick: run termine en ' + ((Date.now() - t0) / 1000).toFixed(1) + 's — code ' + r.code
        + (r.code === 0 ? '' : '  ⛔ le radar a echoue, la base peut etre a moitie ecrite'));
    } catch (e) {
      /* Aucune exception ne remonte: ce module partage son processus avec l endpoint payant. */
      log('radar-tick: run ECHOUE — ' + String((e && e.message) || e));
    } finally { running = false; }
  };

  const h = planifier(tick, m * 60_000);
  if (h && typeof h.unref === 'function') h.unref();

  /* ── LE RATTRAPAGE DE DEMARRAGE ────────────────────────────────────────────────────────────────────
   * Decale de quelques secondes: le serveur vient d'ouvrir son port et un healthcheck l'attend. Lancer
   * une collecte dans la meme milliseconde ferait concurrence a l'endpoint payant au pire moment. */
  const age = ageMinutes !== undefined ? ageMinutes : ageBaseMinutes(plan.dir);
  const d0 = planDemarrage({ minutes: m, ageMinutes: age });
  log('radar-tick: demarrage — ' + (d0.run ? 'RATTRAPAGE' : 'pas de rattrapage') + ': ' + d0.raison);
  if (d0.run) {
    const t0 = differer(() => { tick(); }, delaiDemarrageMs);
    if (t0 && typeof t0.unref === 'function') t0.unref();
  }

  log('radar-tick: ACTIF, toutes les ' + m + ' min');
  return { actif: true, raison: 'ok', minutes: m, dir: plan.dir, rattrapage: d0,
    stop: () => clearInterval(h), _tick: tick };
}

module.exports = { planRadarStorage, applyRadarStorage, planTick, planDemarrage, ageBaseMinutes,
  startRadarTicks, MARQUEUR };
