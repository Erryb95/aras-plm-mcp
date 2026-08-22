import { ArasClient } from "./client.js";
import { AmlClient } from "./aml.js";

/**
 * Valori ammessi dalle proprieta' di tipo `list`.
 *
 * Due insidie sovrapposte, entrambe silenziose:
 *  1. su Property, `data_source` (l'id della List) e' un riferimento, quindi OData lo
 *     espone SOLO come annotazione `data_source@aras.id`: leggerlo come campo semplice
 *     restituisce undefined e fa concludere che non esistano liste;
 *  2. i valori stanno nell'ItemType `Value` legato alla `List`, ma il filtro OData su
 *     `source_id` di Value e' un riferimento polimorfo e risponde 400. Vanno letti via
 *     AML con le Relationships annidate.
 *
 * Senza questo, scrivere un valore non ammesso passa la validazione dello schema
 * (il nome della proprieta' esiste) e viene rifiutato o silenziosamente ignorato da Aras.
 */
export class ListCache {
  private cache = new Map<string, Record<string, string[]>>();

  constructor(private readonly client: ArasClient, private readonly aml: AmlClient) {}

  async valuesFor(itemType: string): Promise<Record<string, string[]>> {
    const key = itemType.toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return hit;

    const t = await this.client.query<Record<string, unknown>>("ItemType", {
      filter: `name eq '${itemType.replace(/'/g, "''")}'`, select: ["id"], top: 1,
    });
    const typeId = t.value[0]?.["id"] as string | undefined;
    if (!typeId) throw new Error(`ItemType "${itemType}" inesistente.`);

    const props = await this.client.query<Record<string, unknown>>("Property", {
      filter: `source_id eq '${typeId}'`, select: ["name", "data_type", "data_source"], top: 400,
    });

    const out: Record<string, string[]> = {};
    for (const p of props.value) {
      if (p["data_type"] !== "list") continue;
      const listId = (p["data_source@aras.id"] as string) ?? (p["data_source"] as string);
      if (!listId) continue;
      const xml = (await this.aml.apply(
        `<Item type="List" action="get" id="${listId}" select="name">` +
        `<Relationships><Item type="Value" action="get" select="value,label"/></Relationships></Item>`
      )).raw;
      const valori = [...xml.matchAll(/<Item[^>]*type="Value"[^>]*>[\s\S]*?<value>([^<]*)<\/value>/g)]
        .map((m) => m[1]!);
      if (valori.length) out[String(p["name"])] = valori;
    }

    this.cache.set(key, out);
    return out;
  }

  /** Controlla i valori proposti contro le liste, restituendo scarti comprensibili. */
  async validate(itemType: string, values: Record<string, unknown>) {
    const liste = await this.valuesFor(itemType).catch(() => ({} as Record<string, string[]>));
    const errori: Array<{ proprieta: string; valore: string; ammessi: string[] }> = [];
    for (const [k, v] of Object.entries(values)) {
      const ammessi = liste[k];
      if (!ammessi || v == null || v === "") continue;
      if (!ammessi.includes(String(v))) {
        errori.push({ proprieta: k, valore: String(v), ammessi });
      }
    }
    return { ok: errori.length === 0, errori, liste };
  }
}
