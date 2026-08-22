/** Collaudo dell'amministrazione schema. Crea e rimuove solo ItemType con prefisso ZZT_. */
import { spawn } from "node:child_process";
const c = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ARAS_READONLY: "false" } });
c.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
let buf = "", id = 1; const p = new Map();
c.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } } });
const rpc = (me, pa) => new Promise((r, j) => { const i = id++; p.set(i, r); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: me, params: pa }) + "\n"); setTimeout(() => j(new Error("timeout " + me)), 180000) });
const call = async (n, a = {}) => { const r = await rpc("tools/call", { name: n, arguments: a }); const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error); try { return JSON.parse(t) } catch { return { _testo: t } } };
let ok = 0, ko = 0;
const check = (n, cnd, d = "") => { if (cnd) { ok++; console.log(`  OK   ${n}`) } else { ko++; console.log(`  FAIL ${n}  ${String(d).slice(0, 220)}`) } };
const T = "ZZT_Progetto";

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  console.log(`=== ${(await rpc("tools/list", {})).result.tools.length} TOOL ===\n`);

  // pulizia preventiva
  const via = await call("aras_query_items", { itemType: "ItemType", filter: `name eq '${T}'`, select: ["id"], top: 1 });
  for (const it of via.items ?? []) await call("aras_aml_request", { itemXml: `<Item type="ItemType" id="${it.id}" action="delete"/>` });

  console.log("=== 1. Creazione ItemType con proprieta' ===");
  const r = await call("aras_create_item_type", {
    nome: T, etichetta: "Progetto di prova", versionabile: false,
    permissionName: "Aras PLM Full", canAddIdentity: "Aras PLM",
    proprieta: [
      { nome: "codice", tipo: "string", lunghezza: 32, obbligatoria: true, etichetta: "Codice" },
      { nome: "titolo", tipo: "string", lunghezza: 128 },
      { nome: "inizio", tipo: "date" },
      { nome: "budget", tipo: "decimal" },
    ],
  });
  for (const s of r.passi ?? []) console.log(`   ${String(s.passo).padEnd(22)} ${s.esito}`);
  console.log("  istanziabile:", r.istanziabile);
  if (r.nota) console.log("  nota:", r.nota.slice(0, 160));
  check("ItemType creato", r.creato === true, JSON.stringify(r).slice(0, 220));
  check("4 proprieta' create", r.proprietaCreate?.length === 4, JSON.stringify(r.proprietaCreate));
  check("il tipo accetta istanze", r.istanziabile === true, JSON.stringify(r.passi));

  console.log("\n=== 1b. Creazione di istanze reali ===");
  const i1 = await call("aras_create_item", { itemType: T, properties: { codice: "PRJ-001", titolo: "Nuova linea pompe", budget: 250000 } });
  check("istanza creata via aras_create_item", i1.scritto === true, JSON.stringify(i1).slice(0, 220));
  const i2 = await call("aras_create_item", { itemType: T, properties: { codice: "PRJ-002", titolo: "Revamping impianto", budget: 90000 } });
  check("seconda istanza creata", i2.scritto === true, JSON.stringify(i2).slice(0, 220));
  const q2 = await call("aras_query_items", { itemType: T, select: ["codice", "titolo", "budget"], orderby: "codice asc", top: 10 });
  console.log("  istanze:", JSON.stringify((q2.items ?? []).map((x) => `${x.codice} ${x.titolo} ${x.budget}`)));
  check("le istanze sono rileggibili", (q2.totaleCorrispondenti ?? 0) === 2, String(q2.totaleCorrispondenti));
  const s2 = await call("aras_search", { term: "Revamping", itemTypes: [T], perType: 5 });
  check("le istanze sono cercabili", (s2.hits ?? []).some((h) => /PRJ-002|Revamping/.test(h.etichetta + h.valore)), JSON.stringify(s2).slice(0, 200));

  console.log("\n=== 2. Lo schema e' leggibile dai tool di introspezione ===");
  const d = await call("aras_describe_item_type", { itemType: T });
  console.log("  proprieta' viste:", (d.proprieta ?? []).map((x) => x.name).filter((n) => ["codice", "titolo", "inizio", "budget"].includes(n)).join(", "));
  check("introspezione vede il nuovo tipo", d.itemType === T, JSON.stringify(d).slice(0, 160));
  check("vede le proprieta' create", (d.proprieta ?? []).some((x) => x.name === "codice"));

  console.log("\n=== 3. Aggiunta di una proprieta' a posteriori ===");
  const ap = await call("aras_add_property", { itemType: T, nome: "responsabile", tipo: "string", lunghezza: 64 });
  check("proprieta' aggiunta", ap.aggiunta === true, JSON.stringify(ap));
  const dup = await call("aras_add_property", { itemType: T, nome: "responsabile", tipo: "string" });
  check("duplicato rifiutato", dup.aggiunta === false, JSON.stringify(dup));

  console.log("\n=== 4. Tipo inesistente gestito ===");
  const no = await call("aras_add_property", { itemType: "ZZT_NonEsiste", nome: "x", tipo: "string" });
  check("ItemType inesistente -> motivo chiaro", no.aggiunta === false && /inesistente/.test(no.motivo ?? ""), JSON.stringify(no));

  console.log("\n=== 5. Pulizia ===");
  const q = await call("aras_query_items", { itemType: "ItemType", filter: `name eq '${T}'`, select: ["id"], top: 1 });
  for (const it of q.items ?? []) await call("aras_aml_request", { itemXml: `<Item type="ItemType" id="${it.id}" action="delete"/>` });
  const resta = await call("aras_query_items", { itemType: "ItemType", filter: `startswith(name,'ZZT_')`, select: ["id"], top: 10 });
  check("ItemType di prova rimosso", (resta.totaleCorrispondenti ?? 0) === 0, `rimasti ${resta.totaleCorrispondenti}`);

  console.log(`\n${"=".repeat(50)}\n${ok} passati, ${ko} falliti`);
} catch (e) { console.log("ERRORE:", e.message); process.exitCode = 1 }
finally { c.kill() }
