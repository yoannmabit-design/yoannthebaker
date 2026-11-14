/* abo.js — logique commune aux abonnements.
   Partagé entre l'administration (abonnements-admin.html) et l'espace
   client (compte.html), sur le modèle de promo.js : le calcul du report
   vit ici et nulle part ailleurs, pour que les deux faces ne divergent
   pas à la première évolution.

   Ce module ne produit aucun libellé affichable : la vitrine parle
   anglais, l'administration français. Chaque page formule ses textes à
   partir des valeurs rendues ici.

   Vocabulaire, tel qu'écrit en base :
     abonnement.statut   nouveau · actif · arrete · termine
     echeance.statut     planifiee · livree · sautee
     echeance.livree_le  horodatage, posé à la livraison
     echeance.decalee    true si déplacée par une absence du boulanger
     echeance.date_initiale  date prévue avant ce déplacement
     echeance.par        "client" ou "boulangerie" : qui a demandé le report
     abonnement.reports  compteur des seuls reports demandés par le client
*/

import { doc, getDoc, updateDoc }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* Au-delà de ce plafond l'échéance est perdue : sans lui un abonnement
   pourrait s'étirer indéfiniment. Seuls les reports demandés par le
   client sont comptés ; les décalages dus aux absences du boulanger
   déplacent les dates sans consommer ce quota. */
export const MAX_REPORTS = 2;

/* Un client ne peut pas décaler une livraison au dernier moment : la
   production est déjà lancée. L'administration, elle, n'est pas soumise
   à ce délai — elle passe delaiHeures: 0. */
export const DELAI_REPORT_HEURES = 48;

export function pasJours(cadence) {
  return cadence === "quinzaine" ? 14 : 7;
}

export function reportsFaits(abo) {
  return Number(abo && abo.reports) || 0;
}

export function reportsRestants(abo) {
  return Math.max(0, MAX_REPORTS - reportsFaits(abo));
}

export function echeances(abo) {
  return Array.isArray(abo && abo.echeances) ? abo.echeances : [];
}

/* Les échéances sont triées par date plutôt que laissées dans l'ordre du
   tableau : un report ajoute la sienne à la fin, et une absence du
   boulanger déplace des dates sur place. L'ordre du tableau ne reflète
   donc plus la chronologie. */
export function echeancesTriees(abo) {
  return echeances(abo)
    .map((e, index) => ({ ...e, index }))
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

export function aVenir(abo) {
  return echeancesTriees(abo).filter(e => e.statut === "planifiee");
}

export function passees(abo) {
  return echeancesTriees(abo).filter(e => e.statut !== "planifiee");
}

export function prochaine(abo) {
  return aVenir(abo)[0] || null;
}

/* Rang affichable d'une échéance : « 3 / 8 ». Le total suit le tableau
   réel plutôt que nb_livraisons, qui ne tient pas compte des échéances
   ajoutées par un report. */
export function rang(abo, date) {
  const liste = echeancesTriees(abo);
  const i = liste.findIndex(e => e.date === date);
  return i < 0 ? null : { position: i + 1, total: liste.length };
}

export function iso(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 10);
}

/* ---------- Droit à reporter ----------
   Rendu séparément du calcul pour que l'interface puisse désactiver un
   bouton et dire pourquoi, plutôt que de laisser le client cliquer pour
   se voir opposer un refus. */
export function peutReporter(abo, date, options) {
  const o = options || {};
  const delai = o.delaiHeures === undefined ? DELAI_REPORT_HEURES : Number(o.delaiHeures);
  const maintenant = o.maintenant instanceof Date ? o.maintenant : new Date();

  if (!abo) return { ok: false, raison: "introuvable" };
  if (abo.statut !== "actif") return { ok: false, raison: "abonnement_inactif" };

  const e = echeances(abo).find(x => x.date === date);
  if (!e) return { ok: false, raison: "echeance_introuvable" };
  if (e.statut !== "planifiee") return { ok: false, raison: "deja_traitee" };

  if (reportsRestants(abo) <= 0)
    return { ok: false, raison: "plafond_atteint", restants: 0 };

  // La livraison est prévue en journée : midi sert de repère, comme
  // partout ailleurs dans le site pour éviter les surprises de fuseau.
  const quand = new Date(date + "T12:00:00");
  if (isNaN(quand)) return { ok: false, raison: "date_invalide" };
  if (quand - maintenant < delai * 3600000)
    return { ok: false, raison: "trop_tard", delaiHeures: delai };

  return { ok: true, restants: reportsRestants(abo) };
}

/* ---------- Calcul du report ----------
   Fonction pure : elle ne lit ni n'écrit rien, elle rend le tableau
   d'échéances tel qu'il devrait devenir. Elle est ainsi vérifiable
   isolément, et sert aussi bien à prévisualiser qu'à écrire.

   Règle reprise telle quelle de l'administration : l'échéance sautée
   passe en "sautee" et une nouvelle est ajoutée un pas après la
   dernière planifiée, pour que le client reçoive bien le nombre de
   livraisons payées. */
export function calculerReport(abo, date, origine) {
  const par = origine === "boulangerie" ? "boulangerie" : "client";
  const liste = echeances(abo);
  const i = liste.findIndex(e => e.date === date && e.statut === "planifiee");
  if (i < 0) return null;

  const suite = liste.map((e, n) =>
    n === i ? { ...e, statut: "sautee", par, saute_le: new Date().toISOString() } : e);

  const maj = {};
  let jusquA = null;

  // Un report demandé par la boulangerie ne consomme pas le quota du
  // client, mais replace tout de même la livraison.
  const compte = par === "client";
  if (!compte || reportsRestants(abo) > 0) {
    const derniere = suite.filter(e => e.statut === "planifiee")
      .map(e => e.date).sort().pop() || date;
    const d = new Date(derniere + "T12:00:00");
    d.setDate(d.getDate() + pasJours(abo.cadence));
    jusquA = iso(d);
    suite.push({ date: jusquA, statut: "planifiee", ajoutee_par: par });
    if (compte) maj.reports = reportsFaits(abo) + 1;
  }

  maj.echeances = suite;
  // Sauter la dernière échéance sans report possible clôt le plan.
  if (!suite.some(e => e.statut === "planifiee")) maj.statut = "termine";

  return { maj, jusquA, perdue: !jusquA };
}

/* ---------- Absence du boulanger ----------
   Fonction pure, comme calculerReport : elle rend le tableau d'échéances
   tel qu'il devrait devenir, sans rien lire ni écrire.

   Règle : seules les livraisons qui tombent PENDANT l'absence bougent.
   Chacune est replacée à la fin du plan, un pas après la dernière
   livraison prévue ; tout ce qui était prévu après l'absence reste à sa
   date. Décaler la suite entière, comme on le faisait avant, déplaçait
   des livraisons que l'absence ne touchait pas, et changeait de semaine
   les abonnés à la quinzaine.

   L'échéance est déplacée sur place — même ligne du tableau, donc même
   rang — au lieu d'être sautée puis recréée. C'est le rang qui nomme la
   commande générée (ABO-<abonnement>-<rang>) : en le conservant, la
   commande déjà créée suit simplement sa livraison à la nouvelle date,
   sans annulation ni doublon.

   Le pas est celui de la cadence, compté depuis la dernière livraison
   prévue : le jour de la semaine du client est donc conservé.

   Relancer le calcul sur la même période ne fait rien : plus aucune
   livraison prévue n'y tombe. Le quota de reports du client n'est pas
   touché, ce n'est pas lui qui s'absente. */
export function calculerAbsence(abo, debut, fin) {
  const liste = echeances(abo);
  const dedans = (e) => e.statut === "planifiee" && e.date >= debut && e.date <= fin;

  const touchees = liste
    .map((e, index) => ({ e, index }))
    .filter(x => dedans(x.e))
    .sort((a, b) => a.e.date.localeCompare(b.e.date));
  if (!touchees.length) return null;

  // Dernière livraison prévue hors absence. S'il n'y en a pas — l'absence
  // couvre toute la fin du plan — on repart de la dernière touchée.
  const dehors = liste.filter(e => e.statut === "planifiee" && !dedans(e)).map(e => e.date);
  let derniere = dehors.length
    ? dehors.sort().pop()
    : touchees[touchees.length - 1].e.date;

  const pas = pasJours(abo.cadence);
  const suite = liste.slice();
  const mouvements = [];

  touchees.forEach(({ e, index }) => {
    const d = new Date(derniere + "T12:00:00");
    // Au moins un pas, puis autant qu'il faut pour sortir de l'absence.
    do { d.setDate(d.getDate() + pas); } while (iso(d) <= fin);
    const vers = iso(d);
    suite[index] = {
      ...e, date: vers, decalee: true, par: "boulangerie",
      // La toute première date prévue, gardée pour l'historique même si
      // l'échéance est déplacée plusieurs fois.
      date_initiale: e.date_initiale || e.date
    };
    mouvements.push({ rang: index + 1, de: e.date, vers });
    derniere = vers;
  });

  return { maj: { echeances: suite }, mouvements };
}

/* ---------- Écriture ----------
   Le document est relu sur le serveur avant d'écrire : l'administration
   peut l'avoir modifié pendant que la page du client était ouverte, et
   c'est le premier endroit du site où les deux écrivent au même
   endroit. Seuls echeances, reports et statut sont touchés ; tout le
   reste du document est laissé intact.

   L'échéance est désignée par sa date et non par son rang dans le
   tableau : un report antérieur ou une absence du boulanger a pu
   décaler les indices depuis l'affichage. */
export async function reporter(db, id, date, options) {
  const o = options || {};
  const origine = o.origine === "boulangerie" ? "boulangerie" : "client";

  let abo;
  try {
    const s = await getDoc(doc(db, "abonnements", id));
    if (!s.exists()) return { ok: false, raison: "introuvable" };
    abo = { id: s.id, ...s.data() };
  } catch (e) {
    console.error(e);
    return { ok: false, raison: "lecture" };
  }

  // Le droit est revérifié sur la version du serveur, pas sur celle qui
  // était affichée : le plafond a pu être atteint entre-temps.
  const droit = peutReporter(abo, date, o);
  if (!droit.ok) return { ok: false, raison: droit.raison, abo };

  const calcul = calculerReport(abo, date, origine);
  if (!calcul) return { ok: false, raison: "echeance_introuvable", abo };

  try {
    await updateDoc(doc(db, "abonnements", id), calcul.maj);
  } catch (e) {
    console.error(e);
    return { ok: false, raison: "ecriture", abo };
  }

  return {
    ok: true,
    jusquA: calcul.jusquA,
    perdue: calcul.perdue,
    abo: { ...abo, ...calcul.maj },
    restants: origine === "client"
      ? Math.max(0, MAX_REPORTS - (calcul.maj.reports ?? reportsFaits(abo)))
      : reportsRestants(abo)
  };
}
