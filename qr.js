/* ============================================================
   Générateur de QR code — Yoann's French Bakery
   Sans dépendance : ni CDN, ni bibliothèque tierce. La page fonctionne
   hors ligne et rien ne casse si un service extérieur disparaît.

   Mode octet, correction d'erreur au choix, versions 1 à 10 — largement
   de quoi encoder une adresse web. La sortie est une matrice de booléens,
   à charge de l'appelant d'en faire un SVG ou un canevas.

   Conforme à la norme ISO/IEC 18004 : polynômes de Reed-Solomon,
   entrelacement des blocs, choix du masque par les quatre pénalités.
   ============================================================ */

/* ---------- Corps de Galois GF(256) ----------
   Les tables d'exponentielles et de logarithmes évitent de refaire une
   multiplication polynomiale à chaque octet. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function tables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;   // polynôme générateur du corps
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// Polynôme générateur pour n octets de correction.
function generateur(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const suivant = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      suivant[j] ^= g[j];
      suivant[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = suivant;
  }
  return g;
}

// Octets de correction d'un bloc de données.
function correction(donnees, n) {
  const g = generateur(n);
  const reste = new Array(donnees.length + n).fill(0);
  donnees.forEach((d, i) => reste[i] = d);
  for (let i = 0; i < donnees.length; i++) {
    const facteur = reste[i];
    if (!facteur) continue;
    for (let j = 0; j < g.length; j++) reste[i + j] ^= mul(g[j], facteur);
  }
  return reste.slice(donnees.length);
}

/* ---------- Tables de la norme ----------
   Par version : nombre total d'octets de données, octets de correction par
   bloc, puis la répartition en blocs (groupe 1 et groupe 2).
   Ordre des niveaux : L, M, Q, H. */
const NIVEAUX = { L: 0, M: 1, Q: 2, H: 3 };

// [octets de correction par bloc, blocs groupe 1, octets/bloc g1, blocs g2, octets/bloc g2]
const BLOCS = {
  1:  [[7,1,19,0,0],   [10,1,16,0,0],  [13,1,13,0,0],  [17,1,9,0,0]],
  2:  [[10,1,34,0,0],  [16,1,28,0,0],  [22,1,22,0,0],  [28,1,16,0,0]],
  3:  [[15,1,55,0,0],  [26,1,44,0,0],  [18,2,17,0,0],  [22,2,13,0,0]],
  4:  [[20,1,80,0,0],  [18,2,32,0,0],  [26,2,24,0,0],  [16,4,9,0,0]],
  5:  [[26,1,108,0,0], [24,2,43,0,0],  [18,2,15,2,16], [22,2,11,2,12]],
  6:  [[18,2,68,0,0],  [16,4,27,0,0],  [24,4,19,0,0],  [28,4,15,0,0]],
  7:  [[20,2,78,0,0],  [18,4,31,0,0],  [18,2,14,4,15], [26,4,13,1,14]],
  8:  [[24,2,97,0,0],  [22,2,38,2,39], [22,4,18,2,19], [26,4,14,2,15]],
  9:  [[30,2,116,0,0], [22,3,36,2,37], [20,4,16,4,17], [24,4,12,4,13]],
  10: [[18,2,68,2,69], [26,4,43,1,44], [24,6,19,2,20], [28,6,15,2,16]]
};

// Position des motifs d'alignement, par version.
const ALIGNEMENTS = {
  1: [], 2: [6,18], 3: [6,22], 4: [6,26], 5: [6,30],
  6: [6,34], 7: [6,22,38], 8: [6,24,42], 9: [6,26,46], 10: [6,28,50]
};

function capacite(version, niveau) {
  const [ec, b1, o1, b2, o2] = BLOCS[version][NIVEAUX[niveau]];
  return b1 * o1 + b2 * o2;
}

/* ---------- Écriture des bits ---------- */
class Flux {
  constructor() { this.bits = []; }
  pousser(valeur, longueur) {
    for (let i = longueur - 1; i >= 0; i--) this.bits.push((valeur >> i) & 1);
  }
}

/* ---------- Encodage ---------- */
function octetsUTF8(texte) {
  return Array.from(new TextEncoder().encode(texte));
}

function encoder(texte, version, niveau) {
  const donnees = octetsUTF8(texte);
  const f = new Flux();

  f.pousser(0b0100, 4);                              // mode octet
  f.pousser(donnees.length, version < 10 ? 8 : 16);  // longueur
  donnees.forEach(o => f.pousser(o, 8));

  const total = capacite(version, niveau) * 8;
  // Terminateur, puis alignement sur l'octet.
  for (let i = 0; i < 4 && f.bits.length < total; i++) f.bits.push(0);
  while (f.bits.length % 8) f.bits.push(0);

  // Remplissage alterné imposé par la norme.
  const bourrage = [0xEC, 0x11];
  let n = 0;
  while (f.bits.length < total) f.pousser(bourrage[n++ % 2], 8);

  const octets = [];
  for (let i = 0; i < f.bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | f.bits[i + j];
    octets.push(v);
  }

  /* Découpage en blocs, puis entrelacement : les octets des blocs sont
     émis colonne par colonne, ce qui répartit un éventuel dégât. */
  const [ec, b1, o1, b2, o2] = BLOCS[version][NIVEAUX[niveau]];
  const blocs = [];
  let curseur = 0;
  for (let i = 0; i < b1; i++) { blocs.push(octets.slice(curseur, curseur + o1)); curseur += o1; }
  for (let i = 0; i < b2; i++) { blocs.push(octets.slice(curseur, curseur + o2)); curseur += o2; }

  const corrections = blocs.map(b => correction(b, ec));

  const sortie = [];
  const maxDonnees = Math.max(o1, o2);
  for (let i = 0; i < maxDonnees; i++)
    blocs.forEach(b => { if (i < b.length) sortie.push(b[i]); });
  for (let i = 0; i < ec; i++)
    corrections.forEach(c => sortie.push(c[i]));

  return sortie;
}

/* ---------- Trame ---------- */
function nouvelleTrame(taille) {
  return Array.from({ length: taille }, () => new Array(taille).fill(null));
}

function poserMotifs(m, version) {
  const t = m.length;

  // Les trois repères d'orientation, avec leur séparateur blanc.
  const repere = (li, co) => {
    for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
      const y = li + i, x = co + j;
      if (y < 0 || y >= t || x < 0 || x >= t) continue;
      const bord = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
                   (j >= 0 && j <= 6 && (i === 0 || i === 6));
      const coeur = i >= 2 && i <= 4 && j >= 2 && j <= 4;
      m[y][x] = bord || coeur;
    }
  };
  repere(0, 0); repere(0, t - 7); repere(t - 7, 0);

  // Motifs d'alignement, sauf là où ils chevaucheraient un repère.
  const pos = ALIGNEMENTS[version];
  pos.forEach(li => pos.forEach(co => {
    if ((li <= 8 && co <= 8) || (li <= 8 && co >= t - 9) || (li >= t - 9 && co <= 8)) return;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++)
      m[li + i][co + j] = Math.max(Math.abs(i), Math.abs(j)) !== 1;
  }));

  // Les deux lignes de synchronisation.
  for (let i = 8; i < t - 8; i++) {
    if (m[6][i] === null) m[6][i] = i % 2 === 0;
    if (m[i][6] === null) m[i][6] = i % 2 === 0;
  }

  m[t - 8][8] = true;   // module toujours noir
}

// Emplacements réservés à l'information de format.
function reserverFormat(m) {
  const t = m.length;
  for (let i = 0; i <= 8; i++) {
    if (m[8][i] === null) m[8][i] = false;
    if (m[i][8] === null) m[i][8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][t - 1 - i] === null) m[8][t - 1 - i] = false;
    if (m[t - 1 - i][8] === null) m[t - 1 - i][8] = false;
  }
}

const MASQUES = [
  (l, c) => (l + c) % 2 === 0,
  (l) => l % 2 === 0,
  (l, c) => c % 3 === 0,
  (l, c) => (l + c) % 3 === 0,
  (l, c) => (Math.floor(l / 2) + Math.floor(c / 3)) % 2 === 0,
  (l, c) => (l * c) % 2 + (l * c) % 3 === 0,
  (l, c) => (((l * c) % 2 + (l * c) % 3) % 2) === 0,
  (l, c) => (((l + c) % 2 + (l * c) % 3) % 2) === 0
];

/* Parcours en zigzag depuis le coin inférieur droit, en sautant la
   colonne 6 qui porte la synchronisation. */
function poserDonnees(m, octets, masque, reserve) {
  const t = m.length;
  let bit = 0, montant = true;

  for (let co = t - 1; co > 0; co -= 2) {
    if (co === 6) co--;
    for (let n = 0; n < t; n++) {
      const li = montant ? t - 1 - n : n;
      for (let k = 0; k < 2; k++) {
        const x = co - k;
        if (reserve[li][x]) continue;
        const octet = octets[bit >> 3];
        let valeur = octet !== undefined && ((octet >> (7 - (bit & 7))) & 1) === 1;
        if (MASQUES[masque](li, x)) valeur = !valeur;
        m[li][x] = valeur;
        bit++;
      }
    }
    montant = !montant;
  }
}

// Information de format : 5 bits utiles, code BCH, puis masquage fixe.
function poserFormat(m, niveau, masque) {
  const t = m.length;
  const bitsNiveau = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }[niveau];
  let format = (bitsNiveau << 3) | masque;
  let reste = format << 10;
  for (let i = 4; i >= 0; i--)
    if (reste & (1 << (i + 10))) reste ^= 0b10100110111 << i;
  const bits = ((format << 10) | reste) ^ 0b101010000010010;

  /* La norme numérote les bits du plus significatif au moins significatif :
     le bit 0 est celui de poids fort. */
  const lire = (i) => ((bits >> (14 - i)) & 1) === 1;

  // Première copie, autour du repère supérieur gauche.
  for (let i = 0; i <= 5; i++) m[8][i] = lire(i);
  m[8][7] = lire(6);
  m[8][8] = lire(7);
  m[7][8] = lire(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = lire(i);

  // Seconde copie : sept bits sous le repère inférieur gauche, huit à
  // droite du repère supérieur droit.
  for (let i = 0; i <= 6; i++) m[t - 1 - i][8] = lire(i);
  for (let i = 7; i <= 14; i++) m[8][t - 15 + i] = lire(i);

  m[t - 8][8] = true;
}

/* ---------- Pénalités, pour choisir le masque ---------- */
function penalite(m) {
  const t = m.length;
  let score = 0;

  // 1. Suites de cinq modules identiques ou plus.
  const suite = (lire) => {
    for (let a = 0; a < t; a++) {
      let compte = 1;
      for (let b = 1; b < t; b++) {
        if (lire(a, b) === lire(a, b - 1)) compte++;
        else { if (compte >= 5) score += 3 + (compte - 5); compte = 1; }
      }
      if (compte >= 5) score += 3 + (compte - 5);
    }
  };
  suite((a, b) => m[a][b]);
  suite((a, b) => m[b][a]);

  // 2. Carrés de deux sur deux.
  for (let l = 0; l < t - 1; l++) for (let c = 0; c < t - 1; c++)
    if (m[l][c] === m[l][c + 1] && m[l][c] === m[l + 1][c] &&
        m[l][c] === m[l + 1][c + 1]) score += 3;

  // 3. Motif ressemblant à un repère d'orientation.
  const cible1 = [true,false,true,true,true,false,true,false,false,false,false];
  const cible2 = [false,false,false,false,true,false,true,true,true,false,true];
  const cherche = (lire) => {
    for (let a = 0; a < t; a++) for (let b = 0; b <= t - 11; b++) {
      let un = true, deux = true;
      for (let k = 0; k < 11; k++) {
        const v = lire(a, b + k);
        if (v !== cible1[k]) un = false;
        if (v !== cible2[k]) deux = false;
      }
      if (un) score += 40;
      if (deux) score += 40;
    }
  };
  cherche((a, b) => m[a][b]);
  cherche((a, b) => m[b][a]);

  // 4. Déséquilibre entre noir et blanc.
  let noirs = 0;
  m.forEach(l => l.forEach(v => { if (v) noirs++; }));
  const part = (noirs * 100) / (t * t);
  score += Math.floor(Math.abs(part - 50) / 5) * 10;

  return score;
}

/* ---------- Entrée publique ----------
   Renvoie { taille, modules } où modules[ligne][colonne] vaut true pour
   un module noir. */
export function qr(texte, niveau = "M") {
  if (!NIVEAUX.hasOwnProperty(niveau)) niveau = "M";

  const longueur = octetsUTF8(texte).length;
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const entete = 4 + (v < 10 ? 8 : 16);
    if (longueur + Math.ceil(entete / 8) <= capacite(v, niveau)) { version = v; break; }
  }
  if (!version) throw new Error("Texte trop long pour un QR code de version 10.");

  const octets = encoder(texte, version, niveau);
  const taille = version * 4 + 17;

  // Une trame de référence sert à repérer les modules réservés.
  const reference = nouvelleTrame(taille);
  poserMotifs(reference, version);
  reserverFormat(reference);
  const reserve = reference.map(l => l.map(v => v !== null));

  let meilleure = null, meilleurScore = Infinity;
  for (let masque = 0; masque < 8; masque++) {
    const m = reference.map(l => l.slice());
    poserDonnees(m, octets, masque, reserve);
    poserFormat(m, niveau, masque);
    const s = penalite(m);
    if (s < meilleurScore) { meilleurScore = s; meilleure = m; }
  }

  return { taille, modules: meilleure.map(l => l.map(v => v === true)) };
}

/* SVG carré, prêt à afficher ou à imprimer. La marge de quatre modules
   est imposée par la norme : sans elle, beaucoup de lecteurs échouent. */
export function qrSvg(texte, { niveau = "M", taille = 320, marge = 4,
                               couleur = "#1c1917", fond = "#ffffff" } = {}) {
  const { taille: n, modules } = qr(texte, niveau);
  const total = n + marge * 2;

  let chemin = "";
  for (let l = 0; l < n; l++) for (let c = 0; c < n; c++)
    if (modules[l][c]) chemin += `M${c + marge} ${l + marge}h1v1h-1z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${taille}" height="${taille}" ` +
         `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" ` +
         `aria-label="QR code">` +
         `<rect width="${total}" height="${total}" fill="${fond}"/>` +
         `<path d="${chemin}" fill="${couleur}"/></svg>`;
}
