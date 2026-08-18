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

/* lignes : [{ qte, prixBase }]
   remise : pourcentage du tarif de groupe (0 si aucun)
   fiche  : code promo déjà vérifié, ou null

   Renvoie :
     base        sous-total au tarif catalogue
     groupe      sous-total au tarif de groupe
     promo       sous-total avec le code
     sousTotal   celui retenu
     source      "groupe" | "promo" | "aucune"
     economie    base − sousTotal
*/
export function calculerPrix(lignes, remise, fiche) {
  const base = (lignes || []).reduce(
    (t, l) => t + (Number(l.qte) || 0) * (Number(l.prixBase) || 0), 0);

  const groupe = (lignes || []).reduce(
    (t, l) => t + (Number(l.qte) || 0) * prixGroupe(l.prixBase, remise), 0);

  let promo = base;
  if (fiche) {
    const v = Number(fiche.valeur) || 0;
    promo = fiche.type === "montant"
      ? Math.max(0, base - v)
      : Math.round(base * (1 - v / 100));
  }

  let source = "aucune", sousTotal = base;
  if (groupe < base && groupe <= promo)      { source = "groupe"; sousTotal = groupe; }
  else if (fiche && promo < base && promo < groupe) { source = "promo"; sousTotal = promo; }

  return { base, groupe, promo, sousTotal, source, economie: base - sousTotal };
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
  return fiche.type === "montant" ? "₱" + v + " off" : v + "% off";
}
