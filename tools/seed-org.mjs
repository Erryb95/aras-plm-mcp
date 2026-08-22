/**
 * Popola l'istanza con un'organizzazione manifatturiera completa: reparti, utenti,
 * prodotto multilivello, disegni, CAD, fornitori con AML, e un ciclo di modifica ECR/ECN.
 *
 * Idempotente: rilanciarlo non duplica nulla (cerca prima di creare).
 * Ogni passo riporta esito proprio, cosi' un fallimento parziale resta visibile
 * invece di far crollare l'intero seeding.
 */
const BASE = process.env.ARAS_URL ?? "http://localhost/InnovatorServer";
const DB = process.env.ARAS_DATABASE ?? "InnovatorSolutions";

// Si usa "root", non "admin": diversi ItemType (Manufacturer, ECN, ...) hanno permessi
// di Add concessi solo a identita' specifiche, e admin non ne fa parte -> "Add access is
// denied". root e' il super user e scavalca i permessi. Va bene per popolare dati di
// prova su un'istanza locale; in produzione si userebbe un utente con i ruoli giusti.
const SEED_USER = process.env.ARAS_SEED_USER ?? "root";
const SEED_PASS = process.env.ARAS_SEED_PASSWORD ?? "innovator";

const tok = await (async () => {
  const r = await fetch(`${BASE}/OAuthServer/connect/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "IOMApp", scope: "Innovator",
      database: DB, username: SEED_USER, password: SEED_PASS }),
  });
  if (!r.ok) throw new Error(`token HTTP ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
})();
console.log(`autenticato come ${SEED_USER} su ${DB}`);
const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Accept: "application/json" };
const url = (t, q = "") => `${BASE}/Server/OData/${encodeURIComponent(t)}${q}`;

const stats = { creati: 0, esistenti: 0, falliti: 0 };
const failures = [];

async function post(type, body) {
  const r = await fetch(url(type), { method: "POST", headers: H, body: JSON.stringify(body) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

async function findOne(type, filter, select = "id") {
  const r = await fetch(url(type, `?$filter=${encodeURIComponent(filter)}&$select=${select}`), { headers: H });
  if (!r.ok) return null;
  return (await r.json()).value?.[0] ?? null;
}

/** Crea se assente. Restituisce l'elemento, o null se la creazione fallisce. */
async function ensure(type, keyFilter, body, label) {
  try {
    const found = await findOne(type, keyFilter);
    if (found) { stats.esistenti++; return found; }
    const made = await post(type, body);
    stats.creati++;
    console.log(`  + ${type.padEnd(20)} ${label}`);
    return made;
  } catch (e) {
    stats.falliti++;
    failures.push(`${type} "${label}": ${e.message}`);
    console.log(`  ! ${type.padEnd(20)} ${label}  -> ${e.message.slice(0, 120)}`);
    return null;
  }
}

/** Relazione: evita duplicati sulla coppia (source, related). */
async function relate(relType, source, related, extra = {}, label = "") {
  if (!source?.id || !related?.id) return null;
  return ensure(
    relType,
    `source_id eq '${source.id}' and related_id eq '${related.id}'`,
    { source_id: source.id, related_id: related.id, ...extra },
    label || `${source.id.slice(0, 6)} -> ${related.id.slice(0, 6)}`
  );
}

// ═══════════════════════════════════════════════════════ 1. ORGANIZZAZIONE
console.log("\n[1/6] Reparti e utenti");

const REPARTI = [
  ["ACME Engineering", "Progettazione meccanica e idraulica"],
  ["ACME Manufacturing", "Produzione e industrializzazione"],
  ["ACME Quality", "Controllo qualita' e conformita'"],
  ["ACME Purchasing", "Acquisti e gestione fornitori"],
];
const reparti = {};
for (const [name, description] of REPARTI) {
  reparti[name] = await ensure("Identity", `name eq '${name}'`, { name, description }, name);
}

const UTENTI = [
  ["mrossi", "Marco", "Rossi", "m.rossi@acme-pumps.it", "ACME Engineering"],
  ["lbianchi", "Laura", "Bianchi", "l.bianchi@acme-pumps.it", "ACME Engineering"],
  ["gverdi", "Giulia", "Verdi", "g.verdi@acme-pumps.it", "ACME Quality"],
  ["pneri", "Paolo", "Neri", "p.neri@acme-pumps.it", "ACME Manufacturing"],
  ["sferrari", "Sara", "Ferrari", "s.ferrari@acme-pumps.it", "ACME Purchasing"],
];
const utenti = {};
for (const [login_name, first_name, last_name, email, reparto] of UTENTI) {
  const u = await ensure("User", `login_name eq '${login_name}'`,
    { login_name, first_name, last_name, email, company_name: "ACME Pumps S.p.A." },
    `${first_name} ${last_name} (${reparto})`);
  utenti[login_name] = u;
  if (!u || !reparti[reparto]) continue;

  // Aras crea automaticamente un'Identity "alias" per ogni User (nome = "Nome Cognome",
  // is_alias=1) e ne ammette una sola, quindi crearne un'altra fallisce. L'appartenenza
  // a un reparto si esprime con Member: reparto -> identita' dell'utente.
  const aliasIdentity = await findOne("Identity", `name eq '${first_name} ${last_name}'`);
  if (aliasIdentity) {
    await relate("Member", reparti[reparto], aliasIdentity, {}, `${reparto} <- ${first_name} ${last_name}`);
  } else {
    stats.falliti++;
    failures.push(`Member: identita' alias di "${first_name} ${last_name}" non trovata`);
  }
}

// ═══════════════════════════════════════════════════════════ 2. PRODOTTO
console.log("\n[2/6] Struttura di prodotto");

const PARTI = [
  ["PMP-2000", "Pompa centrifuga CP-40", "Assieme finito, portata 40 m3/h", "make"],
  ["PMP-2100", "Gruppo idraulico", "Sottoassieme idraulico", "make"],
  ["PMP-2110", "Girante", "Girante chiusa, ghisa sferoidale", "make"],
  ["PMP-2120", "Corpo pompa", "Corpo a voluta", "make"],
  ["PMP-2130", "Tenuta meccanica", "Tenuta meccanica singola", "buy"],
  ["PMP-2200", "Gruppo motore", "Sottoassieme motore", "make"],
  ["PMP-2210", "Lanterna", "Lanterna di accoppiamento", "make"],
  ["PMP-2300", "Basamento", "Basamento in acciaio saldato", "make"],
  ["MOT-0500", "Motore elettrico 4 kW", "Motore asincrono trifase 4 poli", "buy"],
  ["HW-0010", "Vite M8x30", "Vite TCEI M8x30 inox A2", "buy"],
  ["HW-0020", "Rondella M8", "Rondella piana M8 inox A2", "buy"],
];
const parti = {};
for (const [item_number, name, description] of PARTI) {
  parti[item_number] = await ensure("Part", `item_number eq '${item_number}'`,
    { item_number, name, description }, `${item_number}  ${name}`);
}

// HW-0010 compare in due rami distinti: caso di prova per le quantita' cumulate
// e per il rilevamento dei cicli, che deve essere per-ramo e non globale.
const DISTINTA = [
  ["PMP-2000", "PMP-2100", 1], ["PMP-2000", "PMP-2200", 1],
  ["PMP-2000", "PMP-2300", 1], ["PMP-2000", "HW-0020", 12],
  ["PMP-2100", "PMP-2110", 1], ["PMP-2100", "PMP-2120", 1],
  ["PMP-2100", "PMP-2130", 1], ["PMP-2100", "HW-0010", 8],
  ["PMP-2200", "MOT-0500", 1], ["PMP-2200", "PMP-2210", 1],
  ["PMP-2200", "HW-0010", 4],
];
console.log("  distinta base:");
for (const [padre, figlio, qta] of DISTINTA) {
  await relate("Part BOM", parti[padre], parti[figlio], { quantity: String(qta) }, `${padre} -> ${figlio} x${qta}`);
}

// ═══════════════════════════════════════════════════ 3. DISEGNI E DOCUMENTI
console.log("\n[3/6] Disegni e documenti");

const DOCUMENTI = [
  ["DRW-2000", "Disegno assieme CP-40", "Disegno di assieme, scala 1:5", "PMP-2000"],
  ["DRW-2110", "Disegno girante", "Disegno di dettaglio girante", "PMP-2110"],
  ["DRW-2120", "Disegno corpo pompa", "Disegno di dettaglio corpo", "PMP-2120"],
  ["SPC-0001", "Specifica materiali", "Specifica materiali e trattamenti", "PMP-2000"],
  ["MAN-0001", "Manuale installazione", "Manuale di installazione e uso", "PMP-2000"],
];
const documenti = {};
for (const [item_number, name, description, parte] of DOCUMENTI) {
  const d = await ensure("Document", `item_number eq '${item_number}'`,
    { item_number, name, description }, `${item_number}  ${name}`);
  documenti[item_number] = d;
  if (d && parti[parte]) await relate("Part Document", parti[parte], d, {}, `${parte} -> ${item_number}`);
}

const CADS = [
  ["CAD-2110", "Girante 3D", "Modello 3D girante", "PMP-2110"],
  ["CAD-2120", "Corpo pompa 3D", "Modello 3D corpo", "PMP-2120"],
  ["CAD-2000", "Assieme CP-40 3D", "Modello 3D assieme", "PMP-2000"],
];
const cads = {};
for (const [item_number, name, description, parte] of CADS) {
  const c = await ensure("CAD", `item_number eq '${item_number}'`,
    { item_number, name, description }, `${item_number}  ${name}`);
  cads[item_number] = c;
  if (c && parti[parte]) await relate("Part CAD", parti[parte], c, {}, `${parte} -> ${item_number}`);
}

// ═══════════════════════════════════════════════════════ 4. FORNITORI / AML
console.log("\n[4/6] Fornitori e AML");

const COSTRUTTORI = [
  ["Siemens AG", "Monaco", "Germania"],
  ["SKF Group", "Goteborg", "Svezia"],
  ["Trelleborg Sealing", "Trelleborg", "Svezia"],
  ["Bossard Italia", "Milano", "Italia"],
];
const costruttori = {};
for (const [name, city, paese] of COSTRUTTORI) {
  costruttori[name] = await ensure("Manufacturer", `name eq '${name}'`,
    { name, city, description: `Fornitore, sede ${city} (${paese})` }, name);
}

const MPN = [
  ["1LE1003-1CB2", "Motore 4kW IE3", "Siemens AG", "MOT-0500"],
  ["HJ-40-SIC", "Tenuta meccanica 40mm", "Trelleborg Sealing", "PMP-2130"],
  ["BN-6912-A2", "Vite TCEI M8x30 A2", "Bossard Italia", "HW-0010"],
  ["BN-6913-A2", "Rondella M8 A2", "Bossard Italia", "HW-0020"],
];
for (const [item_number, name, costruttore, parte] of MPN) {
  const mp = await ensure("Manufacturer Part", `item_number eq '${item_number}'`,
    { item_number, name }, `${item_number}  ${name}`);
  if (mp && costruttori[costruttore]) {
    await relate("Manufacturer Manf Part", costruttori[costruttore], mp, {}, `${costruttore} -> ${item_number}`);
  }
  if (mp && parti[parte]) await relate("Part AML", parti[parte], mp, {}, `${parte} -> ${item_number}`);
}

// ═══════════════════════════════════════════════════ 5. GESTIONE MODIFICHE
console.log("\n[5/6] Ciclo di modifica ECR/ECN");

// item_number e' di tipo "sequence": lo genera Aras, non va fornito.
const ecr = await ensure("ECR", `title eq 'Cavitazione girante a basso NPSH'`,
  {
    title: "Cavitazione girante a basso NPSH",
    description: "In prova a 40 m3/h con NPSH disponibile ridotto si rileva cavitazione incipiente sulla girante PMP-2110.",
    proposed_solution: "Rivedere il profilo delle pale in ingresso e aumentare il raggio di raccordo al mozzo.",
  },
  "ECR Cavitazione girante");

const ecn = await ensure("ECN", `title eq 'Revisione profilo pale girante PMP-2110'`,
  {
    title: "Revisione profilo pale girante PMP-2110",
    description: "Attuazione della modifica proposta nella ECR sulla cavitazione.",
    implementation_plan: "Aggiornare disegno DRW-2110 e modello CAD-2110, riqualificare con prova NPSH.",
  },
  "ECN Revisione profilo pale");

if (ecn && ecr) await relate("ECN ECR", ecn, ecr, {}, "ECN -> ECR");

// "Affected Item" e' un elemento DIPENDENTE: non esiste da solo.
//   - crearlo prima -> "Dependent Affected Item cannot be create: source item not found"
//   - collegare la Part direttamente -> violazione FOREIGN KEY su AFFECTED_ITEM
// Va creato inline dentro la relazione, passando related_id come OGGETTO anziche' come id.
async function affectedItem(cambio, tipoRel, parte, label) {
  if (!cambio || !parti[parte]) return;
  const partId = parti[parte].id;
  const esistente = await findOne(tipoRel, `source_id eq '${cambio.id}'`);
  if (esistente) { stats.esistenti++; return; }
  try {
    await post(tipoRel, {
      source_id: cambio.id,
      related_id: { affected_id: partId, affected_type: "Part" },
    });
    stats.creati++;
    console.log(`  + ${tipoRel.padEnd(20)} ${label}`);
  } catch (e) {
    stats.falliti++;
    failures.push(`${tipoRel} "${label}": ${e.message}`);
    console.log(`  ! ${tipoRel.padEnd(20)} ${label} -> ${e.message.slice(0, 120)}`);
  }
}

await affectedItem(ecr, "ECR Affected Item", "PMP-2110", "ECR -> PMP-2110 Girante");
await affectedItem(ecn, "ECN Affected Item", "PMP-2110", "ECN -> PMP-2110 Girante");

// ══════════════════════════════════════════════════════════ 6. RIEPILOGO
console.log("\n[6/6] Riepilogo");
for (const t of ["Part", "Document", "CAD", "Manufacturer", "Manufacturer Part", "ECR", "ECN", "Identity", "User"]) {
  const r = await fetch(url(t, "?$top=1&$count=true"), { headers: H });
  const j = r.ok ? await r.json() : {};
  console.log(`  ${t.padEnd(20)} ${j["@odata.count"] ?? "?"}`);
}
console.log(`\ncreati ${stats.creati} · gia' presenti ${stats.esistenti} · falliti ${stats.falliti}`);
if (failures.length) {
  console.log("\nFALLIMENTI:");
  for (const f of failures.slice(0, 25)) console.log(`  - ${f}`);
}
if (parti["PMP-2000"]) console.log(`\nRadice prodotto PMP-2000 id=${parti["PMP-2000"].id}`);
