// Collaudo di tutti i tool sul protocollo MCP reale, contro i dati ACME Pumps.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
let buf = "", id = 1;
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const rpc = (method, params) => new Promise((res, rej) => {
  const i = id++; pending.set(i, res);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  setTimeout(() => rej(new Error(`timeout ${method}`)), 180000);
});
const call = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
  try { return JSON.parse(t); } catch { return { _testo: t }; }
};

let ok = 0, ko = 0;
const check = (nome, cond, dettaglio = "") => {
  if (cond) { ok++; console.log(`  OK   ${nome}`); }
  else { ko++; console.log(`  FAIL ${nome}  ${dettaglio}`); }
};

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = (await rpc("tools/list", {})).result.tools;
  console.log(`\n=== ${tools.length} TOOL ESPOSTI ===`);
  console.log(tools.map((t) => "  " + t.name).join("\n"));

  // id degli elementi ACME
  const byNum = async (tipo, num) => {
    const r = await call("aras_query_items", { itemType: tipo, filter: `item_number eq '${num}'`, select: ["id", "item_number", "name"], top: 1 });
    return r.items?.[0];
  };
  const pompa = await byNum("Part", "PMP-2000");
  const vite = await byNum("Part", "HW-0010");
  const girante = await byNum("Part", "PMP-2110");
  const ecrRes = await call("aras_query_items", { itemType: "ECR", select: ["id", "title"], top: 1 });
  const ecr = ecrRes.items?.[0];

  console.log("\n=== 1. BOM completa PMP-2000 ===");
  const bom = await call("aras_get_bom", { partId: pompa.id, depth: 4 });
  for (const r of bom.distintaPiatta) console.log(`  ${"  ".repeat(r.livello)}L${r.livello} ${r.item_number.padEnd(10)} x${r.qtaCumulata}`);
  const q = (n) => bom.distintaPiatta.filter((r) => r.item_number === n).map((r) => r.qtaCumulata);
  check("HW-0010 compare in due rami", q("HW-0010").length === 2, `trovato ${q("HW-0010").length} volte`);
  check("HW-0010 quantita' 8 e 4", JSON.stringify(q("HW-0010").sort((a,b)=>b-a)) === "[8,4]", JSON.stringify(q("HW-0010")));
  check("HW-0020 quantita' 12", q("HW-0020")[0] === 12, String(q("HW-0020")[0]));
  check("MOT-0500 presente al livello 2", bom.distintaPiatta.some((r) => r.item_number === "MOT-0500" && r.livello === 2));

  console.log("\n=== 2. Where-used della vite HW-0010 ===");
  const wu = await call("aras_where_used", { partId: vite.id, depth: 5 });
  for (const a of wu.assiemi) console.log(`  L${a.livello} ${a.item_number.padEnd(10)} qta ${a.qtaImpiegata}`);
  const nomi = wu.assiemi.map((a) => a.item_number);
  check("usata in PMP-2100", nomi.includes("PMP-2100"));
  check("usata in PMP-2200", nomi.includes("PMP-2200"));
  check("risale fino a PMP-2000", nomi.includes("PMP-2000"));

  console.log("\n=== 3. Documentazione di PMP-2000 ===");
  const docs = await call("aras_get_documents", { partId: pompa.id });
  console.log("  documenti:", docs.documenti.map((d) => d.item_number).join(", "));
  console.log("  CAD      :", docs.modelliCad.map((d) => d.item_number).join(", "));
  check("3 documenti su PMP-2000", docs.documenti.length === 3, String(docs.documenti.length));
  check("1 modello CAD su PMP-2000", docs.modelliCad.length === 1, String(docs.modelliCad.length));

  console.log("\n=== 4. AML della vite ===");
  const amlv = await call("aras_get_aml", { partId: vite.id });
  for (const a of amlv.aml) console.log(`  ${a.manufacturerPart} — ${a.costruttore}`);
  check("almeno un costruttore approvato", amlv.aml.length >= 1);
  check("costruttore risolto", amlv.aml[0]?.costruttore === "Bossard Italia", String(amlv.aml[0]?.costruttore));

  console.log("\n=== 5. Impatto della ECR ===");
  const imp = await call("aras_get_change_impact", { changeType: "ECR", changeId: ecr.id });
  for (const i of imp.impatti) console.log(`  ${i.elemento} (${i.tipo ?? "?"})`);
  check("ECR impatta PMP-2110", imp.impatti.some((i) => i.elemento === "PMP-2110"), JSON.stringify(imp.impatti));

  console.log("\n=== 6. Ciclo di vita della girante ===");
  const lc = await call("aras_get_lifecycle_state", { itemType: "Part", id: girante.id });
  console.log(`  stato=${lc.statoAttuale} rilasciato=${lc.rilasciato} rev=${lc.revisione}`);
  console.log(`  promuovibile a: ${(lc.statiRaggiungibili ?? []).join(", ") || "(nessuno)"}`);
  check("stato del ciclo di vita letto", !!lc.statoAttuale, JSON.stringify(lc).slice(0, 200));

  console.log("\n=== 7. AML grezzo (sola lettura) ===");
  const raw = await call("aras_aml_request", { itemXml: `<Item type="Part" action="get" select="item_number,name" maxRecords="3"/>` });
  console.log("  elementi:", raw.elementi ?? raw.motivo);
  check("query AML eseguita", raw.eseguito === true, JSON.stringify(raw).slice(0, 200));

  console.log("\n=== 8. Scrittura bloccata in sola lettura ===");
  const w = await call("aras_aml_request", { itemXml: `<Item type="Part" action="delete" id="${vite.id}"/>` });
  check("action delete rifiutata", w.eseguito === false, JSON.stringify(w).slice(0, 150));
  const p = await call("aras_promote_item", { itemType: "Part", id: girante.id, toState: "Released" });
  check("promozione rifiutata", p.promosso === false, JSON.stringify(p).slice(0, 150));

  console.log("\n=== 9. Ricerca trasversale 'girante' ===");
  const s1 = await call("aras_search", { term: "girante", perType: 10 });
  for (const h of s1.hits) console.log(`  ${h.itemType.padEnd(10)} ${h.etichetta.padEnd(12)} (${h.campo}: ${h.valore.slice(0, 40)})`);
  const tipiTrovati = new Set(s1.hits.map((h) => h.itemType));
  check("trova la Part PMP-2110", s1.hits.some((h) => h.itemType === "Part" && h.etichetta === "PMP-2110"));
  check("trova il Document DRW-2110", s1.hits.some((h) => h.itemType === "Document" && h.etichetta === "DRW-2110"));
  check("trova il CAD CAD-2110", s1.hits.some((h) => h.itemType === "CAD" && h.etichetta === "CAD-2110"));
  check("attraversa piu' tipi", tipiTrovati.size >= 3, `tipi: ${[...tipiTrovati].join(",")}`);
  check("nessun tipo ignorato per errore", !s1.tipiIgnorati, JSON.stringify(s1.tipiIgnorati));

  console.log("\n=== 10. Ricerca su testo libero 'cavitazione' ===");
  const s2 = await call("aras_search", { term: "cavitazione" });
  for (const h of s2.hits) console.log(`  ${h.itemType.padEnd(10)} ${h.etichetta.padEnd(12)} (${h.campo})`);
  check("trova la ECR dal titolo/descrizione", s2.hits.some((h) => h.itemType === "ECR"), JSON.stringify(s2.hits));

  console.log("\n=== 11. Ricerca per codice, corrispondenza esatta in cima ===");
  const s3 = await call("aras_search", { term: "HW-0010" });
  console.log(`  primo risultato: ${s3.hits[0]?.itemType} ${s3.hits[0]?.etichetta}`);
  check("HW-0010 e' il primo risultato", s3.hits[0]?.etichetta === "HW-0010", JSON.stringify(s3.hits[0]));

  console.log("\n=== 12. Creazione relazione bloccata in sola lettura ===");
  const cr = await call("aras_create_relationship", {
    relationshipType: "Part Document", sourceId: vite.id, relatedId: girante.id,
  });
  check("creazione relazione rifiutata", cr._testo?.includes("sola lettura") || cr.creata === false,
    JSON.stringify(cr).slice(0, 160));
  const cr2 = await call("aras_create_relationship", { relationshipType: "Part Document", sourceId: vite.id });
  check("senza relatedId ne' dipendenti -> errore chiaro", cr2.creata === false && !!cr2.motivo,
    JSON.stringify(cr2).slice(0, 160));

  console.log("\n=== 13. Revisioni della girante ===");
  const rev = await call("aras_get_revisions", { itemType: "Part", id: girante.id });
  console.log(`  config_id=${rev.configId} generazioni=${rev.generazioni} corrente=${rev.corrente}`);
  for (const r of rev.revisioni) console.log(`    gen ${r.generation} rev ${r.majorRev} corrente=${r.isCurrent} stato=${r.state}`);
  check("almeno una generazione", rev.generazioni >= 1, String(rev.generazioni));
  check("config_id risolto", !!rev.configId, JSON.stringify(rev).slice(0, 120));
  check("esiste una generazione corrente", rev.revisioni.some((r) => r.isCurrent));

  console.log("\n=== 14. Piano di cancellazione (nessuna modifica) ===");
  const plP = await call("aras_plan_delete", { itemType: "Part", id: vite.id, modo: "purge" });
  console.log(`  modo=${plP.modo} effetto="${plP.effetto}" eseguibile=${plP.eseguibile}`);
  for (const a of plP.avvertenze) console.log(`    ! ${a}`);
  const usata = plP.dipendenze.filter((d) => d.righe > 0);
  console.log(`  referenziata in: ${usata.map((d) => `${d.relazione}=${d.righe}`).join(", ") || "nessuna"}`);
  check("rileva che la vite e' ancora usata in distinta", usata.some((d) => d.relazione.startsWith("Part BOM")),
    JSON.stringify(usata));
  check("non eseguibile perche' referenziata", plP.eseguibile === false);

  const plD = await call("aras_plan_delete", { itemType: "Part", id: vite.id, modo: "delete" });
  check("delete descrive l'effetto su tutte le generazioni", plD.effetto.includes("tutte"), plD.effetto);
  check("purge e delete hanno effetti diversi", plP.effetto !== plD.effetto);

  console.log("\n=== 15. Cancellazione: protezioni ===");
  // Le protezioni sono stratificate: la sola lettura viene valutata per prima, quindi
  // qui il motivo puo' essere l'una o l'altra. Cio' che conta e' che NON cancelli.
  const d1 = await call("aras_delete_item", { itemType: "Part", id: vite.id, modo: "purge", conferma: false });
  check("senza conferma -> rifiutata", d1.cancellato === false && /conferma|sola lettura/i.test(d1.motivo ?? ""),
    JSON.stringify(d1).slice(0, 140));
  const d2 = await call("aras_delete_item", { itemType: "Part", id: vite.id, modo: "purge", conferma: true });
  check("in sola lettura -> rifiutata", d2.cancellato === false, JSON.stringify(d2).slice(0, 140));
  const nr = await call("aras_new_revision", { itemType: "Part", id: girante.id });
  check("nuova revisione rifiutata in sola lettura", nr.creata === false, JSON.stringify(nr).slice(0, 140));

  console.log("\n=== 16. La vite non e' stata toccata ===");
  const ancora = await call("aras_query_items", { itemType: "Part", filter: `item_number eq 'HW-0010'`, select: ["id"], top: 1 });
  check("HW-0010 esiste ancora", ancora.items?.length === 1, JSON.stringify(ancora).slice(0, 120));

  console.log("\n=== 17. File allegati (vault) ===");
  const drw = (await call("aras_query_items", { itemType: "Document", filter: `item_number eq 'DRW-2110'`, select: ["id"], top: 1 })).items?.[0];
  const fdoc = await call("aras_get_files", { itemType: "Document", id: drw.id });
  console.log(`  ${fdoc.relazione}: ${fdoc.allegati} allegati${fdoc.nota ? ` — ${fdoc.nota}` : ""}`);
  check("lettura file non va in errore", typeof fdoc.allegati === "number", JSON.stringify(fdoc).slice(0, 160));
  check("relazione corretta per Document", fdoc.relazione === "Document File", fdoc.relazione);
  const cad2110 = (await call("aras_query_items", { itemType: "CAD", filter: `item_number eq 'CAD-2110'`, select: ["id"], top: 1 })).items?.[0];
  const fcad = await call("aras_get_files", { itemType: "CAD", id: cad2110.id });
  check("relazione corretta per CAD", fcad.relazione === "CADFiles", fcad.relazione);
  // Nessun file e' caricabile da un client esterno, quindi qui l'elenco e' legittimamente
  // vuoto: si verifica che il tool lo dica invece di fallire.
  check("elenco vuoto gestito con nota esplicita", fdoc.allegati === 0 && !!fdoc.nota, JSON.stringify(fdoc).slice(0, 160));

  console.log("\n=== 18. Workflow della ECR ===");
  const wf = await call("aras_get_workflow", { itemId: ecr.id });
  const proc = wf.processi?.[0];
  if (proc) {
    console.log(`  processo: ${proc.nome} · stato ${proc.stato} · ${proc.attivita} attivita'`);
    console.log(`  aperte: ${(proc.attivitaAperte ?? []).join(", ") || "(nessuna)"}`);
    console.log(`  in carico a: ${(proc.inCaricoA ?? []).join(", ") || "(nessuno)"}`);
    for (const a of (proc.dettaglioAttivita ?? []).slice(0, 6)) {
      const chi = a.assegnazioni.map((s) => s.identita).filter(Boolean).join(", ");
      console.log(`    ${a.iniziale ? "inizio " : a.finale ? "fine   " : "       "} ${String(a.nome).padEnd(22)} stato=${a.stato ?? "-"}${chi ? ` -> ${chi}` : ""}`);
    }
  }
  check("la ECR ha un workflow", (wf.processi?.length ?? 0) >= 1, JSON.stringify(wf).slice(0, 200));
  check("il processo ha attivita'", (proc?.attivita ?? 0) > 0, String(proc?.attivita));
  check("esiste un'attivita' iniziale", (proc?.dettaglioAttivita ?? []).some((a) => a.iniziale));
  check("le assegnazioni sono risolte a un'identita'",
    (proc?.dettaglioAttivita ?? []).some((a) => a.assegnazioni.some((s) => s.identita)),
    JSON.stringify((proc?.dettaglioAttivita ?? []).flatMap((a) => a.assegnazioni.map((s) => s.identita))).slice(0, 200));

  console.log("\n=== 19. InBasket di un'identita' assegnataria ===");
  const identita = (proc?.dettaglioAttivita ?? []).flatMap((a) => a.assegnazioni).find((s) => s.identita)?.identita;
  const idn = await call("aras_query_items", { itemType: "Identity", filter: `name eq '${identita}'`, select: ["id", "name"], top: 1 });
  const idnId = idn.items?.[0]?.id;
  console.log(`  identita': ${identita} (${idnId})`);
  const ib = await call("aras_get_inbasket", { identityId: idnId, soloAperte: true });
  console.log(`  compiti aperti: ${ib.compiti} · in ritardo: ${ib.inRitardo}`);
  for (const c of (ib.elenco ?? []).slice(0, 5)) console.log(`    ${String(c.attivita).padEnd(24)} stato=${c.statoAttivita ?? "-"} richiesta=${c.richiesta}`);
  check("InBasket restituisce compiti", (ib.compiti ?? 0) > 0, JSON.stringify(ib).slice(0, 200));
  check("i compiti riportano l'attivita'", (ib.elenco ?? []).every((c) => !!c.attivita));

  console.log("\n=== 20. Voto attivita' bloccato in sola lettura ===");
  const att = (proc?.dettaglioAttivita ?? []).find((a) => a.assegnazioni.length);
  const vt = await call("aras_vote_activity", { activityId: att.id, assignmentId: att.assegnazioni[0].id, path: "Approve" });
  check("voto rifiutato in sola lettura", vt.votato === false, JSON.stringify(vt).slice(0, 160));

  console.log("\n=== 21. Storico/audit ===");
  const hEcr = await call("aras_get_history", { itemType: "ECR", id: ecr.id, limite: 20 });
  console.log(`  ECR: ${hEcr.eventi} eventi${hEcr.nota ? ` — ${String(hEcr.nota).slice(0, 90)}` : ""}`);
  for (const v of (hEcr.storico ?? []).slice(0, 5)) console.log(`    ${String(v.azione).padEnd(10)} ${v.quando} ${v.chi ?? ""} stato=${v.stato ?? "-"}`);
  check("lo storico non va in errore", typeof hEcr.eventi === "number", JSON.stringify(hEcr).slice(0, 200));
  const hPart = await call("aras_get_history", { itemType: "Part", id: girante.id, limite: 10 });
  console.log(`  Part PMP-2110: ${hPart.eventi} eventi${hPart.nota ? " (tracciatura non attiva)" : ""}`);
  check("storico Part gestito", typeof hPart.eventi === "number");
  check("assenza di storico spiegata, non silenziosa",
    hPart.eventi > 0 || !!hPart.nota, JSON.stringify(hPart).slice(0, 200));

  console.log("\n=== 22. Effettivita' a una data ===");
  const ids = [pompa.id, girante.id, vite.id];
  const eff = await call("aras_check_effectivity", { partIds: ids, data: "2026-08-21" });
  for (const e of eff.esiti) console.log(`    ${String(e.item_number).padEnd(10)} valida=${e.valida} — ${e.motivo}`);
  check("effettivita' valutata su tutte", eff.verificate === 3, String(eff.verificate));
  check("le Part senza data risultano valide", eff.valide === 3, `${eff.valide}/3`);
  const effBad = await call("aras_check_effectivity", { partIds: [pompa.id], data: "non-una-data" });
  check("data non valida -> errore chiaro", !!effBad.errore, JSON.stringify(effBad).slice(0, 140));

  console.log(`\n${"=".repeat(50)}`);
  console.log(`${ok} controlli passati, ${ko} falliti`);
} finally {
  child.kill();
}
