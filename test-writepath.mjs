/**
 * Collauda il percorso di SCRITTURA dei tool che finora erano stati verificati solo
 * per il rifiuto in sola lettura. Opera esclusivamente su elementi ZZW-, creati e
 * rimossi qui dentro. I dati ACME non vengono mai toccati.
 */
import { spawn } from "node:child_process";
const c = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ARAS_READONLY: "false" } });
c.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
let buf = "", id = 1; const p = new Map();
c.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } } });
const rpc = (me, pa) => new Promise((r, j) => { const i = id++; p.set(i, r); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: me, params: pa }) + "\n"); setTimeout(() => j(new Error("timeout " + me)), 180000) });
const call = async (n, a = {}) => { const r = await rpc("tools/call", { name: n, arguments: a }); const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error); try { return JSON.parse(t) } catch { return { _testo: t } } };
let ok = 0, ko = 0;
const check = (n, cnd, d = "") => { if (cnd) { ok++; console.log(`  OK   ${n}`) } else { ko++; console.log(`  FAIL ${n}  ${String(d).slice(0, 240)}`) } };
const q1 = async (t, f, s = ["id"]) => (await call("aras_query_items", { itemType: t, filter: f, select: s, top: 1 })).items?.[0];

const PARTI = ["ZZW-1000", "ZZW-1100", "ZZW-1200"];

async function pulisci(silenzioso = true) {
  const ecr = await call("aras_query_items", { itemType: "ECR", filter: "title eq 'ZZW modifica di prova'", select: ["id"], top: 5 });
  for (const it of ecr.items ?? []) await call("aras_delete_item", { itemType: "ECR", id: it.id, modo: "delete", conferma: true, ignoraAvvertenze: true });
  for (const n of PARTI) {
    const r = await call("aras_query_items", { itemType: "Part", filter: `item_number eq '${n}'`, select: ["id"], top: 5 });
    for (const it of r.items ?? []) await call("aras_delete_item", { itemType: "Part", id: it.id, modo: "delete", conferma: true, ignoraAvvertenze: true });
  }
  for (const [tipo, filtro] of [["Identity", "name eq 'ZZW Reparto'"], ["Identity", "name eq 'Zz Prova'"], ["User", "login_name eq 'zzwprova'"], ["effs_model", "name eq 'ZZW-MOD'"]]) {
    const r = await call("aras_query_items", { itemType: tipo, filter: filtro, select: ["id"], top: 5 });
    for (const it of r.items ?? []) await call("aras_aml_request", { itemXml: `<Item type="${tipo}" id="${it.id}" action="delete"/>` });
  }
  if (!silenzioso) console.log("  pulito");
}

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  console.log(`=== ${(await rpc("tools/list", {})).result.tools.length} TOOL — percorso di scrittura ===\n`);
  await pulisci();

  console.log("=== 1. Organizzazione: gruppo, utente, appartenenza ===");
  const g = await call("aras_create_group", { nome: "ZZW Reparto", descrizione: "reparto di prova" });
  check("gruppo creato", g.creato === true, JSON.stringify(g).slice(0, 200));
  const u = await call("aras_create_user", { login: "zzwprova", nome: "Zz", cognome: "Prova", email: "zz@prova.it", gruppi: ["ZZW Reparto"] });
  console.log(`  utente ${u.login}, identita' alias: ${u.identitaAlias?.nome}, gruppi: ${JSON.stringify(u.gruppiAggiunti)}`);
  check("utente creato con identita' alias", u.creato === true && !!u.identitaAlias, JSON.stringify(u).slice(0, 220));
  check("iscritto al gruppo in un passo", (u.gruppiAggiunti ?? []).includes("ZZW Reparto"), JSON.stringify(u.gruppiAggiunti));
  const gid = (await q1("Identity", "name eq 'ZZW Reparto'")).id;
  const membri = await call("aras_get_identity_members", { identityId: gid });
  check("il membro e' visibile nel gruppo", (membri.elenco ?? []).some((m) => m.nome === "Zz Prova"), JSON.stringify(membri).slice(0, 200));
  const rem = await call("aras_manage_membership", { gruppo: "ZZW Reparto", membro: "Zz Prova", azione: "rimuovi" });
  check("appartenenza revocata", rem.fatto === true, JSON.stringify(rem).slice(0, 180));
  const membri2 = await call("aras_get_identity_members", { identityId: gid });
  check("il gruppo ora e' vuoto", (membri2.elenco ?? []).length === 0, JSON.stringify(membri2.elenco));

  console.log("\n=== 2. Permessi in scrittura ===");
  const gr = await call("aras_grant_permission", { nomePermesso: "New Part", identita: "ZZW Reparto", leggere: true, modificare: true });
  console.log("  ", JSON.stringify(gr));
  check("permesso concesso", gr.fatto === true, JSON.stringify(gr).slice(0, 200));
  const det = await call("aras_get_permission_detail", { nomePermesso: "New Part" });
  const conc = (det.concessioni ?? []).find((x) => x.identita === "ZZW Reparto");
  check("la concessione e' rileggibile", !!conc && conc.leggere === true && conc.modificare === true, JSON.stringify(conc));
  check("can_discover concesso con la lettura", conc?.scoprire === true, JSON.stringify(conc));
  const gr2 = await call("aras_grant_permission", { nomePermesso: "New Part", identita: "ZZW Reparto", leggere: true, modificare: false, cancellare: false });
  check("concessione aggiornata, non duplicata", gr2.azione === "aggiornata", JSON.stringify(gr2).slice(0, 180));
  // Azzerare tutti i diritti deve RIMUOVERE la riga, non lasciarla inerte.
  const gr3 = await call("aras_grant_permission", { nomePermesso: "New Part", identita: "ZZW Reparto", leggere: false, modificare: false, cancellare: false, scoprire: false });
  check("revoca completa rimuove la riga", gr3.azione === "revocata", JSON.stringify(gr3).slice(0, 180));
  const det0 = await call("aras_get_permission_detail", { nomePermesso: "New Part" });
  check("nessuna riga Access residua", !(det0.concessioni ?? []).some((x) => x.identita === "ZZW Reparto"));

  console.log("\n=== 3. Sostituzione componente, per davvero ===");
  await call("aras_create_part", { item_number: PARTI[0], name: "Assieme ZZW", make_buy: "Make" });
  await call("aras_create_part", { item_number: PARTI[1], name: "Vecchio", make_buy: "Buy", sottoAssieme: PARTI[0], quantita: 3 });
  await call("aras_create_part", { item_number: PARTI[2], name: "Nuovo", make_buy: "Buy" });
  const rep = await call("aras_replace_component", { vecchio: PARTI[1], nuovo: PARTI[2], dryRun: false });
  console.log("  ", JSON.stringify(rep));
  check("sostituzione eseguita", rep.sostituito === true && (rep.assiemiAggiornati ?? []).length === 1, JSON.stringify(rep).slice(0, 220));
  const ass = await q1("Part", `item_number eq '${PARTI[0]}'`);
  const bom = await call("aras_get_bom", { partId: ass.id, depth: 2 });
  const figli = (bom.distintaPiatta ?? []).map((x) => x.item_number);
  console.log("  distinta ora:", JSON.stringify(figli));
  check("il nuovo componente e' in distinta", figli.includes(PARTI[2]), JSON.stringify(figli));
  check("il vecchio non c'e' piu'", !figli.includes(PARTI[1]), JSON.stringify(figli));
  check("la quantita' e' conservata", (bom.distintaPiatta ?? [])[0]?.qtaCumulata === 3, JSON.stringify(bom.distintaPiatta));

  console.log("\n=== 4. Aggiornamento massivo, per davvero ===");
  const bu = await call("aras_bulk_update", { itemType: "Part", filtro: "startswith(item_number,'ZZW-')", valori: { description: "toccato in blocco" }, dryRun: false });
  console.log("  ", JSON.stringify(bu).slice(0, 200));
  check("aggiornamento eseguito", (bu.aggiornati ?? 0) >= 2, JSON.stringify(bu).slice(0, 220));
  const ver = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'ZZW-')", select: ["item_number", "description"], top: 10 });
  const toccate = (ver.items ?? []).filter((x) => x.description === "toccato in blocco");
  check("le descrizioni sono cambiate", toccate.length >= 2, `${toccate.length}`);
  const acme = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'PMP-')", select: ["item_number", "description"], top: 20 });
  check("nessuna Part ACME toccata", !(acme.items ?? []).some((x) => x.description === "toccato in blocco"));

  console.log("\n=== 5. Import AML, per davvero ===");
  const imp = await call("aras_import_aml", { contenuto: `<Item type="Part" action="add"><item_number>ZZW-1300</item_number><name>Da import</name></Item>`, dryRun: false });
  check("import eseguito", imp.importato === true, JSON.stringify(imp).slice(0, 200));
  const impPart = await q1("Part", "item_number eq 'ZZW-1300'", ["id", "name"]);
  check("l'elemento importato esiste", impPart?.name === "Da import", JSON.stringify(impPart));
  if (impPart) await call("aras_delete_item", { itemType: "Part", id: impPart.id, modo: "delete", conferma: true, ignoraAvvertenze: true });

  console.log("\n=== 6. Modifica: creazione, impattati, avanzamento ===");
  const ecr = await call("aras_create_change", { tipo: "ECR", title: "ZZW modifica di prova", description: "prova percorso di scrittura", impattati: [{ itemType: "Part", itemNumber: PARTI[0] }] });
  console.log(`  ${ecr.numero} · impattati: ${JSON.stringify(ecr.elementiImpattati)}`);
  check("ECR creata con numero da Aras", ecr.creata === true && /^ECR-\d+$/.test(String(ecr.numero)), JSON.stringify(ecr).slice(0, 220));
  const wf = await call("aras_get_workflow", { itemId: ecr.id });
  const att = (wf.processi?.[0]?.dettaglioAttivita ?? []).find((a) => a.stato === "Active" && a.assegnazioni.length);
  console.log(`  attivita' attiva: ${att?.nome}`);
  check("il workflow e' partito", !!att, JSON.stringify(wf.processi?.[0]?.attivitaAperte));

  console.log(`  vie disponibili: ${JSON.stringify(att.vie?.map((v) => v.nome))}`);
  check("le vie di uscita sono esposte", (att.vie ?? []).length > 0, JSON.stringify(att.vie));

  const adv = await call("aras_advance_change", { changeId: ecr.id, via: att.vie[0].nome, commenti: "avanzamento di prova", dryRun: false });
  console.log("  avanzamento:", JSON.stringify(adv).slice(0, 200));
  check("avanzamento ESEGUITO", adv.avanzata === true, JSON.stringify(adv).slice(0, 260));
  const wf2 = await call("aras_get_workflow", { itemId: ecr.id });
  const chiusa = (wf2.processi?.[0]?.dettaglioAttivita ?? []).find((a) => a.id === att.id);
  console.log(`  attivita' "${att.nome}" ora: ${chiusa?.stato}`);
  check("l'attivita' e' stata chiusa", chiusa?.stato === "Closed", JSON.stringify(chiusa?.stato));

  const attNuova = (wf2.processi?.[0]?.dettaglioAttivita ?? []).find((a) => a.stato === "Active" && a.assegnazioni.length);
  if (attNuova) {
    const del = await call("aras_delegate_activity", { activityId: attNuova.id, assignmentId: attNuova.assegnazioni[0].id, aIdentita: "ZZW Reparto", commenti: "delega di prova", dryRun: false });
    console.log(`  delega di "${attNuova.nome}":`, JSON.stringify(del).slice(0, 220));
    // L'attivita' successiva e' assegnata a un'altra identita': Aras rifiuta la delega
    // da chi non ne fa parte. E' comportamento corretto — si verifica che il tool lo
    // SPIEGHI, dicendo a chi e' assegnata e come rimediare.
    check("delega eseguita, oppure rifiutata con spiegazione utile",
      del.delegata === true || (del.delegata === false && !!del.assegnataA && !!del.rimedio),
      JSON.stringify(del).slice(0, 280));
  } else {
    console.log("  (nessuna attivita' attiva dopo l'avanzamento: delega non applicabile qui)");
    check("delega saltata con motivo", true);
  }

  console.log("\n=== 7. Modello di effettivita' ===");
  const mod = await call("aras_create_effectivity_model", { nome: "ZZW-MOD", etichetta: "Modello ZZW" });
  check("modello creato", mod.creato === true, JSON.stringify(mod).slice(0, 180));
  const cfg = await call("aras_get_effectivity_config");
  check("il modello compare in configurazione", (cfg.modelli ?? []).some((m) => m.nome === "ZZW-MOD"));

  console.log("\n=== 8. Pulizia e integrita' ===");
  await pulisci(false);
  const resta = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'ZZW-')", select: ["id"], top: 10 });
  check("elementi di prova rimossi", (resta.totaleCorrispondenti ?? 0) === 0, `rimasti ${resta.totaleCorrispondenti}`);
  const det2 = await call("aras_get_permission_detail", { nomePermesso: "New Part" });
  const residuo = (det2.concessioni ?? []).find((x) => x.identita === "ZZW Reparto");
  check("nessuna concessione residua", !residuo, JSON.stringify(residuo));
  const acme2 = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'PMP-')", select: ["id"], top: 20 });
  check("le 8 Part ACME sono intatte", (acme2.totaleCorrispondenti ?? 0) === 8, String(acme2.totaleCorrispondenti));
  const ecrAcme = await call("aras_query_items", { itemType: "ECR", filter: "item_number eq 'ECR-100001'", select: ["id", "state"], top: 1 });
  check("la ECR ACME e' intatta", (ecrAcme.items ?? []).length === 1, JSON.stringify(ecrAcme).slice(0, 160));

  console.log(`\n${"=".repeat(52)}\n${ok} passati, ${ko} falliti`);
} catch (e) { console.log("ERRORE:", e.message); process.exitCode = 1 }
finally { c.kill() }
