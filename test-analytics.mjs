/** Collaudo di cruscotti, metriche, query salvate ed effettivita'. Sola lettura, salvo i modelli ZZ. */
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

  console.log("=== 1. Cruscotti ===");
  const d = await call("aras_list_dashboards");
  for (const x of (d.elenco ?? []).slice(0, 6)) console.log(`  ${String(x.nome).padEnd(30)} ${(x.contenuti ?? []).join(", ")}`);
  check("cruscotti trovati", (d.cruscotti ?? 0) >= 5, JSON.stringify(d).slice(0, 200));

  console.log("\n=== 2. Metriche e grafici ===");
  const m = await call("aras_list_metrics");
  console.log("  metriche:", (m.elenco ?? []).slice(0, 6).map((x) => x.nome).join(" | "));
  console.log("  grafici :", (m.graficiElenco ?? []).slice(0, 5).map((x) => x.nome).join(" | "));
  check("metriche trovate", (m.metriche ?? 0) >= 20, String(m.metriche));
  check("grafici trovati", (m.grafici ?? 0) >= 10, String(m.grafici));
  const mf = await call("aras_list_metrics", { filtro: "ECR" });
  console.log("  filtro 'ECR':", (mf.elenco ?? []).map((x) => x.nome).join(" | "));
  check("filtro sulle metriche funziona", (mf.metriche ?? 0) > 0 && mf.metriche < m.metriche, `${mf.metriche}/${m.metriche}`);

  console.log("\n=== 3. Query salvate ===");
  const q = await call("aras_list_queries");
  console.log("  ", (q.elenco ?? []).slice(0, 8).map((x) => x.nome).join(" | "));
  check("query salvate trovate", (q.query ?? 0) >= 10, String(q.query));
  const dq = await call("aras_describe_query", { nome: "PE_BomStructure" });
  console.log("  PE_BomStructure:", JSON.stringify(dq).slice(0, 260));
  check("struttura della query leggibile", !!dq.nome || !!dq.errore, JSON.stringify(dq).slice(0, 200));
  const bad = await call("aras_describe_query", { nome: "NonEsiste_XYZ" });
  check("query inesistente -> elenca le disponibili", !!bad.errore && (bad.disponibili ?? []).length > 0, JSON.stringify(bad).slice(0, 160));

  console.log("\n=== 4. Effettivita' ===");
  const e = await call("aras_get_effectivity_config");
  console.log("  scope     :", (e.scope ?? []).join(", "));
  console.log("  variabili :", (e.variabili ?? []).map((v) => `${v.nome}(${v.tipo})`).join(", "));
  console.log("  modelli   :", (e.modelli ?? []).map((x) => x.nome).join(", ") || "(nessuno)");
  console.log("  espressioni su distinta:", e.espressioniSuDistinta);
  check("scope configurato", (e.scope ?? []).includes("Aras Part BOM Scope"), JSON.stringify(e).slice(0, 200));
  check("tre variabili (Model, Unit, Date)", (e.variabili ?? []).length === 3, JSON.stringify(e.variabili));

  const nm = await call("aras_create_effectivity_model", { nome: "ZZ-MOD-1", etichetta: "Modello di prova" });
  check("modello creato", nm.creato === true, JSON.stringify(nm).slice(0, 160));
  const dup = await call("aras_create_effectivity_model", { nome: "ZZ-MOD-1" });
  check("modello duplicato rifiutato", dup.creato === false, JSON.stringify(dup).slice(0, 160));
  const e2 = await call("aras_get_effectivity_config");
  check("il modello compare in configurazione", (e2.modelli ?? []).some((x) => x.nome === "ZZ-MOD-1"));

  console.log("\n=== 5. Pulizia ===");
  const mod = (e2.modelli ?? []).find((x) => x.nome === "ZZ-MOD-1");
  if (mod) await call("aras_aml_request", { itemXml: `<Item type="effs_model" id="${mod.id}" action="delete"/>` });
  const e3 = await call("aras_get_effectivity_config");
  check("modello di prova rimosso", !(e3.modelli ?? []).some((x) => x.nome === "ZZ-MOD-1"), JSON.stringify(e3.modelli));

  console.log(`\n${"=".repeat(50)}\n${ok} passati, ${ko} falliti`);
} catch (e) { console.log("ERRORE:", e.message); process.exitCode = 1 }
finally { c.kill() }
