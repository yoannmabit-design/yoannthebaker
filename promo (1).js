/* ============================================================
   Calcul du prix client — Yoann's French Bakery
   Module partagé entre la vitrine (index.html) et le checkout
   (checkout.html) : les deux pages doivent annoncer exactement le
   même montant, une seule règle est donc écrite ici.

   Deux remises existent, elles ne se cumulent jamais :
     - le tarif de groupe, un pourcentage porté par le compte client,
       appliqué produit par produit et arrondi au peso ;
     - le code promo, appliqué au sous-total.
   On calcule les deux sous-totaux et on retient le plus avantageux.
   À égalité, le tarif de groupe l'emporte : inutile de consommer un
   code pour le même prix.

   La remise ne porte jamais sur les frais de retrait ou de livraison.
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
export function verifierCode(fiche, { connecte = false, quand = new Date() } = {}) {
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

/* lignes : [{ qte, prixBase, rayon }]
   remise : pourcentage du tarif de groupe (0 si aucun)
   fiche  : code promo déjà vérifié, ou null

   Le tarif de groupe porte sur tout le panier ; le code promo ne porte
   que sur les rayons de sa portée. On compare malgré tout les deux
   sous-totaux du panier entier : c'est le montant que paie le client.

   Renvoie :
     base        sous-total au tarif catalogue
     groupe      sous-total au tarif de groupe
     promo       sous-total avec le code
     eligible    part du panier concernée par le code
     sousTotal   celui retenu
     source      "groupe" | "promo" | "aucune"
     economie    base − sousTotal
*/
export function calculerPrix(lignes, remise, fiche) {
  const base = (lignes || []).reduce(
    (t, l) => t + (Number(l.qte) || 0) * (Number(l.prixBase) || 0), 0);

  const groupe = (lignes || []).reduce(
    (t, l) => t + (Number(l.qte) || 0) * prixGroupe(l.prixBase, remise), 0);

  // Part du panier sur laquelle le code peut mordre.
  const eligible = fiche
    ? (lignes || []).reduce((t, l) => ligneConcernee(l, fiche)
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

  return { base, groupe, promo, eligible, sousTotal, source, economie: base - sousTotal };
}

// Prix unitaire réellement facturé, selon la remise retenue.
// Avec un code promo la remise porte sur le total : les lignes gardent
// leur prix catalogue et la réduction s'affiche à part.
export function prixUnitaire(prixBase, remise, source) {
  return source === "groupe" ? prixGroupe(prixBase, remise) : (Number(prixBase) || 0);
}

// Libellé anglais de la remise, pour le récapitulatif.
export function libelleCode(fiche) {
  if (!fiche) return "";
  const v = Number(fiche.valeur) || 0;
  const montant = fiche.type === "montant" ? "₱" + v + " off" : v + "% off";
  const portee = libellePortee(fiche);
  return portee ? montant + " " + portee : montant;
}
