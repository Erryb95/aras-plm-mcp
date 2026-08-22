// Collaudo end-to-end: avvia il server MCP e parla JSON-RPC su stdio come farebbe un client reale.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ARAS_URL: "http://localhost/InnovatorServer", ARAS_DATABASE: "InnovatorSolutions" },
});

child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout su ${method}`)), 180000);
  });
}

const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r.result);

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await rpc("tools/list", {});
  console.log("=== TOOL ESPOSTI ===");
  for (const t of tools.result.tools) console.log(`  ${t.name}`);

  console.log("\n=== aras_ping ===");
  console.log(text(await rpc("tools/call", { name: "aras_ping", arguments: {} })));

  console.log("\n=== aras_list_item_types (search='part') ===");
  const lt = await rpc("tools/call", {
    name: "aras_list_item_types",
    arguments: { search: "part", kind: "all", limit: 10 },
  });
  console.log(text(lt).slice(0, 900));

  console.log("\n=== aras_describe_item_type (Part) ===");
  const d = await rpc("tools/call", { name: "aras_describe_item_type", arguments: { itemType: "Part" } });
  const parsed = JSON.parse(text(d));
  console.log(JSON.stringify({
    itemType: parsed.itemType,
    versionabile: parsed.versionabile,
    obbligatorie: parsed.proprietaObbligatorie,
    numeroProprieta: parsed.proprieta?.length,
    relazioni: parsed.relazioni?.map((r) => `${r.name} -> ${r.verso}`),
  }, null, 2));

  console.log("\n=== errore gestito: ItemType inesistente ===");
  console.log(text(await rpc("tools/call", { name: "aras_describe_item_type", arguments: { itemType: "Prt" } })).slice(0, 400));

  console.log("\n=== scrittura bloccata in sola lettura ===");
  console.log(text(await rpc("tools/call", {
    name: "aras_create_item",
    arguments: { itemType: "Part", properties: { item_number: "TEST-1", name: "prova" } },
  })).slice(0, 400));
} finally {
  child.kill();
}
