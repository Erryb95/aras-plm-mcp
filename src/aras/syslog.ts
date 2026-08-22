import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ArasClient } from "./client.js";

/**
 * Log di Aras, da due sorgenti distinte:
 *  - i file su disco scritti dal server (Innovator, OAuth, Client);
 *  - l'ItemType SystemEventLog, che registra gli eventi a database.
 *
 * Entrambe possono essere vuote su un'installazione nuova: il logging su file va
 * abilitato nella configurazione del server, e SystemEventLog si popola solo se
 * sono definiti dei SystemEventHandler. Il tool lo dichiara invece di restituire
 * un elenco vuoto che sembrerebbe "nessun problema".
 */
const RADICI = [
  { nome: "Innovator", path: "Innovator\\Server\\logs" },
  { nome: "OAuth", path: "OAuthServer\\logs" },
  { nome: "Client", path: "Innovator\\Client\\logs" },
];

export async function leggiLogFile(
  radiceInstallazione: string,
  righeMax: number,
  filtro?: string
) {
  const re = filtro ? new RegExp(filtro, "i") : null;
  const sorgenti: Array<{ sorgente: string; file: string; bytes: number; modificato: string; righe: string[] }> = [];
  const vuote: string[] = [];

  for (const r of RADICI) {
    const dir = join(radiceInstallazione, r.path);
    let voci: string[];
    try {
      voci = await readdir(dir);
    } catch {
      vuote.push(`${r.nome}: cartella non accessibile (${dir})`);
      continue;
    }
    const files = voci.filter((f) => /\.(log|txt)$/i.test(f));
    if (!files.length) { vuote.push(`${r.nome}: nessun file di log in ${dir}`); continue; }

    for (const f of files.slice(0, 10)) {
      const p = join(dir, f);
      try {
        const info = await stat(p);
        // Solo la coda: un log di server puo' pesare centinaia di MB.
        const testo = await readFile(p, "utf8");
        let righe = testo.split(/\r?\n/).filter(Boolean);
        if (re) righe = righe.filter((l) => re.test(l));
        sorgenti.push({
          sorgente: r.nome,
          file: f,
          bytes: info.size,
          modificato: info.mtime.toISOString(),
          righe: righe.slice(-righeMax),
        });
      } catch (e) {
        vuote.push(`${r.nome}/${f}: ${e instanceof Error ? e.message.slice(0, 80) : "non leggibile"}`);
      }
    }
  }
  return { sorgenti, vuote };
}

/** Eventi registrati a database (SystemEventLog). */
export async function leggiSystemEventLog(client: ArasClient, limite: number) {
  try {
    const page = await client.query<Record<string, unknown>>("SystemEventLog", {
      orderby: "created_on desc",
      top: limite,
      count: true,
    });
    return { disponibile: true, totale: page.count ?? page.value.length, eventi: page.value };
  } catch (e) {
    return { disponibile: false, motivo: e instanceof Error ? e.message.slice(0, 200) : "non interrogabile", eventi: [] };
  }
}
