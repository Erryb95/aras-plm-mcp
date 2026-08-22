import { spawn } from "node:child_process";
const c = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
c.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
let buf = "", id = 1; const p = new Map();
c.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } } });
const rpc = (me, pa) => new Promise((r, j) => { const i = id++; p.set(i, r); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: me, params: pa }) + "\n"); setTimeout(() => j(new Error("timeout " + me)), 180000) });
const call = async (n, a = {}) => { const r = await rpc("tools/call", { name: n, arguments: a }); const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error); try { return JSON.parse(t) } catch { return { _testo: t } } };
let ok = 0, ko = 0;
const check = (n, cnd, d = "") => { if (cnd) { ok++; console.log(`  OK   ${n}`) } else { ko++; console.log(`  FAIL ${n}  ${d}`) } };

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = (await rpc("tools/list", {})).result.tools;
  console.log(`=== ${tools.length} TOOL ===\n`);

  console.log("=== 1. Grafo del ciclo di vita Part ===");
  const m = await call("aras_get_lifecycle_map", { nomeMappa: "Part" });
  console.log("  stati:", m.stati?.join(", "));
  for (const t of m.transizioni ?? []) console.log("   ", t);
  console.log("  ruoli:", m.ruoliCoinvolti?.join(", "));
  check("stati letti", (m.stati?.length ?? 0) >= 5, JSON.stringify(m).slice(0, 150));
  check("transizioni con ruolo", (m.transizioni ?? []).some((t) => t.includes("[ruolo:")));
  check("Preliminary -> Released presente", (m.transizioni ?? []).some((t) => t.startsWith("Preliminary -> Released")));

  console.log("\n=== 2. Identita' dell'utente configurato ===");
  const idn = await call("aras_get_my_identities");
  console.log(`  ${idn.utente}: ${idn.identita?.join(", ") || "(nessuna)"}`);
  check("identita' risolte", (idn.identita?.length ?? 0) >= 1, JSON.stringify(idn).slice(0, 200));

  console.log("\n=== 3. Stato e blocchi su una Part Preliminary ===");
  const parti = await call("aras_query_items", { itemType: "Part", filter: "state eq 'Preliminary'", select: ["id", "item_number", "state"], top: 1 });
  const pre = parti.items?.[0];
  console.log("  Part:", pre?.item_number, pre?.state);
  const st = await call("aras_get_lifecycle_state", { itemType: "Part", id: pre.id });
  console.log("  promuovibile a:", st.promuovibileA?.join(", ") || "(nessuno)");
  console.log("  transizioni previste:", JSON.stringify(st.transizioniPreviste));
  if (st.bloccate) for (const b of st.bloccate) console.log(`    BLOCCATA -> ${b.verso}: serve "${b.ruoloRichiesto}"`);
  check("transizioni previste elencate", (st.transizioniPreviste?.length ?? 0) > 0, JSON.stringify(st).slice(0, 200));
  check("i ruoli richiesti sono esposti", (st.transizioniPreviste ?? []).some((t) => t.ruoloRichiesto));

  console.log("\n=== 4. Piano di rilascio (dryRun) ===");
  const pl = await call("aras_release_item", { itemType: "Part", id: pre.id, statoTarget: "Released", dryRun: true });
  console.log("  percorso:", pl.percorso, "| eseguibile:", pl.eseguibile);
  console.log("  passi:", JSON.stringify(pl.passi));
  console.log("  ruoli mancanti:", pl.ruoliMancanti?.filter(Boolean).join(", ") || "(nessuno)");
  check("percorso calcolato", !!pl.percorso, JSON.stringify(pl).slice(0, 200));
  check("dryRun non rilascia", pl.rilasciato === false);

  console.log("\n=== 5. Percorso impossibile gestito ===");
  const bad = await call("aras_release_item", { itemType: "Part", id: pre.id, statoTarget: "Stato Inesistente", dryRun: true });
  check("stato irraggiungibile -> motivo chiaro", bad.rilasciato === false && !!bad.motivo, JSON.stringify(bad).slice(0, 160));

  console.log("\n=== 6. Log ===");
  const lg = await call("aras_get_logs", { righe: 20 });
  console.log("  installDir:", lg.installDir);
  console.log("  file con righe:", lg.fileConRighe, "| righe totali:", lg.righeTotali);
  console.log("  sorgenti vuote:", (lg.sorgentiVuote ?? []).length);
  console.log("  SystemEventLog:", JSON.stringify(lg.systemEventLog)?.slice(0, 120));
  if (lg.nota) console.log("  nota:", lg.nota);
  check("lettura log non va in errore", typeof lg.righeTotali === "number", JSON.stringify(lg).slice(0, 200));
  check("assenza di log spiegata", lg.righeTotali > 0 || !!lg.nota);

  console.log("\n=== 7. Scritture bloccate in sola lettura ===");
  const cu = await call("aras_create_user", { login: "zz_test", nome: "Zz", cognome: "Test" });
  check("create_user rifiutato", cu.creato === false, JSON.stringify(cu).slice(0, 140));
  const cg = await call("aras_create_group", { nome: "ZZ Gruppo" });
  check("create_group rifiutato", cg.creato === false, JSON.stringify(cg).slice(0, 140));
  const mm = await call("aras_manage_membership", { gruppo: "Aras PLM", membro: "Innovator Admin", azione: "rimuovi" });
  check("manage_membership rifiutato", mm.fatto === false, JSON.stringify(mm).slice(0, 140));

  console.log(`\n${"=".repeat(50)}\n${ok} passati, ${ko} falliti`);
} catch (e) { console.log("ERRORE:", e.message); process.exitCode = 1 }
finally { c.kill() }
