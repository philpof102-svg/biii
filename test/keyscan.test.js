#!/usr/bin/env node
'use strict';
/**
 * keyscan — le test qui n'existait pas.
 *
 * POURQUOI CE FICHIER ARRIVE SI TARD, ET POURQUOI C'EST GENANT
 * Le 2026-07-27, une couverture V8 sur la suite entiere a donne 17 % sur lib/keyscan.js — le module se
 * CHARGE (le binaire MCP le require) mais 83 % de son code ne s'execute jamais. Un grep prealable avait
 * conclu "12 modules non testes", et la couverture l'a corrige: un seul module n'est jamais charge, les
 * autres sont EFFLEURES. La difference compte, parce qu'un module effleure passe tous les gardes
 * existants — il n'est orphelin de rien.
 *
 * C'est le module qui repond "y a-t-il un secret en clair ici". Un faux "non" y coute une machine.
 *
 * CE QUE CES TESTS PROTEGENT EN PRIORITE
 * La these du module: c'est l'ETIQUETTE qui decide, jamais la forme de la valeur. Une cle secp256k1 fait
 * 64 caracteres hex, et un SHA-256, un id de commit git et un hash de transaction aussi. Chercher la forme
 * ne trouve pas des cles, ca trouve des hashs par milliers. Si un refactor inverse cet ordre, la suite doit
 * rougir avant que quelqu'un ne se fie a un rapport rempli de faux positifs — ou pire, ne s'y habitue.
 */
const assert = require('node:assert');
const K = require('../lib/keyscan.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

/* Valeurs temoins. VALIDE est un scalaire secp256k1 legal et manifestement synthetique — il ne correspond
 * a aucun wallet et n'a pas a etre traite comme un secret. TROP_GRAND est au-dessus de l'ordre du groupe,
 * donc mathematiquement impossible comme cle privee. */
const VALIDE = 'a'.repeat(64);
const TROP_GRAND = 'f'.repeat(64);
const ZERO = '0'.repeat(64);

console.log('keyscan: l etiquette decide, pas la forme de la valeur');

t('un scalaire hors intervalle n est pas une cle (0, n, au-dessus de n)', () => {
  assert.equal(K.isPlausibleScalar(ZERO), false, 'zero est refuse');
  assert.equal(K.isPlausibleScalar(TROP_GRAND), false, 'au-dessus de l ordre du groupe est refuse');
  assert.equal(K.isPlausibleScalar(VALIDE), true, 'un scalaire legal est accepte');
  // La borne exacte: n lui-meme est invalide, n-1 est valide. Une erreur de <= vs < passerait tout le reste.
  const n = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
  const nMoins1 = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140';
  assert.equal(K.isPlausibleScalar(n), false, 'n exactement doit etre refuse');
  assert.equal(K.isPlausibleScalar(nMoins1), true, 'n-1 doit etre accepte');
});

t('UNE ETIQUETTE DE CLE + une valeur en forme de cle = cleartext_key', () => {
  const f = K.scanKeyText('PRIVATE_KEY=' + VALIDE + '\n', { filename: 'app/.env' });
  assert.equal(f.length, 1, 'une seule trouvaille attendue, vu ' + f.length);
  assert.equal(f[0].verdict, 'cleartext_key');
  assert.equal(f[0].line, 1);
});

t('LA MEME VALEUR sans etiquette n est PAS signalee — la these du module', () => {
  /* Si ce test tombe, le module s'est mis a chercher la forme. Il rendrait alors une trouvaille par hash
   * de commit, par id de transaction et par digest dans tout depot un peu bavard. */
  const f = K.scanKeyText('voici un identifiant quelconque: ' + VALIDE + '\n', { filename: 'notes.md' });
  assert.equal(f.length, 0, 'aucune trouvaille attendue sans etiquette, vu ' + JSON.stringify(f));
});

t('une etiquette de DIGEST bat une etiquette de cle sur la meme ligne', () => {
  /* PRIVATE_KEY_HASH= est un condense, pas un secret. L ordre de verification est le point: digest d abord. */
  for (const l of ['PRIVATE_KEY_HASH=' + VALIDE, 'privateKeyFingerprint: ' + VALIDE, 'deployer_key_checksum=' + VALIDE]) {
    const f = K.scanKeyText(l + '\n', { filename: 'x.env' });
    assert.equal(f.length, 0, 'devrait etre ignore comme digest: ' + l.slice(0, 30));
  }
});

t('`pk` n est deliberement PAS une etiquette de cle', () => {
  // Il entrerait en collision avec les colonnes de cle primaire de tout dump SQL. Un faux positif sur un
  // schema de base suffirait a ce que quelqu un arrete de lancer l outil — ce qui coute plus qu il ne rapporte.
  assert.equal(K.scanKeyText('pk=' + VALIDE + '\n', { filename: 'dump.sql' }).length, 0);
  assert.equal(K.KEY_LABEL.test('pk'), false, 'KEY_LABEL ne doit pas matcher pk seul');
});

t('une etiquette avec une valeur NON en forme de cle = labelled_only, pas une alerte', () => {
  for (const l of ['PRIVATE_KEY=${DEPLOY_SECRET}', 'PRIVATE_KEY=<REDACTED>', 'PRIVATE_KEY=' + TROP_GRAND]) {
    const f = K.scanKeyText(l + '\n', { filename: '.env' });
    assert.equal(f.length, 1, l);
    assert.equal(f[0].verdict, 'labelled_only', l + ' -> ' + f[0].verdict);
  }
});

console.log('\nla regle qui ne se negocie pas: aucun octet de cle en sortie');

t('AUCUNE trace de la valeur dans la sortie, meme tronquee', () => {
  /* Quatre octets connus retrecissent deja une recherche exhaustive. Ce test cherche la valeur entiere ET
   * ses prefixes, parce que "juste les premiers caracteres" est exactement la fuite qu on croit inoffensive. */
  const f = K.scanKeyText('PRIVATE_KEY=' + VALIDE + '\nSIGNER_KEY=' + VALIDE + '\n', { filename: '.env' });
  const sortie = JSON.stringify(f);
  assert.ok(!sortie.includes(VALIDE), 'la valeur complete ne doit pas apparaitre');
  for (const n of [8, 12, 16, 24]) {
    assert.ok(!sortie.includes(VALIDE.slice(0, n)), 'un prefixe de ' + n + ' caracteres ne doit pas apparaitre');
  }
});

console.log('\nkeystore: structurel, donc un oui/non et pas un score');

const KEYSTORE = JSON.stringify({
  version: 3, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  address: '1111111111111111111111111111111111111111',
  crypto: { ciphertext: 'de'.repeat(16), kdf: 'scrypt', mac: 'ab'.repeat(16), cipher: 'aes-128-ctr' },
});

t('un keystore Web3 Secret Storage est reconnu par sa STRUCTURE', () => {
  const ks = K.readKeystore(KEYSTORE);
  assert.ok(ks, 'devrait etre reconnu');
  assert.equal(ks.version, 3);
  assert.equal(ks.kdf, 'scrypt');
  assert.equal(ks.address, '1111111111111111111111111111111111111111', 'l adresse est publique et rend la trouvaille actionnable');
});

t('un JSON qui ressemble sans avoir les trois membres n est PAS un keystore', () => {
  const sansMac = JSON.parse(KEYSTORE); delete sansMac.crypto.mac;
  assert.equal(K.readKeystore(JSON.stringify(sansMac)), null, 'sans mac -> pas un keystore');
  assert.equal(K.readKeystore('{"version":3}'), null, 'sans crypto -> pas un keystore');
  assert.equal(K.readKeystore('pas du json'), null, 'texte libre -> pas un keystore');
});

t('un keystore court-circuite le balayage ligne a ligne', () => {
  /* Sinon son ciphertext, qui est du hex, serait re-scanne et pourrait produire du bruit par-dessus une
   * trouvaille deja certaine. */
  const f = K.scanKeyText(KEYSTORE, { filename: 'wallet.json' });
  assert.equal(f.length, 1, 'exactement une trouvaille pour un fichier keystore');
  assert.equal(f[0].verdict, 'keystore_file');
});

console.log('\ncopies retenues: roter un secret ne l enleve pas du disque');

t('le MEME contenu devient retained_copy selon le CHEMIN', () => {
  const contenu = 'PRIVATE_KEY=' + VALIDE + '\n';
  assert.equal(K.scanKeyText(contenu, { filename: 'C:/projet/.env' })[0].verdict, 'cleartext_key');
  for (const chemin of [
    'C:/Users/x/.history/env@v12',
    'C:/Users/x/AppData/Roaming/Code/User/History/abc/.env',   // pas un motif retenu -> reste cleartext
    'D:/BACKUP-AVANT-FORMAT/projet/.env',
    'C:/Users/x/.claude/cache/.env',
    'C:/projet/.env.bak',
  ]) {
    const f = K.scanKeyText(contenu, { filename: chemin });
    const attenduRetenu = K.RETAINED_PATH.test(chemin);
    assert.equal(f[0].verdict, attenduRetenu ? 'retained_copy' : 'cleartext_key',
      chemin + ' -> ' + f[0].verdict + ' (RETAINED_PATH=' + attenduRetenu + ')');
    assert.equal(f[0].retained, attenduRetenu, chemin + ': le drapeau retained doit suivre le verdict');
  }
});

t('une ligne demesuree est sautee (bundle minifie)', () => {
  // Rien de lisible n est dans une ligne de 40 000 caracteres, et la balayer coute cher pour rien.
  const longue = 'PRIVATE_KEY=' + VALIDE + ';' + 'x'.repeat(5000);
  assert.equal(K.scanKeyText(longue + '\n', { filename: 'bundle.min.js' }).length, 0);
  // ...mais la meme ligne sous le seuil est bien vue: la coupure est la longueur, pas le nom du fichier.
  const courte = 'PRIVATE_KEY=' + VALIDE + ';' + 'x'.repeat(100);
  assert.equal(K.scanKeyText(courte + '\n', { filename: 'bundle.min.js' })[0].verdict, 'cleartext_key');
});

console.log('\nla portee est une DONNEE, pas une phrase (regression du 2026-07-27)');

t('scanKeyPaths annonce explicitement la portee de chaque champ', () => {
  /* Le defaut corrige ce jour-la: `secrets` couvre les chemins demandes, `vaults` couvre LA MACHINE — a
   * raison, un coffre d extension vit dans un dossier de profil fixe. Mais l objet ne le disait pas, et
   * auditer un tarball extrait a rendu "8 coffres" qui etaient les navigateurs de la machine, aucun dans
   * le tarball. Le nombre etait juste et la lecture etait fausse. La prose de `disclosure` ne suffit pas:
   * un agent qui consomme du JSON lit les champs. */
  const r = K.scanKeyPaths([__dirname]);
  assert.ok(r.scope, '`scope` doit exister');
  assert.equal(r.scope.secrets, 'paths');
  assert.equal(r.scope.keystores, 'paths');
  assert.equal(r.scope.vaults, 'machine', 'vaults NE suit PAS les chemins donnes — ce doit etre dit');
  assert.ok(/scope/i.test(r.disclosure), 'la prose doit renvoyer au champ, pas le remplacer');
});

t('un dossier sans cle rend un verdict propre, et pas un verdict vide', () => {
  const r = K.scanKeyPaths([__dirname]);
  assert.equal(r.verdict, 'no_cleartext_key', 'ce dossier de tests ne doit contenir aucune vraie cle');
  assert.deepStrictEqual(r.secrets, [], 'aucun secret attendu');
  assert.ok(Array.isArray(r.vaults), 'vaults reste un tableau meme quand secrets est vide');
  assert.ok(typeof r.complete === 'boolean', '`complete` dit si quelque chose a ete saute');
});

t('un chemin inexistant ne fait pas passer le scan pour propre en silence', () => {
  /* FAIL-CLOSED. Un chemin illisible doit se voir dans `skipped`/`complete`, sinon "aucune cle trouvee"
   * peut vouloir dire "rien n a ete lu" — la panne la plus traitre de tout cet outil. */
  const r = K.scanKeyPaths(['Z:/ce-chemin-n-existe-pas-du-tout-42']);
  assert.equal(r.scanned, 0, 'aucun fichier lu');
  assert.ok(r.verdict === 'no_cleartext_key', 'le verdict reste formellement propre...');
  assert.equal(r.complete, false, '...mais `complete` doit dire FAUX pour qu on ne s y fie pas');
});

/* ── findVaults : « aucun coffre » et « je n'ai rien pu lire » sortaient IDENTIQUES ─────────────────
 * Cette fonction dit ou se trouve le materiel de cle d'une personne — sur cette machine elle en compte 8,
 * et c'est le chiffre qui figure dans la note d'exposition. Trois `catch { continue; }` la rendaient
 * muette sur ce qu'elle ne voyait pas: un dossier navigateur VERROUILLE (navigateur ouvert, permission
 * refusee) etait saute exactement comme un navigateur non installe, et le tableau rendu etait VIDE.
 *
 * Sur cette question un sous-comptage silencieux EST un faux feu vert: on annonce moins de coffres qu'il
 * n'y en a, et le lecteur en conclut qu'il a moins a proteger.
 *
 * ⚠️ `deps` est ce qui rend ces cas possibles: sans lui la fonction ne lit que le vrai disque, ce qui
 * explique qu'elle n'ait ete nommee dans aucun test. Les cas ci-dessous ne touchent AUCUN fichier reel. */
const EST_COFFRE = /Local Extension Settings/;
const dirent = (n) => ({ name: n, isDirectory: () => true });
/* ⚠️ Premier jet de ce bouchon: il ne rendait des entrees de repertoire que pour les chemins finissant
 * par « User Data », donc les bases mac/linux recevaient des chaines et la sonde plantait. L'erreur etait
 * dans la SONDE. On discrimine donc sur « est-ce un dossier de coffre ? », jamais sur un nom d'OS. */
const disque = (mode) => ({
  home: '/faux',
  fs: {
    existsSync: (p) => {
      if (mode === 'existsSync-jette' && !EST_COFFRE.test(p)) throw new Error('EPERM');
      return true;
    },
    readdirSync: (p) => {
      if (EST_COFFRE.test(p)) {
        if (mode === 'coffre-verrouille') { const e = new Error('x'); e.code = 'EACCES'; throw e; }
        return ['000001.log', 'MANIFEST-000002'];
      }
      if (mode === 'base-verrouillee') { const e = new Error('x'); e.code = 'EPERM'; throw e; }
      return [dirent('Default')];
    },
    statSync: (p) => {
      if (mode === 'stat-rate' && /000001/.test(p)) throw new Error('EBUSY');
      return { size: 1000 };
    },
  },
});
const lire = (mode) => {
  const r = K.findVaults({ deps: disque(mode) });
  return { r, lisibles: r.filter((x) => !x.unreadable), illisibles: r.filter((x) => x.unreadable) };
};

const ok = lire('ok');
const baseKO = lire('base-verrouillee');
const coffreKO = lire('coffre-verrouille');
const statKO = lire('stat-rate');

t('un dossier navigateur VERROUILLE ne disparait plus en silence', () => {
  /* Le coeur du correctif: avant, ce cas rendait un tableau VIDE — indiscernable d'une machine sans
   * aucun navigateur installe. */
  assert.ok(baseKO.r.length > 0, 'un verrou ne doit pas produire un resultat vide');
  assert.strictEqual(baseKO.lisibles.length, 0);
  assert.strictEqual(baseKO.illisibles.length, baseKO.r.length);
  assert.match(baseKO.illisibles[0].unreadable, /UNCOUNTED, not absent/);
});

t('un coffre dont un fichier ne se mesure pas rend null, PAS une taille partielle', () => {
  const v = statKO.r.find((x) => x.wallet);
  assert.strictEqual(v.bytes, null);
  /* Avant: la somme des fichiers lisibles, presentee comme la taille totale — et 0 si tout etait
   * verrouille, c'est-a-dire « coffre vide ». */
  assert.notStrictEqual(v.bytes, 0);
  assert.match(v.unreadable, /unknown rather than small/);
});

t('un coffre verrouille est signale, pas saute', () => {
  assert.ok(coffreKO.r.length > 0);
  assert.strictEqual(coffreKO.lisibles.length, 0);
  assert.match(coffreKO.illisibles[0].unreadable, /could not be listed/);
});

t('le chemin qui INFORME n a pas ete avale par le durcissement', () => {
  /* Les deux bornes: un durcissement qui rend tout « illisible » n'informe plus. */
  assert.ok(ok.lisibles.length > 0, 'un disque lisible doit produire des coffres lisibles');
  assert.strictEqual(ok.illisibles.length, 0);
  assert.strictEqual(ok.lisibles[0].bytes, 2000, 'deux fichiers de 1000 octets');
  assert.strictEqual(ok.lisibles[0].files, 2);
});

t('les quatre situations sont DISTINGUABLES deux a deux', () => {
  /* Sans ce cas, aplatir deux modes l un sur l autre resterait vert tant qu ils ne se croisent pas. */
  const signature = (x) => x.r.length + ':' + x.lisibles.length + ':' + x.illisibles.length;
  const vues = new Set([ok, baseKO, coffreKO, statKO].map(signature));
  assert.strictEqual(vues.size, 3, 'ok / base-verrouillee / (coffre|stat) doivent se distinguer');
  /* coffre-verrouille et stat-rate ont la meme forme; c'est la RAISON qui les separe. */
  assert.notStrictEqual(coffreKO.illisibles[0].unreadable, statKO.illisibles[0].unreadable);
});

t('la vraie machine reste lisible — non-regression', () => {
  /* Le seul cas qui touche le disque reel, en LECTURE SEULE et sans rien afficher de sensible. */
  const reel = K.findVaults();
  assert.ok(Array.isArray(reel));
  for (const v of reel) {
    assert.ok(typeof v.bytes === 'number' || v.bytes === null, 'bytes est un nombre ou null, jamais autre chose');
    if (v.bytes === null) assert.ok(v.unreadable, 'une taille nulle DOIT porter sa raison');
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
