/** Chiama ogni tool di lettura rimasto e riporta se risponde in modo utile. */
import { spawn } from "node:child_process";
const c = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "", id = 1; const p = new Map();
c.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } } });
const rpc = (me, pa) => new Promise((r, j) => { const i = id++; p.set(i, r); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: me, params: pa }) + "\n"); setTimeout(() => j(new Error("timeout")), 120000) });
const call = async (n, a = {}) => { const r = await rpc("tools/call", { name: n, arguments: a }); const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error); try { return JSON.parse(t) } catch { return { _testo: t } } };

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "live", version: "1" } });
c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);

// id di riferimento sui dati ACME
const q = async (t, f, s = ["id"]) => (await call("aras_query_items", { itemType: t, filter: f, select: s, top: 1 })).items?.[0];
const pmp = await q("Part", "item_number eq 'PMP-2000'");
const gir = await q("Part", "item_number eq 'PMP-2110'");
const drw = await q("Document", "item_number eq 'DRW-2110'");
const cad = await q("CAD", "item_number eq 'CAD-2110'");
const ecr = await q("ECR", "item_number eq 'ECR-100001'");
const eng = await q("Identity", "name eq 'ACME Engineering'");
const csp = await q("Identity", "name eq 'Change Specialist I'");

const prove = [
  ["aras_get_item", { itemType: "Part", id: pmp.id, select: ["item_number", "name", "state"] }, (r) => r.item_number === "PMP-2000"],
  ["aras_describe_item_type", { itemType: "Part" }, (r) => (r.proprieta ?? []).length > 30],
  ["aras_get_documents", { partId: gir.id }, (r) => (r.documenti ?? []).length >= 1],
  ["aras_get_files", { itemType: "Document", id: drw.id }, (r) => typeof r.allegati === "number"],
  ["aras_get_files (CAD)", { itemType: "CAD", id: cad.id }, (r) => r.relazione === "CADFiles", "aras_get_files"],
  ["aras_get_identity_members", { identityId: eng.id }, (r) => typeof r.membri === "number"],
  ["aras_get_inbasket", { identityId: csp.id }, (r) => typeof r.compiti === "number"],
  ["aras_check_effectivity", { partIds: [pmp.id, gir.id], data: "2026-08-21" }, (r) => r.verificate === 2],
  ["aras_describe_query", { nome: "PE_BomStructure" }, (r) => (r.elementi ?? []).length > 0],
  ["aras_list_queries", {}, (r) => (r.query ?? 0) >= 10],
  ["aras_list_metrics", {}, (r) => (r.metriche ?? 0) >= 20],
  ["aras_list_reports", {}, (r) => (r.report ?? 0) >= 15],
  ["aras_list_saved_searches", {}, (r) => (r.ricerche ?? 0) >= 5],
  ["aras_get_permission_detail", { nomePermesso: "New Part" }, (r) => (r.concessioni ?? []).length > 0],
  ["aras_bulk_update", { itemType: "Part", filtro: "startswith(item_number,'PMP-')", valori: { description: "x" }, dryRun: true }, (r) => r.corrispondenti === 8 && r.aggiornati === 0],
  ["aras_aml_request", { itemXml: `<Item type="Part" action="get" select="item_number" maxRecords="3"/>` }, (r) => r.eseguito === true],
  ["aras_run_query", { nome: "PE_BomStructure" }, (r) => r.eseguita === false && !!r.alternative],
  ["aras_get_logs", { righe: 5, filtro: "OData" }, (r) => typeof r.righeTotali === "number"],
  ["aras_get_change_impact", { changeType: "ECN", changeId: (await q("ECN", "item_number eq 'ECN-100001'")).id }, (r) => (r.impatti ?? []).length >= 1],
];

let ok = 0, ko = 0;
const esiti = [];
for (const [etichetta, args, verifica, nomeReale] of prove) {
  const nome = nomeReale ?? etichetta;
  try {
    const r = await call(nome, args);
    const buono = verifica(r);
    if (buono) { ok++; console.log(`OK   ${etichetta}`); esiti.push([etichetta, "verificato"]); }
    else { ko++; console.log(`FAIL ${etichetta}  ${JSON.stringify(r).slice(0, 200)}`); esiti.push([etichetta, "DA CONTROLLARE"]); }
  } catch (e) {
    ko++; console.log(`ERR  ${etichetta}: ${e.message}`); esiti.push([etichetta, "errore"]);
  }
}

// Tool di scrittura: in sola lettura devono rifiutare senza esplodere
const scritture = [
  ["aras_create_item", { itemType: "Part", properties: { item_number: "ZZ-LIVE" } }],
  ["aras_update_item", { itemType: "Part", id: pmp.id, properties: { description: "x" } }],
  ["aras_create_relationship", { relationshipType: "Part Document", sourceId: pmp.id, relatedId: drw.id }],
  ["aras_create_part", { item_number: "ZZ-LIVE-2" }],
  ["aras_create_document", { item_number: "ZZ-LIVE-D" }],
  ["aras_manage_bom_line", { azione: "aggiungi", assieme: "PMP-2000", componente: "PMP-2110" }],
  ["aras_copy_part", { origine: "PMP-2000", nuovo: "ZZ-LIVE-C" }],
  ["aras_add_manufacturer_part", { mpn: "ZZ-M", descrizione: "x", costruttore: "ZZ-F", perPart: "PMP-2110" }],
  ["aras_create_change", { tipo: "ECR", title: "ZZ live" }],
  ["aras_add_affected_item", { tipo: "ECR", changeId: ecr.id, itemNumber: "PMP-2120" }],
  ["aras_create_user", { login: "zzlive", nome: "Zz", cognome: "Live" }],
  ["aras_create_group", { nome: "ZZ Live" }],
  ["aras_manage_membership", { gruppo: "Aras PLM", membro: "Innovator Admin", azione: "rimuovi" }],
  ["aras_grant_permission", { nomePermesso: "New Part", identita: "All Employees" }],
  ["aras_create_item_type", { nome: "ZZ_Live" }],
  ["aras_add_property", { itemType: "Part", nome: "zz_campo", tipo: "string" }],
  ["aras_create_effectivity_model", { nome: "ZZ-LIVE-MOD" }],
  ["aras_new_revision", { itemType: "Part", id: gir.id }],
  ["aras_promote_item", { itemType: "Part", id: gir.id, toState: "Released" }],
  ["aras_delete_item", { itemType: "Part", id: gir.id, modo: "purge", conferma: true }],
  ["aras_import_aml", { contenuto: `<Item type="Part" action="add"/>`, dryRun: false }],
];
console.log("\n--- scritture in sola lettura (devono rifiutare) ---");
for (const [nome, args] of scritture) {
  const r = await call(nome, args);
  const s = JSON.stringify(r);
  const rifiutato = /sola lettura|readOnly/i.test(s);
  if (rifiutato) { ok++; console.log(`OK   ${nome}`); esiti.push([nome, "blocco verificato"]); }
  else { ko++; console.log(`FAIL ${nome}  ${s.slice(0, 160)}`); esiti.push([nome, "BLOCCO NON ATTIVO"]); }
}

console.log(`\n${"=".repeat(52)}\n${ok} verificati, ${ko} da controllare  ·  tool esposti: ${tools.length}`);
c.kill();
