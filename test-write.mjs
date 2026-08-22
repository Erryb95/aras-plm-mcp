/**
 * Collaudo del percorso di SCRITTURA (ARAS_READONLY=false).
 * Opera solo su elementi usa-e-getta con prefisso ZZ-TEST-, creati e rimossi qui:
 * i dati ACME non vengono mai toccati.
 */
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ARAS_READONLY: "false" },
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
let buf = "", id = 1;
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
const rpc = (method, params) => new Promise((res, rej) => {
  const i = id++; pending.set(i, res);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  setTimeout(() => rej(new Error(`timeout ${method}`)), 180000);
});
const call = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
  try { return JSON.parse(t); } catch { return { _testo: t }; }
};
let ok = 0, ko = 0;
const check = (n, c, d = "") => { if (c) { ok++; console.log(`  OK   ${n}`); } else { ko++; console.log(`  FAIL ${n}  ${d}`); } };

const NUM = "ZZ-TEST-DEL-001";
let creata = null;

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.log("=== pulizia da esecuzioni precedenti ===");
  const pre = await call("aras_query_items", { itemType: "Part", filter: `item_number eq '${NUM}'`, select: ["id"], top: 1 });
  if (pre.items?.length) {
    await call("aras_delete_item", { itemType: "Part", id: pre.items[0].id, modo: "delete", conferma: true, ignoraAvvertenze: true });
    console.log("  rimossa una Part residua");
  }

  console.log("\n=== 1. Creazione ===");
  const c = await call("aras_create_item", {
    itemType: "Part",
    properties: { item_number: NUM, name: "Part usa e getta per test", description: "cancellabile" },
  });
  creata = c.item?.id ?? null;
  console.log(`  id=${creata}`);
  check("Part creata", !!creata, JSON.stringify(c).slice(0, 200));
  if (!creata) throw new Error("senza la Part di prova il resto non ha senso");

  console.log("\n=== 2. Validazione schema in scrittura ===");
  const bad = await call("aras_create_item", { itemType: "Part", properties: { item_number: "ZZ-X", campo_inesistente: 1 } });
  check("proprieta' inesistente rifiutata", bad.scritto === false && bad.proprietaSconosciute?.includes("campo_inesistente"),
    JSON.stringify(bad).slice(0, 180));
  const dry = await call("aras_create_item", { itemType: "Part", properties: { item_number: "ZZ-DRY", name: "prova" }, dryRun: true });
  check("dryRun non scrive", dry.scritto === false && dry.validazione === "ok", JSON.stringify(dry).slice(0, 160));
  const dryCheck = await call("aras_query_items", { itemType: "Part", filter: `item_number eq 'ZZ-DRY'`, select: ["id"], top: 1 });
  check("dryRun non ha creato nulla", (dryCheck.items?.length ?? 0) === 0);

  console.log("\n=== 3. Aggiornamento (e versionamento implicito) ===");
  const revPrima = await call("aras_get_revisions", { itemType: "Part", id: creata });
  const up = await call("aras_update_item", { itemType: "Part", id: creata, properties: { description: "descrizione aggiornata" } });
  check("aggiornamento riuscito", up.aggiornato === true, JSON.stringify(up).slice(0, 160));
  const revDopo = await call("aras_get_revisions", { itemType: "Part", id: creata });
  console.log(`  generazioni prima=${revPrima.generazioni} dopo=${revDopo.generazioni}`);
  // Comportamento Aras documentato: su un tipo versionabile l'update crea una nuova
  // generazione. Non e' un dettaglio: chi corregge una descrizione si ritrova una revisione.
  check("l'update ha creato una nuova generazione", revDopo.generazioni === revPrima.generazioni + 1,
    `${revPrima.generazioni} -> ${revDopo.generazioni}`);

  console.log("\n=== 4. Nuova revisione ===");
  const nr = await call("aras_new_revision", { itemType: "Part", id: creata });
  console.log(`  passi: ${(nr.passi ?? []).join(" -> ")}  nuova generazione: ${nr.nuovaGenerazione}`);
  check("nuova generazione creata", nr.creata === true && !!nr.nuovaGenerazione, JSON.stringify(nr).slice(0, 200));
  const rev = await call("aras_get_revisions", { itemType: "Part", id: creata });
  console.log(`  generazioni ora: ${rev.generazioni}`);
  for (const r of rev.revisioni ?? []) console.log(`    gen ${r.generation} rev ${r.majorRev} corrente=${r.isCurrent} bloccata_da=${r.lockedBy}`);
  // create -> gen1, update -> gen2 (versionamento implicito), new_revision -> gen3
  check("tre generazioni presenti", rev.generazioni === 3, String(rev.generazioni));
  check("le generazioni sono numerate 1,2,3",
    JSON.stringify((rev.revisioni ?? []).map((r) => r.generation)) === "[1,2,3]",
    JSON.stringify((rev.revisioni ?? []).map((r) => r.generation)));
  check("una sola generazione e' corrente",
    (rev.revisioni ?? []).filter((r) => r.isCurrent).length === 1);
  check("nessuna generazione resta bloccata", !(rev.revisioni ?? []).some((r) => r.lockedBy),
    JSON.stringify((rev.revisioni ?? []).map((r) => r.lockedBy)));

  console.log("\n=== 5. Protezioni di cancellazione ===");
  const noConf = await call("aras_delete_item", { itemType: "Part", id: creata, modo: "purge", conferma: false });
  check("senza conferma -> rifiutata", noConf.cancellato === false && /conferma/i.test(noConf.motivo ?? ""),
    JSON.stringify(noConf).slice(0, 160));

  console.log("\n=== 6. Cancellazione effettiva ===");
  const piano = await call("aras_plan_delete", { itemType: "Part", id: creata, modo: "delete" });
  console.log(`  effetto: ${piano.effetto} · eseguibile=${piano.eseguibile}`);
  for (const a of piano.avvertenze ?? []) console.log(`    ! ${a}`);
  const del = await call("aras_delete_item", { itemType: "Part", id: creata, modo: "delete", conferma: true, ignoraAvvertenze: true });
  check("cancellazione eseguita", del.cancellato === true, JSON.stringify(del).slice(0, 200));
  const dopo = await call("aras_query_items", { itemType: "Part", filter: `item_number eq '${NUM}'`, select: ["id"], top: 5 });
  check("tutte le generazioni rimosse", (dopo.items?.length ?? 0) === 0, `rimaste ${dopo.items?.length}`);
  creata = null;

  console.log("\n=== 7. I dati ACME sono intatti ===");
  const acme = await call("aras_query_items", { itemType: "Part", filter: `startswith(item_number,'PMP-')`, select: ["id"], top: 50 });
  check("le 8 Part PMP- ci sono ancora", (acme.totaleCorrispondenti ?? 0) === 8, String(acme.totaleCorrispondenti));

  console.log(`\n${"=".repeat(50)}`);
  console.log(`${ok} controlli passati, ${ko} falliti`);
} catch (e) {
  console.log(`\nERRORE: ${e.message}`);
  if (creata) console.log(`ATTENZIONE: la Part di prova ${creata} potrebbe essere rimasta a database.`);
  process.exitCode = 1;
} finally {
  child.kill();
}
