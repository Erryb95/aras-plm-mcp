/**
 * Rilascio dimostrativo di 15 Part intestate a Davide Romano.
 *
 *  1. mappa di workflow "ZZ Rilascio Semplice":
 *       Start -> Approvazione Tecnica -> Rilasciata | Respinta
 *  2. la rende il workflow predefinito delle Part (Allowed Workflow, is_default=1)
 *  3. crea le 15 Part: Aras avvia il processo da se' alla creazione
 *  4. approva ogni processo e porta la Part a Released
 *
 * Nota trovata sul campo: <ApplyItem> applica UN SOLO Item. Un batch <AML> con
 * piu' elementi viene accettato ma esegue solo il primo, senza errore: ogni
 * elemento va quindi applicato con una chiamata propria.
 *
 *   node tools/rilascio-parti-demo.mjs            esegue
 *   node tools/rilascio-parti-demo.mjs --pulisci  rimuove parti, mappa e predefinito
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { aml, token } from "./aml.mjs";

const PULISCI = process.argv.includes("--pulisci");
const MAPPA = "ZZ Rilascio Semplice";
const ITEMTYPE_PART = "4F1AC04A2B484F3ABA4E20DB63808A88";

const guid = () => randomUUID().split("-").join("").toUpperCase();
const esc = (s) => String(s).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");
const fault = (xml) => { const m = xml.match(/<faultstring>\s*(?:<!\[CDATA\[)?([^\]<]*)/); return m && m[1].trim() ? m[1].trim() : null; };
const primoId = (xml, tipo) => {
  const re = new RegExp('<Item type="' + tipo + '" typeId="[0-9A-F]{32}" id="([0-9A-F]{32})"');
  const m = xml.match(re);
  return m ? m[1] : null;
};

let tk;
async function applica(xml, tipo) {
  const r = await aml(xml, tk);
  const f = fault(r);
  if (f) return { errore: f };
  return { id: primoId(r, tipo), xml: r };
}

const c = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ARAS_READONLY: "false" },
});
c.stderr.on("data", (d) => process.stderr.write("[server] " + d));
let buf = "", rid = 1; const pend = new Map();
c.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!l) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  }
});
const rpc = (me, pa) => new Promise((r, j) => {
  const i = rid++; pend.set(i, r);
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: me, params: pa }) + "\n");
  setTimeout(() => j(new Error("timeout " + me)), 120000);
});
const call = async (n, a = {}) => {
  const r = await rpc("tools/call", { name: n, arguments: a });
  const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
  try { return JSON.parse(t); } catch { return { _testo: t }; }
};

const PARTI = [
  ["AD-3001", "Corpo pompa ghisa DN80", "Make", 142.5],
  ["AD-3002", "Coperchio aspirazione", "Make", 63.0],
  ["AD-3003", "Girante chiusa 210 mm", "Make", 188.4],
  ["AD-3004", "Albero rettificato AISI 431", "Make", 96.2],
  ["AD-3005", "Anello di usura aspirazione", "Buy", 21.8],
  ["AD-3006", "Tenuta meccanica 45 mm", "Buy", 154.0],
  ["AD-3007", "Cuscinetto radiale 6309", "Buy", 34.7],
  ["AD-3008", "Cuscinetto obliquo 7310", "Buy", 58.9],
  ["AD-3009", "Supporto cuscinetti", "Make", 112.3],
  ["AD-3010", "Lanterna motore IEC 160", "Make", 87.6],
  ["AD-3011", "Giunto elastico 60 Nm", "Buy", 76.4],
  ["AD-3012", "Protezione giunto", "Make", 28.1],
  ["AD-3013", "Basamento saldato", "Make", 203.7],
  ["AD-3014", "Kit guarnizioni EPDM", "Buy", 19.5],
  ["AD-3015", "Targhetta identificativa", "Buy", 4.2],
];

// Il where="[Tipo].name=..." non regge i nomi di ItemType con spazi: Aras
// rifiuta il riferimento alla tabella e restituisce zero righe senza errore.
// Il confronto per proprieta' invece funziona.
async function idPerNome(tipo, nome) {
  const r = await aml('<Item type="' + tipo + '" action="get" select="id"><name>' +
    esc(nome) + "</name></Item>", tk);
  return primoId(r, tipo);
}

async function idRigaAllowed() {
  const r = await aml('<Item type="Allowed Workflow" action="get" select="id,related_id" maxRecords="50"/>', tk);
  const blocchi = r.split('<Item type="Allowed Workflow"');
  for (const b of blocchi) {
    if (b.includes(MAPPA)) {
      const m = b.match(/^ typeId="[0-9A-F]{32}" id="([0-9A-F]{32})"/);
      if (m) return m[1];
    }
  }
  return null;
}

async function eliminaPartiEProbe(elenco) {
  for (const n of elenco) {
    const r = await call("aras_query_items", { itemType: "Part", filter: "item_number eq '" + n + "'", select: ["id"], top: 5 });
    for (const it of r.items ?? []) {
      await aml('<Item type="Part" action="delete" id="' + it.id + '"/>', tk);
    }
  }
}

async function creaMappa() {
  const map = guid(), aStart = guid(), aAppr = guid(), aRil = guid(), aResp = guid();

  const r = await applica('<Item type="Workflow Map" action="add" id="' + map + '"><name>' + esc(MAPPA) +
    "</name><description>Rilascio semplice di una Part: una sola approvazione tecnica.</description></Item>", "Workflow Map");
  if (r.errore) return { errore: "mappa: " + r.errore };

  // Activity Template e' un ItemType dipendente: creato da solo risponde
  // "source item not found". Va creato dentro la riga Workflow Map Activity
  // che lo lega alla mappa.
  const nodo = async (id, nome, extra, x, y) => {
    const r = await applica('<Item type="Workflow Map Activity" action="add"><source_id>' + map +
      "</source_id><x>" + x + "</x><y>" + y + "</y><related_id>" +
      '<Item type="Activity Template" action="add" id="' + id + '"><name>' + esc(nome) + "</name>" + extra +
      "<wait_for_all_inputs>0</wait_for_all_inputs><wait_for_all_votes>0</wait_for_all_votes>" +
      "<reminder_count>0</reminder_count><reminder_interval>0</reminder_interval>" +
      "<timeout_duration>0</timeout_duration></Item></related_id></Item>", "Workflow Map Activity");
    if (r.errore) throw new Error("attivita' " + nome + ": " + r.errore);
  };

  await nodo(aStart, "Start", "<is_start>1</is_start><is_auto>1</is_auto><is_end>0</is_end><can_delegate>0</can_delegate><can_refuse>0</can_refuse><expected_duration>0</expected_duration><icon>../images/WorkflowStart.svg</icon><priority>2</priority>", 12, 95);
  await nodo(aAppr, "Approvazione Tecnica", "<is_start>0</is_start><is_auto>0</is_auto><is_end>0</is_end><can_delegate>1</can_delegate><can_refuse>1</can_refuse><expected_duration>3</expected_duration><icon>../images/WorkflowNode.svg</icon><priority>2</priority>", 200, 95);
  await nodo(aRil, "Rilasciata", "<is_start>0</is_start><is_auto>1</is_auto><is_end>1</is_end><can_delegate>0</can_delegate><can_refuse>0</can_refuse><expected_duration>0</expected_duration><icon>../images/WorkflowNode.svg</icon><priority>1</priority>", 430, 95);
  await nodo(aResp, "Respinta", "<is_start>0</is_start><is_auto>1</is_auto><is_end>1</is_end><can_delegate>0</can_delegate><can_refuse>0</can_refuse><expected_duration>0</expected_duration><icon>../images/Delete.svg</icon><priority>1</priority>", 200, 200);

  for (const [da, a, nome, def] of [[aStart, aAppr, "Begin", 1], [aAppr, aRil, "Approva", 1], [aAppr, aResp, "Respingi", 0]]) {
    const v = await applica('<Item type="Workflow Map Path" action="add"><source_id>' + da +
      "</source_id><related_id>" + a + "</related_id><name>" + esc(nome) +
      "</name><is_default>" + def + "</is_default></Item>", "Workflow Map Path");
    if (v.errore) return { errore: "via " + nome + ": " + v.errore };
  }

  return { id: map, attivita: { aStart, aAppr, aRil, aResp } };
}

async function strutturaMappa(mapId) {
  const r = await aml('<Item type="Workflow Map" action="get" id="' + mapId + '" select="name">' +
    '<Relationships><Item type="Workflow Map Activity" action="get" select="related_id"><Related>' +
    '<Item type="Activity Template" action="get" select="name,is_start,is_end">' +
    '<Relationships><Item type="Activity Template Assignment" action="get" select="related_id"/></Relationships>' +
    "</Item></Related></Item></Relationships></Item>", tk);
  const nodi = [...r.matchAll(/type="Activity Template">([^<]+)</g)].map((m) => m[1]);
  const ident = [...r.matchAll(/keyed_name="([^"]+)" type="Identity"/g)].map((m) => m[1]);
  return { nodi: [...new Set(nodi)], identita: [...new Set(ident)] };
}

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "rilascio", version: "1" } });
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  tk = await token();

  const numeri = PARTI.map((p) => p[0]);
  const sonde = ["ZZ-PROBE-WF", "ZZ-PROBE-WF2", "ZZ-PROBE-WF3", "ZZ-PROBE-WF4", "ZZ-PROBE-WF5", "ZZ-PROBE-WF6", "ZZ-PROBE-WF7", "ZZ-SONDA-AVVIO"];

  if (PULISCI) {
    console.log("=== pulizia ===");
    const riga = await idRigaAllowed();
    if (riga) {
      await aml('<Item type="Allowed Workflow" action="edit" id="' + riga + '"><is_default>0</is_default></Item>', tk);
      await aml('<Item type="ItemType" action="edit" id="' + ITEMTYPE_PART + '"><is_versionable>1</is_versionable></Item>', tk);
      console.log("  workflow predefinito disattivato sulle Part");
      await aml('<Item type="Allowed Workflow" action="delete" id="' + riga + '"/>', tk);
    }
    await eliminaPartiEProbe([...numeri, ...sonde]);
    console.log("  rimosse le Part AD-30xx e le sonde");
    const m = await idPerNome("Workflow Map", MAPPA);
    if (m) { await aml('<Item type="Workflow Map" action="delete" id="' + m + '"/>', tk); console.log("  rimossa la mappa " + MAPPA); }
    process.exit(0);
  }

  console.log("=== 0. terreno pulito ===\n");
  const riga0 = await idRigaAllowed();
  if (riga0) {
    await aml('<Item type="Allowed Workflow" action="edit" id="' + riga0 + '"><is_default>0</is_default></Item>', tk);
    await aml('<Item type="ItemType" action="edit" id="' + ITEMTYPE_PART + '"><is_versionable>1</is_versionable></Item>', tk);
    await aml('<Item type="Allowed Workflow" action="delete" id="' + riga0 + '"/>', tk);
  }
  await eliminaPartiEProbe([...numeri, ...sonde]);
  const vecchia = await idPerNome("Workflow Map", MAPPA);
  if (vecchia) await aml('<Item type="Workflow Map" action="delete" id="' + vecchia + '"/>', tk);
  console.log("  rimosse eventuali Part e mappe di prova precedenti");

  console.log("\n=== 1. mappa di workflow ===\n");
  const mp = await creaMappa();
  if (mp.errore) { console.log("  FALLITA: " + mp.errore); process.exit(1); }

  const idEng = await idPerNome("Identity", "ACME Engineering");
  const asg = await applica('<Item type="Activity Template Assignment" action="add"><source_id>' +
    mp.attivita.aAppr + "</source_id><related_id>" + idEng + "</related_id></Item>", "Activity Template Assignment");
  if (asg.errore) { console.log("  assegnazione FALLITA: " + asg.errore); process.exit(1); }

  const st = await strutturaMappa(mp.id);
  console.log("  attivita': " + st.nodi.join(" | "));
  console.log("  approvazione assegnata a: " + st.identita.join(", "));
  if (st.nodi.length !== 4) { console.log("  FALLITA: attese 4 attivita', trovate " + st.nodi.length); process.exit(1); }

  console.log("\n=== 2. workflow predefinito delle Part ===\n");
  const add = await applica('<Item type="Allowed Workflow" action="add"><source_id>' + ITEMTYPE_PART +
    "</source_id><related_id>" + mp.id + "</related_id><is_default>1</is_default></Item>", "Allowed Workflow");
  if (add.errore) { console.log("  FALLITO: " + add.errore); process.exit(1); }
  await aml('<Item type="ItemType" action="edit" id="' + ITEMTYPE_PART + '"><is_versionable>1</is_versionable></Item>', tk);
  console.log("  registrato e cache dell'ItemType invalidata");

  // Chi esegue deve poter fare due cose distinte, ognuna con il proprio ruolo:
  //   votare l'attivita'  -> appartenere all'identita' assegnataria
  //   promuovere la Part  -> possedere il ruolo della transizione di ciclo di vita
  // Senza il primo Aras dice "User is not from allowed identity"; senza il secondo
  // dice "failed to get the transition", che sembra un difetto ed e' un permesso.
  console.log("\n=== 2b. ruoli di chi esegue ===\n");
  const alias = await idPerNome("Identity", "Super User");
  for (const g of ["ACME Engineering", "Aras PLM"]) {
    const gid = await idPerNome("Identity", g);
    const r = await applica('<Item type="Member" action="add"><source_id>' + gid +
      "</source_id><related_id>" + alias + "</related_id></Item>", "Member");
    console.log("  Super User -> " + g + (r.errore ? "   (gia' presente o " + r.errore + ")" : "   aggiunto"));
  }

  console.log("\n=== 3. prova di avvio automatico ===\n");
  const sonda = await applica('<Item type="Part" action="add"><item_number>ZZ-SONDA-AVVIO</item_number><name>sonda</name></Item>', "Part");
  if (sonda.errore) {
    console.log("  la creazione di una Part fallisce: " + sonda.errore);
    console.log("  ANNULLO il workflow predefinito per non lasciare l'istanza rotta.");
    const r = await idRigaAllowed();
    if (r) {
      await aml('<Item type="Allowed Workflow" action="edit" id="' + r + '"><is_default>0</is_default></Item>', tk);
      await aml('<Item type="ItemType" action="edit" id="' + ITEMTYPE_PART + '"><is_versionable>1</is_versionable></Item>', tk);
    }
    process.exit(1);
  }
  const wf = await call("aras_get_workflow", { itemId: sonda.id, conAttivita: true });
  const attiva = wf.processi?.[0]?.dettaglioAttivita?.find((a) => a.stato === "Active");
  console.log("  processi sulla sonda: " + (wf.processi?.length ?? 0) +
    (attiva ? "   attivita' attiva: " + attiva.nome + "   vie: " + (attiva.vie ?? []).map((v) => v.nome).join("/") : ""));
  await eliminaPartiEProbe(["ZZ-SONDA-AVVIO"]);
  if (!wf.processi?.length) {
    console.log("  nessun processo avviato: mi fermo qui senza creare le 15 Part.");
    process.exit(1);
  }

  console.log("\n=== 4. quindici Part intestate a Davide Romano ===\n");
  const idDavide = await idPerNome("Identity", "Davide Romano");
  const creati = [];
  for (const [num, nome, mb, costo] of PARTI) {
    const r = await call("aras_create_item", {
      itemType: "Part",
      properties: {
        item_number: num, name: nome, make_buy: mb, unit: "EA", cost: costo,
        owned_by_id: idDavide, description: "Famiglia dimostrativa ARAS DEMO",
      },
    });
    const id = r.item?.id ?? r.id;
    if (!id) { console.log("  FAIL " + num + "  " + JSON.stringify(r).slice(0, 200)); continue; }
    creati.push({ num, nome, id });
  }
  console.log("  create: " + creati.length + "/15");

  console.log("\n=== 5. approvazione ===\n");
  let approvate = 0;
  for (const p of creati) {
    const r = await call("aras_advance_change", { changeId: p.id, via: "Approva", dryRun: false, commenti: "Approvazione tecnica dimostrativa" });
    if (r.avanzata) approvate++;
    else console.log("  FAIL " + p.num + "  " + JSON.stringify(r).slice(0, 200));
  }
  console.log("  approvate: " + approvate + "/" + creati.length);

  console.log("\n=== 6. rilascio ===\n");
  let rilasciate = 0;
  for (const p of creati) {
    const s = await call("aras_get_lifecycle_state", { itemType: "Part", id: p.id });
    if (s.statoAttuale === "Released") { rilasciate++; continue; }
    const r = await call("aras_promote_item", { itemType: "Part", id: p.id, toState: "Released" });
    if (r.promosso) rilasciate++;
    else console.log("  FAIL " + p.num + "  " + JSON.stringify(r).slice(0, 200));
  }
  console.log("  rilasciate: " + rilasciate + "/" + creati.length);

  console.log("\n=== 7. verifica ===\n");
  const v = await call("aras_query_items", {
    itemType: "Part", filter: "startswith(item_number,'AD-30')",
    select: ["item_number", "name", "state", "owned_by_id"], orderby: "item_number asc", top: 30,
  });
  for (const it of v.items ?? []) {
    console.log("  " + String(it.item_number).padEnd(9) + String(it.state ?? "?").padEnd(12) +
      String(it["owned_by_id@aras.keyed_name"] ?? "").padEnd(16) + it.name);
  }
  const acme = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'PMP-')", select: ["id"], top: 50 });
  console.log("\n  dati ACME intatti: " + acme.totaleCorrispondenti + " Part PMP- (attese 8)");
} finally { c.kill(); }
