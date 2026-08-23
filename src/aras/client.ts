import { ArasConfig, ODATA } from "./config.js";
import { TokenManager } from "./auth.js";

export class ArasError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string
  ) {
    super(message);
    this.name = "ArasError";
  }
}

export interface ODataPage<T> {
  value: T[];
  count?: number;
  nextLink?: string;
}

export interface QueryOptions {
  select?: string[];
  filter?: string;
  orderby?: string;
  top?: number;
  skip?: number;
  expand?: string;
  count?: boolean;
}

export class ArasClient {
  /** Condiviso con AmlClient: un solo token per processo, un solo rinnovo. */
  readonly tokens: TokenManager;

  constructor(readonly cfg: ArasConfig) {
    this.tokens = new TokenManager(cfg);
  }

  /** Le scritture sono bloccate in sola lettura: serve anche ad AmlClient. */
  get isReadOnly(): boolean {
    return this.cfg.readOnly;
  }

  /** Verifica credenziali ed endpoint senza modificare nulla. */
  async ping(): Promise<{ database: string; user: string; itemTypes: number }> {
    const page = await this.query<{ id: string }>("ItemType", { top: 1, count: true, select: ["id"] });
    return {
      database: this.cfg.database,
      user: this.cfg.username,
      itemTypes: page.count ?? 0,
    };
  }

  async query<T>(itemType: string, opts: QueryOptions = {}): Promise<ODataPage<T>> {
    const qs = new URLSearchParams();
    if (opts.select?.length) qs.set("$select", opts.select.join(","));
    if (opts.filter) qs.set("$filter", opts.filter);
    if (opts.orderby) qs.set("$orderby", opts.orderby);
    if (opts.top !== undefined) qs.set("$top", String(opts.top));
    if (opts.skip !== undefined) qs.set("$skip", String(opts.skip));
    if (opts.expand) qs.set("$expand", opts.expand);
    if (opts.count) qs.set("$count", "true");

    const url = `${ODATA(this.cfg)}/${encodeURIComponent(itemType)}${qs.size ? `?${qs}` : ""}`;
    const json = await this.request<Record<string, unknown>>("GET", url);
    return {
      value: (json["value"] as T[]) ?? [],
      count: json["@odata.count"] as number | undefined,
      nextLink: json["@odata.nextLink"] as string | undefined,
    };
  }

  /**
   * Come query(), ma segue @odata.nextLink fino a esaurire i risultati.
   * Aras impagina lato server a prescindere da $top, quindi senza questo una
   * "query completa" restituisce silenziosamente solo la prima pagina.
   */
  async queryAll<T>(itemType: string, opts: QueryOptions = {}, maxItems = 5000): Promise<ODataPage<T>> {
    const first = await this.query<T>(itemType, { ...opts, count: true });
    const all = [...first.value];
    let next = first.nextLink;
    let guard = 0;

    while (next && all.length < maxItems && guard++ < 200) {
      // nextLink puo' essere assoluto o relativo al service root.
      const url = next.startsWith("http") ? next : `${ODATA(this.cfg)}/${next.replace(/^\/+/, "")}`;
      const json = await this.request<Record<string, unknown>>("GET", url);
      const batch = (json["value"] as T[]) ?? [];
      if (!batch.length) break;
      all.push(...batch);
      next = json["@odata.nextLink"] as string | undefined;
    }

    return { value: all.slice(0, maxItems), count: first.count, nextLink: next };
  }

  async getById<T>(itemType: string, id: string, select?: string[]): Promise<T> {
    const qs = select?.length ? `?$select=${select.join(",")}` : "";
    const url = `${ODATA(this.cfg)}/${encodeURIComponent(itemType)}('${id}')${qs}`;
    return this.request<T>("GET", url);
  }

  async create<T>(itemType: string, body: Record<string, unknown>): Promise<T> {
    this.assertWritable("create");
    return this.request<T>("POST", `${ODATA(this.cfg)}/${encodeURIComponent(itemType)}`, body);
  }

  async update<T>(itemType: string, id: string, body: Record<string, unknown>): Promise<T> {
    this.assertWritable("update");
    return this.request<T>("PATCH", `${ODATA(this.cfg)}/${encodeURIComponent(itemType)}('${id}')`, body);
  }

  /**
   * Rilegge un elemento e dice quali proprieta' richieste NON sono arrivate.
   *
   * Aras puo' accettare una scrittura, rispondere 200, aggiornare modified_on e
   * scartare in silenzio una proprieta' che non e' dichiarata nell'ItemType: e'
   * successo a x/y su Workflow Map Activity. Senza rileggere non c'e' modo di
   * accorgersene, e il chiamante crede di aver scritto qualcosa che non c'e'.
   */
  async proprietaNonApplicate(
    itemType: string,
    id: string,
    richieste: Record<string, unknown>
  ): Promise<string[]> {
    const nomi = Object.keys(richieste).filter((k) => !SISTEMA.has(k));
    if (!nomi.length) return [];

    let letto: Record<string, unknown>;
    try {
      letto = await this.getById<Record<string, unknown>>(itemType, id, ["id", ...nomi]);
    } catch {
      return []; // non poter verificare non e' una prova di fallimento
    }

    return nomi.filter((k) => {
      const atteso = richieste[k];
      if (atteso === null || atteso === undefined) return false;
      // I riferimenti a elemento tornano come annotazione, non come valore.
      const effettivo = letto[k] ?? letto[`${k}@aras.id`];
      if (effettivo === undefined) return true;
      return normalizzaValore(effettivo) !== normalizzaValore(atteso);
    });
  }

  private assertWritable(op: string): void {
    if (this.cfg.readOnly) {
      throw new ArasError(
        `Operazione "${op}" bloccata: il server e' in sola lettura. ` +
          `Imposta ARAS_READONLY=false per abilitare le scritture su ${this.cfg.database}.`,
        403
      );
    }
  }

  private async request<T>(method: string, url: string, body?: unknown, retry = true): Promise<T> {
    const token = await this.tokens.get();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });

    // Il token puo' essere revocato lato server prima della scadenza nominale.
    if (res.status === 401 && retry) {
      this.tokens.invalidate();
      return this.request<T>(method, url, body, false);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ArasError(this.explain(res.status, url, detail), res.status, detail.slice(0, 800));
    }

    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }

  /** Traduce gli status HTTP di Aras in messaggi che dicono cosa fare, non solo cosa e' rotto. */
  private explain(status: number, url: string, detail: string): string {
    const itemType = decodeURIComponent(url.split("/OData/")[1]?.split(/[?('/]/)[0] ?? "?");
    switch (status) {
      case 404:
        return `ItemType "${itemType}" inesistente o elemento non trovato. Usa aras_list_item_types per i nomi validi.`;
      case 400:
        return `Query rifiutata su "${itemType}". Verifica i nomi delle proprieta' con aras_describe_item_type. ${detail.slice(0, 300)}`;
      case 403:
        return `Permessi insufficienti su "${itemType}" per l'utente ${this.cfg.username}.`;
      case 500:
        // Aras restituisce i dinieghi di permesso come 500, non come 403.
        if (/PermissionsNoCanAdd/i.test(detail)) {
          return `Creazione negata su "${itemType}": l'utente ${this.cfg.username} non appartiene a ` +
            `un'identita' con permesso di Add. Usa aras_get_type_permissions per scoprire quale serve, ` +
            `poi aras_manage_membership per concederla.`;
        }
        if (/PermissionsNoCan(Update|Delete|Get)/i.test(detail)) {
          const op = /NoCan(\w+)/i.exec(detail)?.[1] ?? "questa operazione";
          return `Operazione "${op}" negata su "${itemType}" per ${this.cfg.username}: manca l'identita' ` +
            `con quel permesso. Verifica con aras_get_type_permissions.`;
        }
        return `Errore interno di Aras su "${itemType}". ${detail.slice(0, 300)}`;
      default:
        return `Aras ha risposto HTTP ${status} su "${itemType}". ${detail.slice(0, 300)}`;
    }
  }
}


/** Proprieta' che Aras gestisce da se': confrontarle non ha senso. */
const SISTEMA = new Set([
  "id", "config_id", "created_by_id", "created_on", "modified_by_id", "modified_on",
  "generation", "is_current", "is_released", "keyed_name", "major_rev", "minor_rev",
  "new_version", "state", "current_state", "permission_id", "locked_by_id",
]);

/**
 * Confronto tollerante: Aras restituisce i booleani come "1"/"0", i numeri come
 * stringhe, e normalizza gli spazi. Un confronto stretto darebbe falsi allarmi.
 */
function normalizzaValore(v: unknown): string {
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  const s = String(v).trim();
  if (s === "true") return "1";
  if (s === "false") return "0";
  const n = Number(s);
  return Number.isFinite(n) && s !== "" ? String(n) : s;
}
