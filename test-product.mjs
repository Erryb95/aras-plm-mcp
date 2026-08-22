/**
 * Collaudo dei tool di prodotto e gestione modifiche, in scrittura.
 * Opera solo su elementi con prefisso ZZP-, creati e rimossi qui dentro.
 */
import { spawn } from "node:child_process";
const c = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ARAS_READONLY: "false" },
});
c.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
let buf = "", id = 1; const p = new Map();
c.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } } });
const rpc = (me, pa) => new Promise((r, j) => { const i = id++; p.set(i, r); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: me, params: pa }) + "\n"); setTimeout(() => j(new Error("timeout " + me)), 180000) });
const call = async (n, a = {}) => { const r = await rpc("tools/call", { name: n, arguments: a }); const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error); try { return JSON.parse(t) } catch { return { _testo: t } } };
const callBlocchi = async (n, a = {}) => (await rpc("tools/call", { name: n, arguments: a })).result?.content ?? [];
let ok = 0, ko = 0;
const check = (n, cnd, d = "") => { if (cnd) { ok++; console.log(`  OK   ${n}`) } else { ko++; console.log(`  FAIL ${n}  ${String(d).slice(0, 200)}`) } };

const P = { assieme: "ZZP-1000", figlio: "ZZP-1100", figlio2: "ZZP-1200", copia: "ZZP-9000" };
const D = { drw: "ZZP-DRW-1", cad: "ZZP-CAD-1" };

/**
 * L'ordine conta: una Part referenziata come Affected Item da una ECR non si cancella.
 * Prima si eliminano le modifiche, poi i documenti, infine le Part.
 * (Il primo giro di questo test cancellava le Part per prime e ne restavano due:
 *  aras_plan_delete lo aveva segnalato, ma la pulizia passava ignoraAvvertenze.)
 */
async function pulisci() {
  const ecr = await call("aras_query_items", { itemType: "ECR", filter: "title eq 'ZZP prova modifica'", select: ["id"], top: 5 });
  for (const it of ecr.items ?? []) await call("aras_delete_item", { itemType: "ECR", id: it.id, modo: "delete", conferma: true, ignoraAvvertenze: true });

  // Anche fra le Part l'ordine conta: gli assiemi vanno prima dei loro componenti,
  // altrimenti restano righe di distinta che puntano a elementi da cancellare.
  const parti = [P.assieme, P.copia, P.figlio, P.figlio2];
  for (const [tipo, nums] of [["Document", [D.drw, "ZZP-DRW-BAD"]], ["CAD", [D.cad]], ["Part", parti]]) {
    for (const n of nums) {
      const q = await call("aras_query_items", { itemType: tipo, filter: `item_number eq '${n}'`, select: ["id"], top: 5 });
      for (const it of q.items ?? []) {
        await call("aras_delete_item", { itemType: tipo, id: it.id, modo: "delete", conferma: true, ignoraAvvertenze: true });
      }
    }
  }
}

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  console.log(`=== ${(await rpc("tools/list", {})).result.tools.length} TOOL ===\n`);
  await pulisci();

  console.log("=== 1. Valori di lista ===");
  const lv = await call("aras_get_list_values", { itemType: "Part" });
  console.log("  make_buy:", lv.liste?.make_buy?.join("|"), "| unit:", lv.liste?.unit?.join("|"));
  check("make_buy = Make|Buy", JSON.stringify(lv.liste?.make_buy) === '["Make","Buy"]', JSON.stringify(lv.liste?.make_buy));
  check("unit contiene EA", (lv.liste?.unit ?? []).includes("EA"));

  console.log("\n=== 2. Valore fuori lista rifiutato ===");
  const bad = await call("aras_create_part", { item_number: P.assieme, name: "x", make_buy: "make" });
  console.log("  ", JSON.stringify(bad.valoriFuoriLista));
  check("'make' minuscolo rifiutato", bad.creata === false && !!bad.valoriFuoriLista, JSON.stringify(bad));
  check("suggerisce i valori ammessi", bad.valoriFuoriLista?.[0]?.ammessi?.includes("Make"));

  console.log("\n=== 3. Creazione assieme e componenti ===");
  const a1 = await call("aras_create_part", { item_number: P.assieme, name: "Assieme di prova", make_buy: "Make", unit: "EA" });
  check("assieme creato", a1.creata === true, JSON.stringify(a1));
  const f1 = await call("aras_create_part", { item_number: P.figlio, name: "Componente 1", make_buy: "Buy", sottoAssieme: P.assieme, quantita: 4, riferimento: "R1,R2" });
  console.log("  ", JSON.stringify(f1.inDistinta));
  check("componente creato e agganciato", f1.creata === true && f1.inDistinta?.agganciata === true, JSON.stringify(f1));
  const f2 = await call("aras_create_part", { item_number: P.figlio2, name: "Componente 2", make_buy: "Buy" });
  check("secondo componente creato", f2.creata === true);

  console.log("\n=== 4. Righe di distinta ===");
  const add = await call("aras_manage_bom_line", { azione: "aggiungi", assieme: P.assieme, componente: P.figlio2, quantita: 2 });
  check("riga aggiunta", add.fatto === true, JSON.stringify(add));
  const dup = await call("aras_manage_bom_line", { azione: "aggiungi", assieme: P.assieme, componente: P.figlio2, quantita: 2 });
  check("duplicato rifiutato", dup.fatto === false && /gia'/.test(dup.motivo ?? ""), JSON.stringify(dup));
  const upd = await call("aras_manage_bom_line", { azione: "aggiorna", assieme: P.assieme, componente: P.figlio2, quantita: 7 });
  check("quantita' aggiornata", upd.fatto === true, JSON.stringify(upd));

  const bom = await call("aras_get_bom", { partId: a1.id, depth: 3 });
  const q = Object.fromEntries((bom.distintaPiatta ?? []).map((r) => [r.item_number, r.qtaCumulata]));
  console.log("  distinta:", JSON.stringify(q));
  check("distinta riflette le quantita'", q[P.figlio] === 4 && q[P.figlio2] === 7, JSON.stringify(q));

  console.log("\n=== 5. Documenti e CAD ===");
  const dd = await call("aras_create_document", { tipo: "Document", item_number: D.drw, name: "Disegno di prova", drawing_size: "A", perPart: P.assieme });
  check("Document creato e collegato", dd.creato === true && dd.collegato?.fatto === true, JSON.stringify(dd));
  const badSize = await call("aras_create_document", { tipo: "Document", item_number: "ZZP-DRW-BAD", drawing_size: "A0" });
  check("drawing_size fuori lista rifiutato", badSize.creato === false && !!badSize.valoriFuoriLista, JSON.stringify(badSize));
  const cd = await call("aras_create_document", { tipo: "CAD", item_number: D.cad, name: "Modello di prova", perPart: P.assieme });
  check("CAD creato e collegato", cd.creato === true && cd.collegato?.relazione === "Part CAD", JSON.stringify(cd));
  const docs = await call("aras_get_documents", { partId: a1.id });
  check("documenti rileggibili dalla Part", docs.documenti?.length === 1 && docs.modelliCad?.length === 1, JSON.stringify(docs).slice(0, 200));

  console.log("\n=== 6. Copia della Part con distinta ===");
  const cp = await call("aras_copy_part", { origine: P.assieme, nuovo: P.copia, nuovoNome: "Copia di prova", conDistinta: true });
  console.log("  righe copiate:", cp.righeDistintaCopiate);
  check("copia creata", cp.copiata === true, JSON.stringify(cp));
  check("distinta copiata (2 righe)", cp.righeDistintaCopiate === 2, String(cp.righeDistintaCopiate));

  console.log("\n=== 7. Permessi e AML ===");
  const perm = await call("aras_get_type_permissions", { itemType: "Manufacturer" });
  console.log("  Can Add su Manufacturer:", perm.identitaConPermessoAdd?.join(", "));
  console.log("  puoi aggiungere:", perm.puoiAggiungere);
  check("identita' con Can Add individuata", (perm.identitaConPermessoAdd ?? []).includes("Component Engineering"), JSON.stringify(perm).slice(0, 200));

  const mp = await call("aras_add_manufacturer_part", { mpn: "ZZP-MPN-1", descrizione: "Componente commerciale", costruttore: "ZZP Fornitore", perPart: P.figlio });
  if (perm.puoiAggiungere) {
    check("MPN creato e approvato", mp.fatto === true, JSON.stringify(mp));
    const amlv = await call("aras_get_aml", { partId: f1.id });
    check("AML rileggibile con costruttore", amlv.aml?.[0]?.costruttore === "ZZP Fornitore", JSON.stringify(amlv).slice(0, 200));
  } else {
    // Senza il ruolo l'operazione DEVE fallire, ma con un messaggio che dice cosa fare.
    console.log("  ", String(mp._testo ?? JSON.stringify(mp)).slice(0, 180));
    check("errore di permesso spiegato e azionabile",
      /aras_get_type_permissions|non appartiene a/.test(String(mp._testo ?? "")), String(mp._testo).slice(0, 200));
  }

  console.log("\n=== 8. Prontezza al rilascio ===");
  const rr = await call("aras_check_release_readiness", { partId: a1.id });
  console.log(`  ${rr.componenti} componenti, ${rr.nonRilasciati?.length} non rilasciati`);
  check("rileva i componenti non rilasciati", rr.pronto === false && rr.nonRilasciati?.length === 2, JSON.stringify(rr).slice(0, 250));

  console.log("\n=== 9. ECR con elementi impattati ===");
  const ecr = await call("aras_create_change", {
    tipo: "ECR", title: "ZZP prova modifica", description: "Verifica creazione con Affected Item",
    impattati: [{ itemType: "Part", itemNumber: P.figlio }],
  });
  console.log("  numero assegnato da Aras:", ecr.numero, "| impattati:", JSON.stringify(ecr.elementiImpattati));
  check("ECR creata", ecr.creata === true, JSON.stringify(ecr));
  check("numero generato da Aras", /^ECR-\d+$/.test(String(ecr.numero)), String(ecr.numero));
  check("Affected Item agganciato", ecr.elementiImpattati?.includes(P.figlio), JSON.stringify(ecr));
  const imp = await call("aras_get_change_impact", { changeType: "ECR", changeId: ecr.id });
  check("impatto rileggibile", imp.impatti?.some((i) => i.elemento === P.figlio), JSON.stringify(imp).slice(0, 200));

  const add2 = await call("aras_add_affected_item", { tipo: "ECR", changeId: ecr.id, itemType: "Part", itemNumber: P.figlio2 });
  check("secondo impattato aggiunto", add2.aggiunto === true, JSON.stringify(add2));
  const dup2 = await call("aras_add_affected_item", { tipo: "ECR", changeId: ecr.id, itemType: "Part", itemNumber: P.figlio2 });
  check("impattato duplicato rifiutato", dup2.aggiunto === false, JSON.stringify(dup2));

  console.log("\n=== 10. Avanzamento della modifica (dryRun) ===");
  const adv = await call("aras_advance_change", { changeId: ecr.id, via: "Approve", dryRun: true });
  console.log("  ", JSON.stringify(adv.piano ?? adv.motivo));
  check("individua l'attivita' Active", adv.avanzata === false && (!!adv.piano?.attivita || !!adv.motivo), JSON.stringify(adv).slice(0, 250));

  console.log("\n=== 11. Pulizia ===");
  await pulisci();
  const resta = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'ZZP-')", select: ["id"], top: 20 });
  check("elementi di prova rimossi", (resta.totaleCorrispondenti ?? 0) === 0, `rimasti ${resta.totaleCorrispondenti}`);
  const acme = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'PMP-')", select: ["id"], top: 50 });
  check("dati ACME intatti", (acme.totaleCorrispondenti ?? 0) === 8, String(acme.totaleCorrispondenti));

  // Il contenuto dei file si legge davvero, non e' piu' solo un URL. Su
  // un'istanza col vault vuoto il blocco lo dichiara invece di fallire: da qui
  // il caricamento non e' possibile, quindi non puo' prepararsi il dato.
  console.log("\n=== 10. Lettura del contenuto di un file ===");
  {
    const fl = await call("aras_query_items", { itemType: "File", select: ["id", "filename", "mimetype"], top: 5 });
    const primo = (fl.items ?? [])[0];
    if (!primo) {
      console.log("  vault vuoto su questa istanza: blocco non applicabile");
      check("lettura file: nessun file da leggere, dichiarato", true);
    } else {
      const blocchi = await callBlocchi("aras_read_file", { fileId: primo.id, maxCaratteri: 5000 });
      let testa = {};
      try { testa = JSON.parse(blocchi[0]?.text ?? "{}"); } catch {}
      const testo = blocchi.filter((b) => b.type === "text").slice(1).map((b) => b.text).join("\n");
      const immagine = blocchi.some((b) => b.type === "image");
      console.log(`  ${primo.filename} (${primo.mimetype}) -> genere ${testa.genere}, via ${testa.via}, ${testa.bytes} byte`);
      if (testo) console.log(`  prima riga estratta: ${testo.split("\n")[0].slice(0, 70)}`);
      check("il file viene scaricato", (testa.bytes ?? 0) > 0, JSON.stringify(testa).slice(0, 200));
      check("il genere e' riconosciuto", ["testo", "pdf", "immagine", "binario"].includes(testa.genere), String(testa.genere));
      check("contenuto estratto, oppure limite dichiarato",
        !!testo || immagine || !!testa.nota,
        JSON.stringify({ genere: testa.genere, nota: testa.nota }).slice(0, 200));
    }
  }

  console.log(`\n${"=".repeat(50)}\n${ok} passati, ${ko} falliti`);
} catch (e) { console.log("ERRORE:", e.message); process.exitCode = 1 }
finally { c.kill() }
