import { spawn } from "node:child_process";

const ROOT_ID = process.argv[2];
if (!ROOT_ID) { console.error("uso: node test-bom.mjs <partId>"); process.exit(1); }

const child = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let buf = "";
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
let id = 1;
const rpc = (method, params) => new Promise((res, rej) => {
  const i = id++; pending.set(i, res);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  setTimeout(() => rej(new Error(`timeout ${method}`)), 180000);
});
const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r.error);

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.log("=== aras_query_items: le Part create ===");
  const q = await rpc("tools/call", {
    name: "aras_query_items",
    arguments: { itemType: "Part", select: ["item_number", "name"], orderby: "item_number asc", top: 10 },
  });
  const qp = JSON.parse(text(q));
  console.log(`trovate ${qp.totaleCorrispondenti}:`, qp.items.map((p) => p.item_number).join(", "));

  console.log("\n=== aras_get_bom (profondita' 3) ===");
  const b = await rpc("tools/call", { name: "aras_get_bom", arguments: { partId: ROOT_ID, depth: 3 } });
  const bom = JSON.parse(text(b));
  console.log("radice:", bom.radice);
  console.log("\ndistinta piatta:");
  for (const r of bom.distintaPiatta) {
    console.log(`  ${"  ".repeat(r.livello)}L${r.livello} ${r.item_number.padEnd(10)} qta cumulata ${r.qtaCumulata}`);
  }

  const check = (num, exp) => {
    const row = bom.distintaPiatta.find((r) => r.item_number === num);
    const ok = row && row.qtaCumulata === exp;
    console.log(`  ${ok ? "OK  " : "FAIL"} ${num}: atteso ${exp}, ottenuto ${row?.qtaCumulata}`);
    return ok;
  };
  console.log("\nverifica quantita' cumulate:");
  const results = [check("P-1100", 2), check("P-1200", 1), check("P-1110", 8), check("P-1120", 4)];
  console.log(results.every(Boolean) ? "\nTUTTI I CONTROLLI PASSATI" : "\nCI SONO FALLIMENTI");

  console.log("\n=== aras_get_relationships (Part BOM della radice) ===");
  const rel = await rpc("tools/call", {
    name: "aras_get_relationships",
    arguments: { relationshipType: "Part BOM", sourceId: ROOT_ID },
  });
  console.log(`righe di distinta dirette: ${JSON.parse(text(rel)).totale}`);
} finally {
  child.kill();
}
