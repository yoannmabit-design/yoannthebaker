/* ============================================================
   Calcul du prix client — Yoann's French Bakery
   Module partagé entre la vitrine (index.html) et le checkout
   (checkout.html) : les deux pages doivent annoncer exactement le
   même montant, une seule règle est donc écrite ici.

   Deux remises existent, elles ne se cumulent jamais :
     - le tarif de groupe, un pourcentage porté par le compte client,
       appliqué produit par produit et arrondi au peso — sur tout le
       panier par défaut, ou seulement sur certains rayons/produits si
       le compte porte une portée (voir ligneConcerneeParGroupe) ;
     - le code promo, appliqué au sous-total.
   On calcule les deux sous-totaux et on retient le plus avantageux.
   À égalité, le tarif de groupe l'emporte : inutile de consommer un
   code pour le même prix.

   La remise ne porte jamais sur les frais de retrait ou de livraison.

   Un code ne vaut qu'une fois par client — voir usagesClient().
   ============================================================ */

import { doc, getDoc }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export const CLE_CODE = "code_promo";

/* Rayons de la vitrine, dans l'ordre d'affichage. La même liste sert au
   classement du catalogue et à la portée des codes promo : un rayon ajouté
   ici est aussitôt disponible des deux côtés. */
export const RAYONS = ["Breads", "Pastries", "Cakes", "Frozen", "Other"];

/* Repli pour les produits publiés avant l'existence des rayons : on
   retombe sur la catégorie technique de la fiche. */
export function rayonDe(p) {
  if (p && p.rayon && RAYONS.includes(p.rayon)) return p.rayon;
  const c = ((p && (p.categorie || p.category)) || "").toLowerCase();
  if (c.includes("pain")) return "Breads";
  if (c.includes("viennoiserie")) return "Pastries";
  return "Other";
}

/* Portée d'un code : liste vide ou absente = tout le panier. */
export function porteeDe(fiche) {
  const r = (fiche && Array.isArray(fiche.rayons)) ? fiche.rayons.filter(Boolean) : [];
  return r;
}

// Un produit est-il concerné par ce code ?
export function ligneConcernee(ligne, fiche) {
  const portee = porteeDe(fiche);
  if (!portee.length) return true;
  return portee.includes(ligne.rayon || "Other");
}

/* Portée du tarif de groupe d'un compte — même principe que la portée d'un
   code promo, mais réglée sur le compte plutôt que sur le code. Vide des
   trois côtés (rayons, produits, qte_min) = comportement historique, la
   remise porte sur tout le panier ; aucun compte existant n'est donc
   affecté tant que ces champs ne sont pas renseignés. Un produit précis
   l'emporte sur un rayon si les deux sont renseignés à la fois, plus
   spécifique gagne. */
function ligneCorrespondPortee(ligne, scope) {
  const produits = (scope && Array.isArray(scope.produits)) ? scope.produits.filter(Boolean) : [];
  const rayons = (scope && Array.isArray(scope.rayons)) ? scope.rayons.filter(Boolean) : [];
  if (!produits.length && !rayons.length) return true;
  if (produits.length) return !!(ligne.code && produits.includes(ligne.code));
  return rayons.includes(ligne.rayon || "Other");
}

/* Applique en plus le seuil de quantité minimale, s'il y en a un : porte
   sur le total cumulé des lignes déjà retenues par rayon/produit (ou sur
   tout le panier si aucune portée rayon/produit n'est réglée) — pas sur
   le panier entier indépendamment de la portée. En dessous du seuil,
   aucune des lignes normalement concernées n'obtient la remise : un achat
   de complément ne doit pas profiter du même tarif que l'achat en gros. */
export function lignesEligiblesGroupe(lignes, scope) {
  const arr = lignes || [];
  const correspondent = arr.map(l => ligneCorrespondPortee(l, scope));
  const qteMin = Number(scope && scope.qte_min) || 0;
  if (qteMin <= 0) return correspondent;
  const qteCorrespondante = arr.reduce(
    (t, l, i) => correspondent[i] ? t + (Number(l.qte) || 0) : t, 0);
  return qteCorrespondante >= qteMin ? correspondent : arr.map(() => false);
}

// Libellé anglais de la portée, pour les messages au client.
export function libellePortee(fiche) {
  const p = porteeDe(fiche);
  if (!p.length) return "";
  if (p.length === 1) return p[0];
  return p.slice(0, -1).join(", ") + " and " + p[p.length - 1];
}

/* ---------- Saisie ---------- */

// Le client peut taper en minuscules, avec des espaces ou des accents.
export function normaliserCode(saisie) {
  return (saisie || "")
    .toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9-]/g, "");
}

/* ---------- Mémoire de l'appareil ----------
   Le code suit le panier : saisi sur la vitrine, il est retrouvé au
   checkout, et inversement. */
export function lireCodeMemorise() {
  try { return normaliserCode(localStorage.getItem(CLE_CODE) || ""); }
  catch { return ""; }
}
export function memoriserCode(code) {
  try { localStorage.setItem(CLE_CODE, normaliserCode(code)); } catch {}
}
export function oublierCode() {
  try { localStorage.removeItem(CLE_CODE); } catch {}
}

/* ---------- Lecture de la fiche ----------
   L'identifiant du document EST le code : un seul accès suffit. */
export async function chargerCode(db, saisie) {
  const code = normaliserCode(saisie);
  if (!code) return null;
  const s = await getDoc(doc(db, "codes_promo", code));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

/* ---------- Validité ----------
   Renvoie { ok } ou { ok:false, message } — message affiché au client,
   donc rédigé en anglais.

   Les bornes de dates sont vides tant que l'étape suivante n'est pas
   livrée : le test est sans effet aujourd'hui, mais un code daté saisi
   à la main dans Firestore sera déjà respecté. */
/* ---------- Usage par client ----------
   Un code ne vaut qu'une fois par personne. Le comptage porte sur ce que
   le client a déjà engagé : ses commandes libres portant ce code, et ses
   abonnements l'ayant retenu.

   Un abonnement ne compte que pour un usage, même s'il produit huit
   commandes : celles-ci portent un abonnement_id et sont donc écartées,
   l'usage étant déjà porté par l'abonnement lui-même.

   Les commandes annulées et les abonnements arrêtés ne consomment rien :
   un client dont la commande n'a pas abouti n'a pas usé son droit.

   Les fonctions Firestore sont passées en paramètre plutôt qu'importées
   ici : ce module est chargé par des pages qui ont déjà leur propre jeu
   d'imports, et rien ne justifie d'en tirer un second.

   Ce contrôle vit côté client et se contournerait en trafiquant la page.
   C'est une barrière, pas un coffre-fort — suffisant pour des codes
   distribués à des populations connues.

   Renvoie le nombre d'usages déjà consommés. En cas d'échec de lecture,
   renvoie 0 : mieux vaut laisser passer un code que bloquer un client
   sur une panne réseau. */
export async function usagesClient(db, uid, code, fs) {
  const id = normaliserCode(code);
  if (!db || !uid || !id || !fs) return 0;
  const { collection, query, where, getDocs, limit } = fs;
  let n = 0;

  try {
    const s = await getDocs(query(collection(db, "commandes"),
                                  where("compte_uid", "==", uid), limit(100)));
    s.forEach(d => {
      const c = d.data() || {};
      if (c.abonnement_id) return;
      if (c.statut === "annulee") return;
      if (c.code_promo && c.code_promo.code === id) n += 1;
    });
  } catch (e) { console.error(e); }

  try {
    const s = await getDocs(query(collection(db, "abonnements"),
                                  where("client.uid", "==", uid), limit(50)));
    s.forEach(d => {
      const a = d.data() || {};
      if (a.statut === "arrete") return;
      if (a.promo && a.promo.code === id) n += 1;
    });
  } catch (e) { console.error(e); }

  return n;
}

export function verifierCode(fiche, { connecte = false, quand = new Date(), usages = 0 } = {}) {
  if (!fiche)            return { ok: false, message: "We don't recognise that code." };
  if (fiche.actif === false)
    return { ok: false, message: "That code is no longer available." };

  // Un code est nominatif : il suppose un compte pour être décompté.
  if (!connecte)
    return { ok: false, message: "Please sign in to use a promo code.", connexion: true };

  const jour = jourISO(quand);
  if (fiche.date_debut && jour < fiche.date_debut)
    return { ok: false, message: "That code isn't active yet." };
  if (fiche.date_fin && jour > fiche.date_fin)
    return { ok: false, message: "That code has expired." };

  const valeur = Number(fiche.valeur) || 0;
  if (valeur <= 0) return { ok: false, message: "That code is no longer available." };

  // Une fois par personne. Le refus est prononcé dès l'application du
  // code, pas au moment de valider : inutile de composer tout un panier
  // pour apprendre ensuite que le code ne vaut plus.
  if (Number(usages) > 0)
    return { ok: false, message: "You've already used this code." };

  return { ok: true };
}

function jourISO(d) {
  const x = new Date(d);
  return x.getFullYear() + "-" +
         String(x.getMonth() + 1).padStart(2, "0") + "-" +
         String(x.getDate()).padStart(2, "0");
}

/* ---------- Prix ---------- */

// Tarif de groupe : produit par produit, arrondi au peso.
export function prixGroupe(base, remise) {
  const b = Number(base) || 0;
  const r = Number(remise) || 0;
  return r > 0 ? Math.round(b * (1 - r / 100)) : b;
}

/* lignes : [{ qte, prixBase, rayon, code }]
   remise : pourcentage du tarif de groupe (0 si aucun)
   fiche  : code promo déjà vérifié, ou null
   remiseScope : portée du tarif de groupe { rayons: [], produits: [], qte_min }
                 — vide ou omis = tout le panier, comme avant.

   Le tarif de groupe porte sur le panier, ou sur la part que sa portée
   couvre si elle en a une (et seulement si le seuil de quantité minimale,
   s'il y en a un, est atteint) ; le code promo ne porte que sur les rayons
   de sa portée à lui. On compare malgré tout les deux sous-totaux du
   panier entier : c'est le montant que paie le client.

   Renvoie :
     base                  sous-total au tarif catalogue
     groupe                sous-total au tarif de groupe (lignes hors portée au prix catalogue)
     promo                 sous-total avec le code
     eligible              part du panier concernée par le code
     sousTotal             celui retenu
     source                "groupe" | "promo" | "aucune"
     economie              base − sousTotal
     lignesGroupeEligibles tableau parallèle à "lignes" : cette ligne est-elle
                            dans la portée du tarif de groupe ? à repasser à
                            prixUnitaire ligne par ligne, pour ne pas
                            recalculer la portée à chaque appel.
*/
export function calculerPrix(lignes, remise, fiche, remiseScope) {
  const arr = lignes || [];
  const base = arr.reduce(
    (t, l) => t + (Number(l.qte) || 0) * (Number(l.prixBase) || 0), 0);

  const lignesGroupeEligibles = lignesEligiblesGroupe(arr, remiseScope);
  const groupe = arr.reduce((t, l, i) => {
    const prix = lignesGroupeEligibles[i]
      ? prixGroupe(l.prixBase, remise) : (Number(l.prixBase) || 0);
    return t + (Number(l.qte) || 0) * prix;
  }, 0);

  // Part du panier sur laquelle le code peut mordre.
  const eligible = fiche
    ? arr.reduce((t, l) => ligneConcernee(l, fiche)
        ? t + (Number(l.qte) || 0) * (Number(l.prixBase) || 0) : t, 0)
    : 0;

  let promo = base;
  if (fiche) {
    const v = Number(fiche.valeur) || 0;
    // Un montant fixe plus grand que la part concernée est ramené à
    // cette part : la remise ne déborde jamais sur le reste du panier.
    const reduction = fiche.type === "montant"
      ? Math.min(v, eligible)
      : Math.round(eligible * v / 100);
    promo = base - reduction;
  }

  let source = "aucune", sousTotal = base;
  if (groupe < base && groupe <= promo)      { source = "groupe"; sousTotal = groupe; }
  else if (fiche && promo < base && promo < groupe) { source = "promo"; sousTotal = promo; }

  return { base, groupe, promo, eligible, sousTotal, source, economie: base - sousTotal, lignesGroupeEligibles };
}

// Prix unitaire réellement facturé, selon la remise retenue.
// Avec un code promo la remise porte sur le total : les lignes gardent
// leur prix catalogue et la réduction s'affiche à part.
// ligneEligible : cette ligne précise est-elle dans la portée du tarif de
// groupe ? Par défaut oui, pour ne rien changer aux appels existants qui
// n'ont pas encore de portée à faire valoir.
export function prixUnitaire(prixBase, remise, source, ligneEligible = true) {
  return (source === "groupe" && ligneEligible) ? prixGroupe(prixBase, remise) : (Number(prixBase) || 0);
}

// Libellé anglais de la remise, pour le récapitulatif.
export function libelleCode(fiche) {
  if (!fiche) return "";
  const v = Number(fiche.valeur) || 0;
  const montant = fiche.type === "montant" ? "₱" + v + " off" : v + "% off";
  const portee = libellePortee(fiche);
  return portee ? montant + " " + portee : montant;
}
