/** Collaudo di report, catalogo errori, ricerche salvate, delega e import AML. */
import { spawn } from "node:child_process";
const c = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ARAS_READONLY: "false" } });
c.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
let buf = "", id = 1; const p = new Map();
c.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } } });
const rpc = (me, pa) => new Promise((r, j) => { const i = id++; p.set(i, r); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: me, params: pa }) + "\n"); setTimeout(() => j(new Error("timeout " + me)), 180000) });
const call = async (n, a = {}) => { const r = await rpc("tools/call", { name: n, arguments: a }); const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error); try { return JSON.parse(t) } catch { return { _testo: t } } };
let ok = 0, ko = 0;
const check = (n, cnd, d = "") => { if (cnd) { ok++; console.log(`  OK   ${n}`) } else { ko++; console.log(`  FAIL ${n}  ${String(d).slice(0, 220)}`) } };

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  console.log(`=== ${(await rpc("tools/list", {})).result.tools.length} TOOL ===\n`);

  console.log("=== 1. Report configurati ===");
  const r = await call("aras_list_reports");
  for (const x of (r.elenco ?? []).slice(0, 8)) console.log(`  ${String(x.nome).padEnd(34)} ${x.ambito ?? ""} ${(x.perItemType ?? []).join(",")}`);
  check("report trovati", (r.report ?? 0) >= 15, String(r.report));
  check("almeno un report e' legato a un ItemType", (r.elenco ?? []).some((x) => (x.perItemType ?? []).length > 0), JSON.stringify((r.elenco ?? []).map((x) => x.perItemType)).slice(0, 200));

  console.log("\n=== 2. Esecuzione di un report ===");
  const nomeRep = (r.elenco ?? []).find((x) => /BOM/i.test(String(x.nome)))?.nome ?? r.elenco[0].nome;
  const pmp = (await call("aras_query_items", { itemType: "Part", filter: "item_number eq 'PMP-2000'", select: ["id"], top: 1 })).items[0];
  const run = await call("aras_run_report", { nome: nomeRep, contestoId: pmp.id, massimo: 10 });
  console.log(`  ${nomeRep}: eseguito=${run.eseguito} elementi=${run.elementi ?? "-"}`);
  if (!run.eseguito) console.log("    motivo:", String(run.motivo ?? "").slice(0, 140));
  check("il report risponde in modo interpretabile", typeof run.eseguito === "boolean", JSON.stringify(run).slice(0, 200));
  const noRep = await call("aras_run_report", { nome: "NonEsiste_XYZ" });
  check("report inesistente -> elenca i disponibili", !!noRep.errore && (noRep.disponibili ?? []).length > 0, JSON.stringify(noRep).slice(0, 160));

  console.log("\n=== 3. Catalogo degli errori Aras ===");
  const e1 = await call("aras_lookup_error", { testo: "no default permission" });
  for (const m of (e1.messaggi ?? []).slice(0, 3)) console.log(`  ${String(m.codice).padEnd(46)} ${String(m.testo).slice(0, 70)}`);
  check("trova il messaggio sul permesso mancante", (e1.messaggi ?? []).some((m) => /noDefaultPermission/i.test(String(m.codice))), JSON.stringify(e1).slice(0, 220));
  const e2 = await call("aras_lookup_error", { testo: "Add access is denied" });
  check("trova il messaggio sul diniego di Add", (e2.messaggi ?? []).some((m) => /PermissionsNoCanAdd/i.test(String(m.codice))), JSON.stringify(e2).slice(0, 220));
  const e3 = await call("aras_lookup_error", { testo: "zzz_nulla_del_genere" });
  check("nessuna corrispondenza gestita", (e3.corrispondenti ?? 0) === 0, JSON.stringify(e3).slice(0, 140));

  console.log("\n=== 4. Ricerche salvate ===");
  const ss = await call("aras_list_saved_searches");
  console.log("  ", (ss.elenco ?? []).slice(0, 5).map((x) => x.nome).join(" | "));
  check("ricerche salvate elencate", (ss.ricerche ?? 0) >= 5, String(ss.ricerche));

  console.log("\n=== 5. Delega attivita' (dryRun) ===");
  const ecr = (await call("aras_query_items", { itemType: "ECR", select: ["id"], top: 1 })).items[0];
  const wf = await call("aras_get_workflow", { itemId: ecr.id });
  const att = (wf.processi?.[0]?.dettaglioAttivita ?? []).find((a) => a.stato === "Active" && a.assegnazioni.length);
  console.log(`  attivita' attiva: ${att?.nome} assegnata a ${att?.assegnazioni?.[0]?.identita}`);
  const del = await call("aras_delegate_activity", { activityId: att.id, assignmentId: att.assegnazioni[0].id, aIdentita: "ACME Engineering", dryRun: true });
  check("delega pianificata", del.delegata === false && del.a === "ACME Engineering", JSON.stringify(del).slice(0, 180));
  const delBad = await call("aras_delegate_activity", { activityId: att.id, assignmentId: att.assegnazioni[0].id, aIdentita: "NonEsiste_XYZ", dryRun: true });
  check("identita' inesistente -> motivo chiaro", delBad.delegata === false && /inesistente/.test(delBad.motivo ?? ""), JSON.stringify(delBad).slice(0, 160));

  console.log("\n=== 6. Import AML (dryRun) ===");
  const imp = await call("aras_import_aml", { contenuto: `<Item type="Part" action="add"><item_number>ZZR-1</item_number></Item><Item type="Part" action="delete" id="AAAA"/>`, dryRun: true });
  console.log("  ", JSON.stringify(imp));
  check("analizza il pacchetto", imp.elementiNelPacchetto === 2, JSON.stringify(imp).slice(0, 180));
  check("segnala le azioni distruttive", imp.azioniDistruttive === 1 && !!imp.nota, JSON.stringify(imp).slice(0, 180));
  check("dryRun non applica", imp.importato === false);

  console.log("\n=== 7. Nulla e' stato modificato ===");
  const zz = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'ZZR-')", select: ["id"], top: 5 });
  check("il pacchetto non e' stato applicato", (zz.totaleCorrispondenti ?? 0) === 0, String(zz.totaleCorrispondenti));
  const acme = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'PMP-')", select: ["id"], top: 20 });
  check("dati ACME intatti", (acme.totaleCorrispondenti ?? 0) === 8, String(acme.totaleCorrispondenti));

  console.log(`\n${"=".repeat(50)}\n${ok} passati, ${ko} falliti`);
} catch (e) { console.log("ERRORE:", e.message); process.exitCode = 1 }
finally { c.kill() }
