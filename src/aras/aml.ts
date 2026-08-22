import { ArasConfig, AML_URL } from "./config.js";
import { TokenManager } from "./auth.js";
import { ArasError } from "./client.js";

/**
 * Canale AML (Aras Markup Language) verso InnovatorServer.aspx.
 *
 * Serve per cio' che OData non espone: promozioni di lifecycle, invocazione di
 * metodi server, query con logica che il filtro OData non esprime. E' l'API
 * storica di Aras e resta quella completa; OData ne copre solo il CRUD.
 */
export class AmlClient {
  constructor(
    private readonly cfg: ArasConfig,
    private readonly tokens: TokenManager
  ) {}

  /** Esegue AML grezzo. `aml` e' il frammento <Item .../>, l'envelope lo aggiunge il client. */
  async apply(aml: string): Promise<AmlResult> {
    const token = await this.tokens.get();
    const envelope =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">` +
      `<SOAP-ENV:Body><ApplyItem>${aml}</ApplyItem></SOAP-ENV:Body>` +
      `</SOAP-ENV:Envelope>`;

    const res = await fetch(AML_URL(this.cfg), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/xml; charset=utf-8",
        SOAPACTION: "ApplyItem",
        DATABASE: this.cfg.database,
      },
      body: envelope,
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });

    const text = await res.text();
    if (!res.ok && !text.includes("<SOAP-ENV:Fault")) {
      throw new ArasError(`AML: HTTP ${res.status}`, res.status, text.slice(0, 600));
    }

    const fault = extract(text, "faultstring");
    if (fault) {
      // Aras restituisce i propri errori applicativi come SOAP Fault con HTTP 500,
      // quindi il codice di stato da solo non distingue "rotto" da "rifiutato".
      const detail = extract(text, "af:legacy_detail") ?? "";
      throw new ArasError(`AML rifiutato da Aras: ${fault}`, 400, detail.slice(0, 600));
    }

    return { items: parseItems(text), raw: text.length > 20000 ? text.slice(0, 20000) + "\n[...troncato]" : text };
  }

  /** Promuove un elemento a un nuovo stato del ciclo di vita. */
  async promote(itemType: string, id: string, toState: string): Promise<AmlResult> {
    return this.apply(
      `<Item type="${esc(itemType)}" id="${esc(id)}" action="promoteItem">` +
      `<state>${esc(toState)}</state></Item>`
    );
  }

  /** Stati raggiungibili da un elemento nel suo stato attuale. */
  async allowedTransitions(itemType: string, id: string): Promise<AmlResult> {
    return this.apply(`<Item type="${esc(itemType)}" id="${esc(id)}" action="getItemNextStates"/>`);
  }

  /** Invoca un metodo server per nome. */
  async callMethod(methodName: string, itemType: string, body = ""): Promise<AmlResult> {
    return this.apply(`<Item type="${esc(itemType)}" action="${esc(methodName)}">${body}</Item>`);
  }
}

export interface AmlResult {
  items: Array<Record<string, string>>;
  raw: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function extract(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return m?.[1]?.trim() ?? null;
}

/**
 * Estrae gli <Item> dalla risposta come oggetti piatti.
 * Volutamente minimale: niente dipendenza da un parser XML per una risposta di
 * cui servono solo attributi e testo dei figli diretti.
 */
function parseItems(xml: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const itemRe = /<Item\b([^>]*)>([\s\S]*?)<\/Item>|<Item\b([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const attrs = m[1] ?? m[3] ?? "";
    const inner = m[2] ?? "";
    const rec: Record<string, string> = {};
    for (const a of attrs.matchAll(/(\w[\w:-]*)\s*=\s*"([^"]*)"/g)) rec[a[1]!] = a[2]!;
    // Solo i figli diretti che non contengono altri Item annidati.
    for (const c of inner.matchAll(/<(\w[\w:-]*)>([^<]*)<\/\1>/g)) rec[c[1]!] = c[2]!.trim();
    if (Object.keys(rec).length) out.push(rec);
    if (out.length >= 200) break;
  }
  return out;
}
