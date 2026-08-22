/**
 * Esegue OGNI esempio di DEMO.md, nell'ordine del copione.
 * Serve a garantire che domani nessun blocco fallisca davanti a qualcuno.
 * Solo lettura e dryRun: non modifica nulla.
 */
import { spawn } from "node:child_process";
const c = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
c.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
let buf = "", id = 1; const p = new Map();
c.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } } });
const rpc = (me, pa) => new Promise((r, j) => { const i = id++; p.set(i, r); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: me, params: pa }) + "\n"); setTimeout(() => j(new Error("timeout")), 150000) });
const call = async (n, a = {}) => { const r = await rpc("tools/call", { name: n, arguments: a }); const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error); try { return JSON.parse(t) } catch { return { _testo: t } } };

const ID = {
  pompa: "6E9D0798F21C4B63BA8BB2D4E2CC28BF",
  girante: "EFF354DBADF84DD0BC2D6C0DA8F11B67",
  idraulico: "106BA71E80674E5C85CCF90179774050",
  vite: "229EC928CC40475C9D1A1017B85223A4",
  tenuta: "75ED1B58330044B096680AB96CEC64A1",
  ecr: "09A25FA7FEC74926B5C3908B3FEFC13B",
  admin: "DBA5D86402BF43D5976854B8B48FCDD1",
  reparto: "AB39BA0265814FABAD53F6886219FB7E",
};

// [numero nel copione, tool, argomenti, verifica che il blocco "dica qualcosa"]
const COPIONE = [
  ["0",  "aras_ping", {}, (r) => r.itemTypes === 484],
  ["1",  "aras_search", { term: "cavitazione" }, (r) => (r.hits ?? []).length >= 2],
  ["2",  "aras_get_item", { itemType: "ECR", id: ID.ecr }, (r) => !!r.title || !!r.item_number],
  ["3",  "aras_get_change_impact", { changeType: "ECR", changeId: ID.ecr }, (r) => (r.impatti ?? []).some((i) => i.elemento === "PMP-2110")],
  ["4",  "aras_where_used", { partId: ID.girante, depth: 5 }, (r) => (r.assiemi ?? []).some((a) => a.item_number === "PMP-2000")],
  ["5",  "aras_get_documents", { partId: ID.girante }, (r) => (r.documenti ?? []).length >= 1 && (r.modelliCad ?? []).length >= 1],
  ["6",  "aras_get_workflow", { itemId: ID.ecr }, (r) => (r.processi?.[0]?.dettaglioAttivita ?? []).some((a) => (a.vie ?? []).length > 0)],
  ["7",  "aras_get_inbasket", { identityId: ID.admin }, (r) => typeof r.compiti === "number"],
  ["8",  "aras_get_bom", { partId: ID.pompa, depth: 4 }, (r) => (r.distintaPiatta ?? []).filter((x) => x.item_number === "HW-0010").length === 2],
  ["9",  "aras_get_aml", { partId: ID.vite }, (r) => r.aml?.[0]?.costruttore === "Bossard Italia"],
  ["10", "aras_get_relationships", { relationshipType: "Part BOM", sourceId: ID.idraulico }, (r) => (r.righe ?? []).some((x) => x.verso && x.quantity !== undefined)],
  ["11", "aras_get_revisions", { itemType: "Part", id: ID.tenuta }, (r) => r.generazioni >= 2],
  ["12", "aras_get_history", { itemType: "ECR", id: ID.ecr }, (r) => typeof r.eventi === "number"],
  ["13", "aras_check_effectivity", { partIds: [ID.pompa], data: "2026-01-15" }, (r) => r.verificate === 1],
  ["14", "aras_plan_delete", { itemType: "Part", id: ID.vite, modo: "delete" }, (r) => r.eseguibile === false && (r.avvertenze ?? []).length > 0],
  ["15", "aras_get_type_permissions", { itemType: "Manufacturer" }, (r) => (r.identitaConPermessoAdd ?? []).includes("Component Engineering")],
  ["16", "aras_lookup_error", { testo: "no default permission" }, (r) => (r.messaggi ?? []).length >= 1],
  ["17a", "aras_replace_component", { vecchio: "HW-0010", nuovo: "HW-0020", dryRun: true }, (r) => r.righeInteressate === 2 && r.sostituito === false],
  ["17b", "aras_bulk_update", { itemType: "Part", filtro: "startswith(item_number,'PMP-')", valori: { description: "x" }, dryRun: true }, (r) => r.corrispondenti === 8 && r.aggiornati === 0],
  ["18", "aras_get_lifecycle_map", { nomeMappa: "Part" }, (r) => (r.transizioni ?? []).some((t) => t.includes("[ruolo:"))],
  ["19", "aras_get_lifecycle_state", { itemType: "Part", id: ID.girante }, (r) => (r.transizioniPreviste ?? []).length > 0],
  ["20", "aras_release_item", { itemType: "Part", id: ID.girante, dryRun: true }, (r) => !!r.percorso],
  ["21", "aras_check_release_readiness", { partId: ID.pompa }, (r) => typeof r.componenti === "number"],
  ["22", "aras_describe_item_type", { itemType: "Part" }, (r) => (r.proprieta ?? []).length > 30],
  ["23", "aras_get_list_values", { itemType: "Part" }, (r) => JSON.stringify(r.liste?.make_buy) === '["Make","Buy"]'],
  ["24a", "aras_list_dashboards", {}, (r) => (r.elenco ?? []).some((d) => (d.contenuti ?? []).length > 0)],
  ["24b", "aras_list_metrics", { filtro: "ECR" }, (r) => (r.metriche ?? 0) > 0],
  ["25", "aras_get_effectivity_config", {}, (r) => (r.variabili ?? []).length === 3],
  ["26", "aras_get_logs", { righe: 20, filtro: "OData" }, (r) => typeof r.righeTotali === "number"],
  ["27a", "aras_list_item_types", { search: "change" }, (r) => (r.itemTypes ?? []).length > 0],
  ["27b", "aras_list_reports", {}, (r) => (r.report ?? 0) >= 15],
  ["27c", "aras_list_queries", {}, (r) => (r.query ?? 0) >= 10],
  ["27d", "aras_list_sequences", {}, (r) => (r.sequenze ?? []).length >= 10],
  ["27e", "aras_list_methods", { cerca: "effs" }, (r) => (r.totale ?? 0) > 0],
  ["27f", "aras_get_identity_members", { identityId: ID.reparto }, (r) => typeof r.membri === "number"],
  ["27g", "aras_get_permission_detail", { nomePermesso: "New Part" }, (r) => (r.concessioni ?? []).length > 0],
  ["27h", "aras_export_aml", { itemType: "Part", filtro: "[Part].item_number like 'PMP-21%'" }, (r) => (r.elementi ?? 0) >= 3],
  ["VI",  "aras_create_part", { item_number: "ZZ-DEMO-1", name: "Prova", make_buy: "Make" }, (r) => r.creata === false && /sola lettura/.test(r.motivo ?? "")],
  ["NO",  "aras_run_report", { nome: "BOM Costing Report", contestoId: ID.pompa }, (r) => r.eseguito === false && !!r.nota],
];

let ok = 0, ko = 0;
try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "demo", version: "1" } });
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  console.log("=== verifica di ogni blocco di DEMO.md ===\n");
  for (const [n, tool, args, verifica] of COPIONE) {
    try {
      const r = await call(tool, args);
      if (verifica(r)) { ok++; console.log(`  OK   [${n}] ${tool}`); }
      else { ko++; console.log(`  FAIL [${n}] ${tool}  ${JSON.stringify(r).slice(0, 220)}`); }
    } catch (e) { ko++; console.log(`  ERR  [${n}] ${tool}: ${e.message}`); }
  }
  console.log(`\n${"=".repeat(52)}\n${ok} blocchi funzionanti, ${ko} da correggere`);
  if (ko === 0) console.log("Il copione e' eseguibile dall'inizio alla fine.");
} finally { c.kill() }
