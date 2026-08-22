/**
 * Crea i 10 utenti della societa' "ARAS DEMO", ciascuno nel proprio reparto ACME
 * e con un ruolo funzionale, cosi' che siano utilizzabili durante la demo
 * (in-basket, delega attivita', permessi).
 *
 *   node tools/crea-utenti-demo.mjs            crea
 *   node tools/crea-utenti-demo.mjs --pulisci  rimuove tutto quello che ha creato
 *
 * Gira come root: creare User e Identity richiede "User Administrators",
 * che admin non ha.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const PULISCI = process.argv.includes("--pulisci");
const AZIENDA = "ARAS DEMO";
const GRUPPO = "ARAS DEMO";
const PASSWORD = "innovator";

const c = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ARAS_READONLY: "false" },
});
c.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
let buf = "", id = 1; const p = new Map();
c.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } } });
const rpc = (me, pa) => new Promise((r, j) => { const i = id++; p.set(i, r); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: me, params: pa }) + "\n"); setTimeout(() => j(new Error("timeout " + me)), 120000) });
const call = async (n, a = {}) => { const r = await rpc("tools/call", { name: n, arguments: a }); const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error); try { return JSON.parse(t) } catch { return { _testo: t } } };

const UTENTI = [
  { login: "pmoretti",  nome: "Paolo",     cognome: "Moretti",  reparto: "ACME Engineering",   ruolo: "Aras PLM" },
  { login: "sgallo",    nome: "Stefano",   cognome: "Gallo",    reparto: "ACME Engineering",   ruolo: "Workflow Manager" },
  { login: "fricci",    nome: "Francesca", cognome: "Ricci",    reparto: "ACME Engineering",   ruolo: "Component Engineering" },
  { login: "aferrari",  nome: "Andrea",    cognome: "Ferrari",  reparto: "ACME Manufacturing", ruolo: "Manufacturing" },
  { login: "dromano",   nome: "Davide",    cognome: "Romano",   reparto: "ACME Manufacturing", ruolo: "Effectivity Management" },
  { login: "lbarbieri", nome: "Luca",      cognome: "Barbieri", reparto: "ACME Manufacturing", ruolo: "Change Specialist II" },
  { login: "gconti",    nome: "Giulia",    cognome: "Conti",    reparto: "ACME Quality",       ruolo: "CRB" },
  { login: "cesposito", nome: "Chiara",    cognome: "Esposito", reparto: "ACME Quality",       ruolo: "Change Control Board" },
  { login: "sgreco",    nome: "Silvia",    cognome: "Greco",    reparto: "ACME Purchasing",    ruolo: "Component Engineering" },
  { login: "emarino",   nome: "Elena",     cognome: "Marino",   reparto: "ACME Purchasing",    ruolo: "Change Specialist I" },
];

const md5 = (s) => createHash("md5").update(s).digest("hex");

async function provaLogin(login) {
  const r = await fetch("http://localhost/InnovatorServer/oauthserver/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password", client_id: "IOMApp", scope: "Innovator",
      database: "InnovatorSolutions", username: login, password: PASSWORD,
    }),
  }).catch((e) => ({ ok: false, status: 0, _e: e.message }));
  return r.ok === true;
}

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "utenti", version: "1" } });
  c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  if (PULISCI) {
    console.log("=== rimozione utenti ARAS DEMO ===\n");
    for (const u of UTENTI) {
      const r = await call("aras_query_items", { itemType: "User", filter: `login_name eq '${u.login}'`, select: ["id"], top: 1 });
      const uid = r.items?.[0]?.id;
      if (!uid) { console.log(`  --   ${u.login} (assente)`); continue; }
      const d = await call("aras_delete_item", { itemType: "User", id: uid, modo: "delete", conferma: true, ignoraAvvertenze: true });
      console.log(`  ${d.eliminato ? "rimosso" : "FAIL  "} ${u.login} ${d.eliminato ? "" : JSON.stringify(d).slice(0, 140)}`);
    }
    const g = await call("aras_query_items", { itemType: "Identity", filter: `name eq '${GRUPPO}'`, select: ["id"], top: 1 });
    if (g.items?.[0]?.id) {
      const d = await call("aras_delete_item", { itemType: "Identity", id: g.items[0].id, modo: "delete", conferma: true, ignoraAvvertenze: true });
      console.log(`  ${d.eliminato ? "rimosso" : "FAIL  "} gruppo ${GRUPPO}`);
    }
    process.exit(0);
  }

  console.log("=== 1. gruppo della societa' ===\n");
  const g = await call("aras_create_group", { nome: GRUPPO, descrizione: "Utenti della societa' ARAS DEMO" });
  console.log(`  ${g.creato ? "creato " : "gia' presente"} ${GRUPPO}  ${g.motivo ?? ""}`);

  console.log("\n=== 2. utenti ===\n");
  const esiti = [];
  for (const u of UTENTI) {
    const r = await call("aras_create_user", {
      login: u.login, nome: u.nome, cognome: u.cognome,
      email: `${u.login}@arasdemo.local`, azienda: AZIENDA,
      gruppi: [GRUPPO, u.reparto, u.ruolo],
    });
    const gruppi = (r.gruppiAggiunti ?? r.aggiunti ?? []).join(", ");
    const falliti = (r.gruppiFalliti ?? r.falliti ?? []);
    console.log(`  ${r.creato ? "OK  " : "--  "} ${u.login.padEnd(10)} ${(u.nome + " " + u.cognome).padEnd(18)} ${gruppi}${falliti.length ? "  [non iscritto: " + JSON.stringify(falliti) + "]" : ""}${r.creato ? "" : "  " + (r.motivo ?? "")}`);
    esiti.push({ ...u, id: r.id, creato: r.creato });
  }

  console.log("\n=== 3. password ===\n");
  const hash = md5(PASSWORD);
  for (const u of esiti) {
    if (!u.id) continue;
    const r = await call("aras_update_item", { itemType: "User", id: u.id, properties: { password: hash } });
    if (!r.aggiornato && !r.id) console.log(`  FAIL ${u.login}  ${JSON.stringify(r).slice(0, 160)}`);
  }
  const login1 = await provaLogin(UTENTI[0].login);
  console.log(`  login di prova (${UTENTI[0].login} / ${PASSWORD}): ${login1 ? "FUNZIONA" : "NON funziona — vanno impostate da Administration > Users"}`);

  console.log("\n=== 4. verifica ===\n");
  const v = await call("aras_query_items", {
    itemType: "User", filter: `company_name eq '${AZIENDA}'`,
    select: ["login_name", "first_name", "last_name", "email", "company_name"], orderby: "last_name asc", top: 50,
  });
  console.log(`  utenti con company_name = "${AZIENDA}": ${v.totaleCorrispondenti}`);
  for (const it of v.items ?? []) console.log(`    ${String(it.login_name).padEnd(10)} ${it.first_name} ${it.last_name}   ${it.email}`);

  const m = await call("aras_get_identity_members", { identityId: (await call("aras_query_items", { itemType: "Identity", filter: `name eq '${GRUPPO}'`, select: ["id"], top: 1 })).items?.[0]?.id });
  console.log(`\n  membri del gruppo "${GRUPPO}": ${m.membri ?? "?"}`);

  const acme = await call("aras_query_items", { itemType: "Part", filter: "startswith(item_number,'PMP-')", select: ["id"], top: 50 });
  console.log(`  controllo dati ACME intatti: ${acme.totaleCorrispondenti} Part PMP- (attese 8)`);
} finally { c.kill() }
