import { ArasClient } from "./client.js";

/**
 * Proprieta' che Aras valorizza da solo alla creazione (identita', audit, permessi).
 * Risultano is_required=1 nei metadati, ma chiederle a chi crea un elemento sarebbe
 * sbagliato: e' il server a doverle riempire.
 */
export const SYSTEM_MANAGED = new Set([
  "id",
  "config_id",
  "created_by_id",
  "created_on",
  "modified_by_id",
  "modified_on",
  "permission_id",
  "generation",
  "is_current",
  "is_released",
  "major_rev",
  "state",
  "current_state",
  "keyed_name",
]);

/** Distanza di Levenshtein, per suggerire l'ItemType giusto in caso di refuso. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export interface ItemTypeInfo {
  id: string;
  name: string;
  label: string | null;
  isRelationship: boolean;
  isVersionable: boolean;
}

export interface PropertyInfo {
  name: string;
  label: string | null;
  dataType: string;
  required: boolean;
  /** Per data_type "item": ItemType puntato. Per "list": id della lista di valori. */
  dataSource: string | null;
}

export interface RelationshipInfo {
  name: string;
  label: string | null;
  /** ItemType all'altro capo della relazione (es. Part BOM -> Part). */
  relatedItemType: string | null;
}

/**
 * Cache dello schema Aras.
 *
 * Motivo per cui esiste: l'istanza espone ~484 ItemType e OData non pubblica un
 * service document (risponde 501), quindi non c'e' modo di scoprire nomi e
 * proprieta' se non interrogando le tabelle di metadati ItemType/Property.
 * Senza questo, un modello puo' solo tirare a indovinare i nomi.
 * I metadati cambiano solo quando un amministratore modifica il data model,
 * quindi una cache per processo e' sicura.
 */
export class SchemaCache {
  private itemTypes: Map<string, ItemTypeInfo> | null = null;
  private props = new Map<string, PropertyInfo[]>();
  private rels = new Map<string, RelationshipInfo[]>();

  constructor(private readonly client: ArasClient) {}

  async allItemTypes(): Promise<ItemTypeInfo[]> {
    return [...(await this.loadItemTypes()).values()];
  }

  async findItemType(name: string): Promise<ItemTypeInfo | undefined> {
    const map = await this.loadItemTypes();
    return map.get(name.toLowerCase());
  }

  /**
   * Ricerca tollerante: serve sia quando il modello prova "BOM" invece di "Part BOM",
   * sia quando sbaglia a digitare ("Prt" -> "Part"). La sola sottostringa non basta
   * per i refusi, quindi si ricade sulla distanza di edit.
   */
  async searchItemTypes(term: string, limit = 40): Promise<ItemTypeInfo[]> {
    const t = term.toLowerCase().trim();
    if (!t) return [];
    const all = await this.allItemTypes();
    const scored = all
      .map((it) => {
        const n = it.name.toLowerCase();
        const l = (it.label ?? "").toLowerCase();
        let score = -1;
        if (n === t) score = 100;
        else if (n.startsWith(t)) score = 80;
        else if (n.includes(t)) score = 60;
        else if (l.includes(t)) score = 40;
        else {
          // Tolleranza ai refusi, proporzionale alla lunghezza del termine.
          const budget = t.length <= 4 ? 1 : t.length <= 8 ? 2 : 3;
          const best = Math.min(editDistance(t, n), ...n.split(" ").map((w) => editDistance(t, w)));
          if (best <= budget) score = 30 - best;
        }
        return { it, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.it.name.localeCompare(b.it.name));
    return scored.slice(0, limit).map((x) => x.it);
  }

  async propertiesOf(itemTypeName: string): Promise<PropertyInfo[]> {
    const key = itemTypeName.toLowerCase();
    const cached = this.props.get(key);
    if (cached) return cached;

    const it = await this.findItemType(itemTypeName);
    if (!it) throw new Error(`ItemType "${itemTypeName}" inesistente.`);

    const page = await this.client.query<{
      name: string;
      label: string | null;
      data_type: string;
      is_required: string | number | null;
      data_source: string | null;
    }>("Property", {
      filter: `source_id eq '${it.id}'`,
      select: ["name", "label", "data_type", "is_required", "data_source"],
      orderby: "name",
      top: 500,
    });

    const list: PropertyInfo[] = page.value.map((p) => ({
      name: p.name,
      label: p.label,
      dataType: p.data_type,
      required: String(p.is_required) === "1",
      dataSource: p.data_source,
    }));
    this.props.set(key, list);
    return list;
  }

  /**
   * Relazioni che partono da un ItemType.
   * In Aras una relazione e' essa stessa un ItemType con is_relationship=1 e
   * source_id che punta al tipo di partenza; il tipo di destinazione sta in related_id.
   */
  async relationshipsOf(itemTypeName: string): Promise<RelationshipInfo[]> {
    const key = itemTypeName.toLowerCase();
    const cached = this.rels.get(key);
    if (cached) return cached;

    const it = await this.findItemType(itemTypeName);
    if (!it) throw new Error(`ItemType "${itemTypeName}" inesistente.`);

    // Niente $select: Aras espone il tipo di destinazione come annotazione OData
    // "related_id@aras.name" (es. "Part", "Manufacturer Part"), che con un $select
    // esplicito non viene restituita. L'annotazione evita di risolvere l'id a mano.
    const page = await this.client.query<Record<string, unknown>>("RelationshipType", {
      filter: `source_id eq '${it.id}'`,
      top: 200,
    });

    const byId = new Map([...(await this.loadItemTypes()).values()].map((x) => [x.id, x.name]));
    const list: RelationshipInfo[] = page.value.map((r) => {
      const annotated = r["related_id@aras.name"];
      const rawId = r["related_id"];
      const related =
        typeof annotated === "string" && annotated
          ? annotated
          : typeof rawId === "string"
            ? (byId.get(rawId) ?? null)
            : null;
      return {
        name: String(r["name"] ?? ""),
        label: (r["label"] as string | null) ?? null,
        relatedItemType: related,
      };
    });
    this.rels.set(key, list);
    return list;
  }

  /** Confronta le proprieta' proposte con lo schema reale, prima di scrivere. */
  async validateProperties(
    itemTypeName: string,
    values: Record<string, unknown>
  ): Promise<{ ok: boolean; unknown: string[]; missingRequired: string[] }> {
    const props = await this.propertiesOf(itemTypeName);
    const known = new Set(props.map((p) => p.name));
    const unknownProps = Object.keys(values).filter((k) => !known.has(k));
    const missingRequired = props
      .filter((p) => p.required && !(p.name in values))
      .map((p) => p.name)
      .filter((n) => !SYSTEM_MANAGED.has(n));
    return { ok: unknownProps.length === 0 && missingRequired.length === 0, unknown: unknownProps, missingRequired };
  }

  private async loadItemTypes(): Promise<Map<string, ItemTypeInfo>> {
    if (this.itemTypes) return this.itemTypes;
    const page = await this.client.query<{
      id: string;
      name: string;
      label: string | null;
      is_relationship: string | number | null;
      is_versionable: string | number | null;
    }>("ItemType", {
      select: ["id", "name", "label", "is_relationship", "is_versionable"],
      orderby: "name",
      top: 2000,
    });

    const map = new Map<string, ItemTypeInfo>();
    for (const t of page.value) {
      map.set(t.name.toLowerCase(), {
        id: t.id,
        name: t.name,
        label: t.label,
        isRelationship: String(t.is_relationship) === "1",
        isVersionable: String(t.is_versionable) === "1",
      });
    }
    this.itemTypes = map;
    return map;
  }
}
