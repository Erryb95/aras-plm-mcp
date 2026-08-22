/** Collaudo di permessi, operazioni massive, sequenze, metodi ed export AML. */
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

  console.log("=== 1. Dettaglio di un Permission ===");
  const d = await call("aras_get_permission_detail", { nomePermesso: "New Part" });
  for (const g of (d.concessioni ?? []).slice(0, 6)) {
    console.log(`  ${String(g.identita).padEnd(24)} leggi=${g.leggere} modifica=${g.modificare} cancella=${g.cancellare}`);
  }
  check("permesso letto con le concessioni", (d.concessioni ?? []).length > 0, JSON.stringify(d).slice(0, 200));
  const bad = await call("aras_get_permission_detail", { nomePermesso: "NonEsiste_XYZ" });
  check("permesso inesistente -> elenca i disponibili", !!bad.errore && (bad.disponibili ?? []).length > 0, JSON.stringify(bad).slice(0, 160));

  console.log("\n=== 2. Sostituzione componente (dryRun) ===");
  const rep = await call("aras_replace_component", { vecchio: "HW-0010", nuovo: "HW-0020", dryRun: true });
  console.log(`  ${rep.da} -> ${rep.a}: ${rep.righeInteressate} righe in ${JSON.stringify(rep.assiemi)}`);
  check("individua le distinte interessate", rep.righeInteressate === 2, JSON.stringify(rep).slice(0, 220));
  check("dryRun non sostituisce", rep.sostituito === false);
  const noPart = await call("aras_replace_component", { vecchio: "NON-ESISTE", nuovo: "HW-0020", dryRun: true });
  check("componente inesistente -> motivo chiaro", noPart.sostituito === false && /inesistente/.test(noPart.motivo ?? ""), JSON.stringify(noPart));

  console.log("\n=== 3. Aggiornamento massivo (dryRun) ===");
  const bu = await call("aras_bulk_update", { itemType: "Part", filtro: "startswith(item_number,'PMP-')", valori: { description: "aggiornato in blocco" }, dryRun: true });
  console.log(`  corrispondenti: ${bu.corrispondenti}, interessati: ${bu.interessati}`);
  console.log("  ", (bu.elementi ?? []).map((e) => e.etichetta).join(", "));
  check("seleziona le 8 Part PMP-", bu.corrispondenti === 8, String(bu.corrispondenti));
  check("dryRun non scrive", bu.aggiornati === 0);
  const buBad = await call("aras_bulk_update", { itemType: "Part", filtro: "startswith(item_number,'PMP-')", valori: { campo_inventato: 1 }, dryRun: true });
  check("proprieta' inesistente rifiutata", (buBad.proprietaSconosciute ?? []).includes("campo_inventato"), JSON.stringify(buBad).slice(0, 160));

  console.log("\n=== 4. Sequenze ===");
  const s = await call("aras_list_sequences");
  const ecr = (s.sequenze ?? []).find((x) => x.nome === "ECR");
  console.log("  ", (s.sequenze ?? []).slice(0, 6).map((x) => `${x.nome}=${x.prossimo}`).join(" | "));
  check("sequenze elencate", (s.sequenze ?? []).length >= 10, String((s.sequenze ?? []).length));
  check("la sequenza ECR mostra il prossimo numero", !!ecr?.prossimo && /ECR-\d+/.test(ecr.prossimo), JSON.stringify(ecr));

  console.log("\n=== 5. Metodi server ===");
  const m = await call("aras_list_methods", { cerca: "BOM", limite: 10 });
  console.log(`  ${m.totale} metodi contengono 'BOM':`, (m.metodi ?? []).slice(0, 5).map((x) => x.nome).join(" | "));
  check("metodi trovati per nome", (m.totale ?? 0) > 0, JSON.stringify(m).slice(0, 200));
  const mAll = await call("aras_list_methods", { limite: 5 });
  check("il conteggio totale e' maggiore del filtrato", (mAll.totale ?? 0) > (m.totale ?? 0), `${mAll.totale} vs ${m.totale}`);

  console.log("\n=== 6. Export AML ===");
  const e = await call("aras_export_aml", { itemType: "Part", filtro: "[Part].item_number like 'PMP-2%'", massimo: 10 });
  console.log(`  elementi esportati: ${e.elementi}, dimensione AML: ${String(e.aml ?? "").length} caratteri`);
  check("export produce elementi", (e.elementi ?? 0) >= 8, JSON.stringify({ n: e.elementi }));
  check("l'AML contiene le Part", /PMP-2\d+/.test(String(e.aml ?? "")), String(e.aml ?? "").slice(0, 150));

  console.log("\n=== 7. I dati non sono stati toccati ===");
  const acme = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'PMP-')", select: ["id", "description"], top: 20 });
  const toccate = (acme.items ?? []).filter((x) => x.description === "aggiornato in blocco");
  check("nessuna descrizione modificata", toccate.length === 0, `${toccate.length} modificate`);
  const bom = await call("aras_get_bom", { partId: (await call("aras_query_items", { itemType: "Part", filter: "item_number eq 'PMP-2000'", select: ["id"], top: 1 })).items[0].id, depth: 3 });
  const hw = (bom.distintaPiatta ?? []).filter((r) => r.item_number === "HW-0010");
  check("HW-0010 e' ancora in distinta due volte", hw.length === 2, JSON.stringify(hw));

  console.log(`\n${"=".repeat(50)}\n${ok} passati, ${ko} falliti`);
} catch (e) { console.log("ERRORE:", e.message); process.exitCode = 1 }
finally { c.kill() }
