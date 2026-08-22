import { inflateSync, inflateRawSync, unzipSync } from "node:zlib";
import { ArasClient } from "./client.js";

/**
 * Lettura del contenuto dei file dal vault.
 *
 * Due vie funzionano entrambe, verificate: la media resource OData
 * (`File('<id>')/$value`) e l'endpoint del vault
 * (`/vault/vaultserver.aspx?dbName=..&fileId=..`). Si usa OData perche' passa
 * dallo stesso client e dallo stesso token del resto del server; il vault
 * resta come ripiego, perche' su installazioni con vault remoto e' l'unica
 * che risponde.
 */

export type ContenutoFile = {
  id: string;
  filename: string | null;
  mimetype: string | null;
  bytes: number;
  via: "odata" | "vault";
  genere: "testo" | "pdf" | "immagine" | "binario";
  testo?: string;
  troncato?: boolean;
  base64?: string;
  nota?: string;
};

const TESTUALI = /^(text\/|application\/(json|xml|xhtml|javascript|x-yaml|sql)|image\/svg)/i;
const IMMAGINI = /^image\/(png|jpeg|jpg|gif|webp)$/i;

export async function scaricaFile(
  client: ArasClient,
  baseUrl: string,
  database: string,
  fileId: string
): Promise<{ buf: Buffer; via: "odata" | "vault"; contentType: string | null }> {
  const tk = await client.tokens.get();
  const auth = { Authorization: `Bearer ${tk}` };

  const tentativi: Array<{ via: "odata" | "vault"; url: string }> = [
    { via: "odata", url: `${baseUrl}/Server/OData/File('${fileId}')/$value` },
    { via: "vault", url: `${baseUrl}/vault/vaultserver.aspx?dbName=${encodeURIComponent(database)}&fileId=${fileId}` },
  ];

  let ultimo = "";
  for (const t of tentativi) {
    try {
      const r = await fetch(t.url, { headers: { ...auth, DATABASE: database } });
      if (!r.ok) { ultimo = `${t.via}: HTTP ${r.status}`; continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) { ultimo = `${t.via}: risposta vuota`; continue; }
      return { buf, via: t.via, contentType: r.headers.get("content-type") };
    } catch (e) {
      ultimo = `${t.via}: ${e instanceof Error ? e.message : "errore"}`;
    }
  }
  throw new Error(`Nessuna via di download ha risposto. Ultimo esito — ${ultimo}`);
}

/**
 * Estrae il testo da un PDF senza dipendenze esterne: scompatta i flussi
 * FlateDecode con zlib e legge gli operatori Tj e TJ.
 *
 * Copre i PDF con testo estraibile. NON copre un disegno scansionato, che e'
 * un'immagine dentro un PDF e richiederebbe OCR: in quel caso restituisce
 * stringa vuota, e chi chiama deve dirlo invece di far finta.
 */
export function testoDaPdf(buf: Buffer): string {
  const pezzi: string[] = [];
  const bin = buf.toString("latin1");

  for (const m of bin.matchAll(/stream\r?\n?/g)) {
    const inizio = m.index! + m[0].length;
    const fine = bin.indexOf("endstream", inizio);
    if (fine < 0) continue;

    const intestazione = bin.slice(Math.max(0, m.index! - 400), m.index!);
    const grezzo = buf.subarray(inizio, fine);

    let dati: Buffer | null = null;
    if (/\/FlateDecode/.test(intestazione)) {
      for (const f of [inflateSync, inflateRawSync, unzipSync]) {
        try { dati = f(grezzo); break; } catch { /* prova la successiva */ }
      }
      if (!dati) continue;
    } else if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|RunLengthDecode|ASCII85Decode|LZWDecode)/.test(intestazione)) {
      continue; // immagini o codifiche che non trattiamo
    } else {
      dati = grezzo;
    }

    pezzi.push(operatoriTesto(dati.toString("latin1")));
  }

  return pezzi.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Legge gli operatori di testo di un content stream PDF. */
function operatoriTesto(s: string): string {
  const out: string[] = [];
  let riga = "";

  for (const m of s.matchAll(/\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bT[Jj]\b|\bT[dD*]\b|\bTm\b|\bET\b/g)) {
    const t = m[0];
    if (t.startsWith("(")) {
      riga += letterale(t.slice(1, -1));
    } else if (t.startsWith("<")) {
      const hex = t.slice(1, -1).replace(/\s+/g, "");
      for (let i = 0; i + 1 < hex.length; i += 2) riga += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    } else if (/^T[dD*]$|^Tm$|^ET$/.test(t)) {
      if (riga.trim()) out.push(riga.trim());
      riga = "";
    }
  }
  if (riga.trim()) out.push(riga.trim());
  return out.join("\n");
}

/** Scioglie gli escape di una stringa letterale PDF. */
function letterale(s: string): string {
  return s.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_, c: string) => {
    switch (c) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      case "(": return "(";
      case ")": return ")";
      case "\\": return "\\";
      default: return String.fromCharCode(parseInt(c, 8));
    }
  });
}

/** Classifica e converte il contenuto in qualcosa che un modello possa leggere. */
export function interpreta(
  buf: Buffer,
  mimetype: string | null,
  filename: string | null,
  maxCaratteri: number
): Pick<ContenutoFile, "genere" | "testo" | "troncato" | "base64" | "nota"> {
  const est = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  const mime = (mimetype ?? "").toLowerCase();
  const pdf = mime === "application/pdf" || est === "pdf" || buf.subarray(0, 5).toString("latin1") === "%PDF-";

  if (pdf) {
    const t = testoDaPdf(buf);
    if (!t) {
      return {
        genere: "pdf",
        nota: "PDF senza testo estraibile: probabilmente una scansione o un disegno vettoriale " +
          "senza operatori di testo. Servirebbe un OCR, che questo server non fa.",
      };
    }
    return { genere: "pdf", testo: tronca(t, maxCaratteri).testo, troncato: tronca(t, maxCaratteri).troncato };
  }

  if (TESTUALI.test(mime) || ["txt", "csv", "xml", "json", "md", "svg", "log", "yaml", "yml"].includes(est)) {
    const t = buf.toString("utf8");
    const r = tronca(t, maxCaratteri);
    return { genere: "testo", testo: r.testo, troncato: r.troncato };
  }

  if (IMMAGINI.test(mime) || ["png", "jpg", "jpeg", "gif", "webp"].includes(est)) {
    return { genere: "immagine", base64: buf.toString("base64") };
  }

  return {
    genere: "binario",
    nota: `Formato non testuale (${mimetype ?? est ?? "sconosciuto"}). ` +
      "Restituiti solo i metadati: per i formati CAD nativi serve un convertitore.",
  };
}

function tronca(s: string, max: number) {
  if (s.length <= max) return { testo: s, troncato: false };
  return { testo: s.slice(0, max), troncato: true };
}
