/**
 * Suite per flussi aziendali interi, non per singoli tool.
 *
 * Ogni blocco parte da una domanda come la porrebbe qualcuno in azienda e la
 * porta a termine: piu' chiamate in sequenza, con una verifica per ogni passo.
 * Se un flusso si rompe a meta', si vede esattamente dove.
 *
 * Scrive solo su elementi con prefisso ZZF- e li rimuove alla fine.
 * I dati ACME (PMP-, HW-, DRW-, CAD-, ECR-100001) e la famiglia AD-30xx
 * non vengono mai toccati: l'ultimo flusso lo verifica.
 *
 *   node test-flussi.mjs
 */
import { spawn } from "node:child_process";

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
  setTimeout(() => j(new Error("timeout " + me)), 180000);
});
const call = async (n, a = {}) => {
  const r = await rpc("tools/call", { name: n, arguments: a });
  const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
  try { return JSON.parse(t); } catch { return { _testo: t }; }
};

let ok = 0, ko = 0;
const rotti = [];
function passo(nome, cond, dettaglio) {
  if (cond) { ok++; console.log("    OK   " + nome); }
  else {
    ko++; rotti.push(nome);
    let d; try { d = JSON.stringify(dettaglio); } catch { d = String(dettaglio); }
    console.log("    FAIL " + nome + "\n         " + String(d ?? "").slice(0, 400));
  }
}
function flusso(n, domanda) {
  console.log("\n" + "-".repeat(74));
  console.log("F" + n + "  " + domanda);
  console.log("-".repeat(74));
}

const idPart = async (num) => (await call("aras_query_items", {
  itemType: "Part", filter: "item_number eq '" + num + "'", select: ["id"], top: 1,
})).items?.[0]?.id;

async function approvaERilascia(id) {
  await call("aras_advance_change", { changeId: id, via: "Approva", dryRun: false, commenti: "collaudo flussi" });
  return await call("aras_promote_item", { itemType: "Part", id, toState: "Released" });
}

// L'utenza e il reparto vanno rimossi fra un'esecuzione e l'altra, altrimenti
// creaUtente li trova gia' presenti e salta l'iscrizione ai gruppi.
async function azzeraOrganizzazione() {
  const u = await call("aras_query_items", { itemType: "User", filter: "login_name eq 'zzflavio'", select: ["id"], top: 2 });
  for (const it of u.items ?? []) await call("aras_delete_item", { itemType: "User", id: it.id, modo: "delete", conferma: true, ignoraAvvertenze: true });
  const g = await call("aras_query_items", { itemType: "Identity", filter: "name eq 'ZZF Reparto Prova'", select: ["id"], top: 2 });
  for (const it of g.items ?? []) await call("aras_delete_item", { itemType: "Identity", id: it.id, modo: "delete", conferma: true, ignoraAvvertenze: true });
}

// Un giro interrotto lascia ZZF-DRW, ZZF-CAD o ZZF-MPN-77: al giro dopo il
// documento "esiste gia'" e il flusso F4 verifica una relazione mai creata.
async function azzeraDocumenti() {
  for (const [t, n] of [["Document", "ZZF-DRW"], ["CAD", "ZZF-CAD"], ["Manufacturer Part", "ZZF-MPN-77"]]) {
    const q = await call("aras_query_items", { itemType: t, filter: "item_number eq '" + n + "'", select: ["id"], top: 5 });
    for (const it of q.items ?? []) {
      await call("aras_delete_item", { itemType: t, id: it.id, modo: "delete", conferma: true, ignoraAvvertenze: true });
    }
  }
}

async function rimuoviPart(num) {
  const id = await idPart(num);
  if (!id) return true;
  const r = await call("aras_delete_item", { itemType: "Part", id, modo: "delete", conferma: true, ignoraAvvertenze: true });
  return r.cancellato === true;
}

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "flussi", version: "1" } });
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.log("=".repeat(74));
  console.log("COLLAUDO DEI FLUSSI AZIENDALI");
  console.log("=".repeat(74));

  // ---------------------------------------------------------------- pulizia iniziale
  const daRimuovere = ["ZZF-2000", "ZZF-1000", "ZZF-2001", "ZZF-2002", "ZZF-2003", "ZZF-3002"];
  for (const n of daRimuovere) await rimuoviPart(n);
  await azzeraDocumenti();
  await azzeraOrganizzazione();

  // ================================================================= F1
  flusso(1, '"E\' entrato un progettista: creagli l\'utenza e mettilo nel reparto giusto."');
  {
    const g = await call("aras_create_group", { nome: "ZZF Reparto Prova", descrizione: "Reparto usa e getta" });
    passo("il reparto esiste", g.creato === true || /gia'/.test(g.motivo ?? ""), g);

    const u = await call("aras_create_user", {
      login: "zzflavio", nome: "Flavio", cognome: "Zeta",
      email: "zzflavio@arasdemo.local", azienda: "ARAS DEMO",
      gruppi: ["ZZF Reparto Prova", "ACME Engineering"],
    });
    passo("l'utenza e' creata", u.creato === true || /gia'/.test(u.motivo ?? ""), u);

    const gid = (await call("aras_query_items", { itemType: "Identity", filter: "name eq 'ZZF Reparto Prova'", select: ["id"], top: 1 })).items?.[0]?.id;
    const m1 = await call("aras_get_identity_members", { identityId: gid });
    passo("il reparto lo conta fra i suoi membri", (m1.membri ?? 0) >= 1, m1);

    const r = await call("aras_manage_membership", { gruppo: "ZZF Reparto Prova", membro: "Flavio Zeta", azione: "rimuovi" });
    const m2 = await call("aras_get_identity_members", { identityId: gid });
    passo("la revoca lo toglie davvero", r.eseguito !== false && (m2.membri ?? 1) === 0, { r, m2 });
  }

  // ================================================================= F2
  flusso(2, '"Codifica un nuovo componente, portalo in approvazione e rilascialo."');
  let idComponente;
  {
    const p = await call("aras_create_part", { item_number: "ZZF-1000", name: "Componente di collaudo", make_buy: "Make", unit: "EA", cost: 12.5 });
    passo("il componente e' a catalogo", p.creata === true || !!p.id, p);
    idComponente = await idPart("ZZF-1000");

    const w = await call("aras_get_workflow", { itemId: idComponente });
    const att = w.processi?.[0]?.dettaglioAttivita?.find((a) => a.stato === "Active");
    passo("Aras ha avviato da se' l'approvazione", att?.nome === "Approvazione Tecnica", w.processi?.[0]);
    passo("l'attivita' espone le vie percorribili", (att?.vie ?? []).map((v) => v.nome).join("/") === "Approva/Respingi", att?.vie);
    passo("ed e' in carico a un reparto", (att?.assegnazioni ?? []).some((a) => a.identita === "ACME Engineering"), att?.assegnazioni);

    const s0 = await call("aras_get_lifecycle_state", { itemType: "Part", id: idComponente });
    passo("nasce in Preliminary", s0.statoAttuale === "Preliminary", s0);

    const a = await call("aras_advance_change", { changeId: idComponente, via: "Approva", dryRun: false, commenti: "approvato in collaudo" });
    passo("l'approvazione fa avanzare il processo", a.avanzata === true, a);

    const pr = await call("aras_promote_item", { itemType: "Part", id: idComponente, toState: "Released" });
    passo("la promozione a Released riesce", pr.promosso === true, pr);

    const w2 = await call("aras_get_workflow", { itemId: idComponente });
    passo("il processo risulta chiuso", w2.processi?.[0]?.stato === "Closed", w2.processi?.[0]?.stato);

    const h = await call("aras_get_history", { itemType: "Part", id: idComponente });
    passo("lo storico ha registrato gli eventi", (h.eventi ?? 0) >= 1, h);
  }

  // ================================================================= F3
  flusso(3, '"Costruisci un assieme con tre componenti e dimmi quanti pezzi servono."');
  {
    await call("aras_create_part", { item_number: "ZZF-2000", name: "Assieme di collaudo", make_buy: "Make" });
    await call("aras_create_part", { item_number: "ZZF-2001", name: "Componente A", make_buy: "Buy", sottoAssieme: "ZZF-2000", quantita: 2 });
    await call("aras_create_part", { item_number: "ZZF-2002", name: "Componente B", make_buy: "Buy", sottoAssieme: "ZZF-2000", quantita: 4 });
    await call("aras_create_part", { item_number: "ZZF-2003", name: "Componente C", make_buy: "Buy", sottoAssieme: "ZZF-2000", quantita: 1 });

    const idAssieme = await idPart("ZZF-2000");
    const b = await call("aras_get_bom", { partId: idAssieme, depth: 3 });
    const piatta = b.distintaPiatta ?? [];
    passo("la distinta ha tre righe", piatta.length === 3, piatta.map((x) => x.item_number));
    passo("le quantita' sono quelle richieste",
      piatta.find((x) => x.item_number === "ZZF-2002")?.qtaCumulata === 4, piatta);

    const idB = await idPart("ZZF-2002");
    const wu = await call("aras_where_used", { partId: idB, depth: 3 });
    passo("il componente sa dove e' montato", (wu.assiemi ?? []).some((a) => a.item_number === "ZZF-2000"), wu.assiemi);

    const mb = await call("aras_manage_bom_line", { azione: "aggiorna", assieme: "ZZF-2000", componente: "ZZF-2002", quantita: 6 });
    const b2 = await call("aras_get_bom", { partId: idAssieme, depth: 2 });
    passo("cambiare la quantita' si riflette in distinta",
      (b2.distintaPiatta ?? []).find((x) => x.item_number === "ZZF-2002")?.qtaCumulata === 6, { mb, b2: b2.distintaPiatta });

    const rr = await call("aras_check_release_readiness", { partId: idAssieme });
    passo("il controllo di rilasciabilita' elenca i pezzi non pronti", (rr.componenti ?? 0) >= 3, rr);
  }

  // ================================================================= F4
  flusso(4, '"Allega disegno e modello CAD al componente, e verifica che li trovi chi cerca."');
  {
    const d = await call("aras_create_document", { tipo: "Document", item_number: "ZZF-DRW", name: "Disegno di collaudo", drawing_size: "A", perPart: "ZZF-1000" });
    passo("il disegno e' creato e collegato", d.collegato?.fatto === true, d);
    const cad = await call("aras_create_document", { tipo: "CAD", item_number: "ZZF-CAD", name: "Modello di collaudo", authoring_tool: "SolidWorks", perPart: "ZZF-1000" });
    passo("il modello CAD e' creato e collegato", cad.collegato?.fatto === true, cad);

    // L'id va ririsolto: fra F2 e qui la Part e' stata promossa, e su un
    // ItemType versionabile la generazione corrente puo' non essere piu'
    // quella catturata alla creazione. Chi cerca parte dal codice, non da un id.
    // Non basta che il documento esista: quello che conta e' il collegamento.
    // Accettare un id come prova di successo nascondeva il caso "esisteva gia',
    // quindi non l'ho collegato" — ed e' esattamente cosi' che il guasto
    // intermittente e' rimasto invisibile.
    const g = await call("aras_get_documents", { partId: await idPart("ZZF-1000") });
    passo("una sola domanda restituisce entrambi",
      (g.documenti ?? []).length >= 1 && (g.modelliCad ?? []).length >= 1,
      { doc: g.documenti, cad: g.modelliCad });
  }

  // ================================================================= F5
  flusso(5, '"Omologa un costruttore per questo componente e dimmi il suo codice."');
  {
    const m = await call("aras_add_manufacturer_part", {
      mpn: "ZZF-MPN-77", descrizione: "Codice del costruttore per collaudo",
      costruttore: "Bossard Italia", perPart: "ZZF-1000",
    });
    passo("il codice costruttore e' registrato", m.fatto === true, m);

    const a = await call("aras_get_aml", { partId: await idPart("ZZF-1000") });
    passo("l'elenco fornitori lo mostra", (a.aml ?? []).some((x) => x.manufacturerPart === "ZZF-MPN-77"), a.aml);
  }

  // ================================================================= F6
  flusso(6, '"Apri una richiesta di modifica sul componente, falla avanzare e dimmi cosa impatta."');
  {
    const e = await call("aras_create_change", {
      tipo: "ECR", title: "ZZF modifica di collaudo",
      description: "Verifica del ciclo di modifica end to end.",
      impattati: [{ itemType: "Part", itemNumber: "ZZF-1000" }],
    });
    passo("la ECR e' aperta", e.creata === true || !!e.id, e);
    const idEcr = e.id ?? e.item?.id;

    const im = await call("aras_get_change_impact", { changeType: "ECR", changeId: idEcr });
    passo("dice quale componente tocca", (im.impatti ?? []).some((x) => x.elemento === "ZZF-1000"), im.impatti);

    const w = await call("aras_get_workflow", { itemId: idEcr });
    const att = w.processi?.[0]?.dettaglioAttivita?.find((a) => a.stato === "Active");
    passo("il suo workflow e' partito", !!att, w.processi?.[0]);
    passo("e dice chi la sta bloccando", (att?.assegnazioni ?? []).length >= 1, att?.assegnazioni);

    const dry = await call("aras_advance_change", { changeId: idEcr, via: "Submit", dryRun: true });
    passo("il dryRun mostra cosa farebbe senza farlo", dry.avanzata === false && !!dry.piano, dry);

    const av = await call("aras_advance_change", { changeId: idEcr, via: dry.piano?.viaScelta ?? "Submit", dryRun: false });
    passo("l'avanzamento reale riesce", av.avanzata === true, av);

    await call("aras_delete_item", { itemType: "ECR", id: idEcr, modo: "delete", conferma: true, ignoraAvvertenze: true });
  }

  // ================================================================= F7
  flusso(7, '"Sostituisci un componente in tutte le distinte, ma prima dimmi dove finirebbe."');
  {
    await call("aras_create_part", { item_number: "ZZF-3002", name: "Componente sostitutivo", make_buy: "Buy" });

    const dry = await call("aras_replace_component", { vecchio: "ZZF-2002", nuovo: "ZZF-3002", dryRun: true });
    passo("il dryRun trova la riga e non tocca nulla", dry.righeInteressate === 1 && dry.sostituito === false, dry);

    const vero = await call("aras_replace_component", { vecchio: "ZZF-2002", nuovo: "ZZF-3002", dryRun: false });
    passo("la sostituzione reale avviene", vero.sostituito === true || (vero.righeSostituite ?? 0) === 1, vero);

    const idAssieme = await idPart("ZZF-2000");
    const b = await call("aras_get_bom", { partId: idAssieme, depth: 2 });
    const nums = (b.distintaPiatta ?? []).map((x) => x.item_number);
    passo("la distinta ora monta il nuovo codice", nums.includes("ZZF-3002") && !nums.includes("ZZF-2002"), nums);
  }

  // ================================================================= F8
  flusso(8, '"Il componente rilasciato va rivisto: creane la revisione successiva."');
  {
    const r = await call("aras_new_revision", { itemType: "Part", id: idComponente });
    passo("la nuova generazione e' creata", r.creata === true || (r.generazione ?? 0) >= 2, r);

    const rev = await call("aras_get_revisions", { itemType: "Part", id: idComponente });
    passo("lo storico revisioni ne conta due", (rev.generazioni ?? 0) >= 2, rev);
  }

  // ================================================================= F9
  flusso(9, '"Prova a cancellare un componente montato in una distinta: deve rifiutare."');
  {
    const id3002 = await idPart("ZZF-3002");
    const pd = await call("aras_plan_delete", { itemType: "Part", id: id3002, modo: "delete" });
    passo("il piano di cancellazione rifiuta", pd.eseguibile === false, pd);
    passo("e dice per quale relazione", (pd.avvertenze ?? []).length >= 1, pd.avvertenze);

    const tp = await call("aras_get_type_permissions", { itemType: "Manufacturer" });
    passo("i permessi di un tipo sono leggibili", (tp.identitaConPermessoAdd ?? []).length >= 1, tp);

    const le = await call("aras_lookup_error", { testo: "not from allowed identity" });
    passo("un errore Aras si puo' decifrare", (le.messaggi ?? []).length >= 1, le);
  }

  // ================================================================= F10
  flusso(10, '"Ripulisci tutto e dimostrami che i dati di produzione non sono stati toccati."');
  {
    for (const n of ["ZZF-DRW", "ZZF-CAD"]) {
      for (const t of ["Document", "CAD"]) {
        const q = await call("aras_query_items", { itemType: t, filter: "item_number eq '" + n + "'", select: ["id"], top: 2 });
        for (const it of q.items ?? []) await call("aras_delete_item", { itemType: t, id: it.id, modo: "delete", conferma: true, ignoraAvvertenze: true });
      }
    }
    const mp = await call("aras_query_items", { itemType: "Manufacturer Part", filter: "item_number eq 'ZZF-MPN-77'", select: ["id"], top: 2 });
    for (const it of mp.items ?? []) await call("aras_delete_item", { itemType: "Manufacturer Part", id: it.id, modo: "delete", conferma: true, ignoraAvvertenze: true });

    let rimosse = 0;
    for (const n of ["ZZF-2000", "ZZF-2001", "ZZF-2002", "ZZF-2003", "ZZF-3002", "ZZF-1000"]) {
      if (await rimuoviPart(n)) rimosse++;
    }
    passo("gli elementi di collaudo sono stati rimossi", rimosse === 6, rimosse + "/6");

    await azzeraOrganizzazione();

    const resti = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'ZZF-')", select: ["item_number"], top: 20 });
    passo("non resta nulla col prefisso ZZF-", (resti.totaleCorrispondenti ?? 0) === 0, resti.items);

    const acme = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'PMP-')", select: ["item_number"], top: 30 });
    passo("le otto Part PMP- di ACME sono intatte", acme.totaleCorrispondenti === 8, acme.totaleCorrispondenti);

    const ad = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'AD-30')", select: ["item_number", "state"], top: 30 });
    const rilasciate = (ad.items ?? []).filter((x) => x.state === "Released").length;
    passo("le quindici Part AD-30xx sono ancora tutte Released", ad.totaleCorrispondenti === 15 && rilasciate === 15, rilasciate + "/" + ad.totaleCorrispondenti);

    const ecr = await call("aras_query_items", { itemType: "ECR", filter: "item_number eq 'ECR-100001'", select: ["id"], top: 1 });
    passo("la ECR storica di ACME e' ancora al suo posto", (ecr.totaleCorrispondenti ?? 0) === 1, ecr);
  }

  console.log("\n" + "=".repeat(74));
  console.log(ok + " verifiche passate, " + ko + " fallite");
  if (ko) console.log("da correggere: " + rotti.join(" | "));
  else console.log("Tutti i flussi aziendali si chiudono correttamente.");
  console.log("=".repeat(74));
} finally { c.kill(); }
