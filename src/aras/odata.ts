/**
 * Lettura dei riferimenti fra elementi nell'OData di Aras.
 *
 * Aras NON restituisce le proprieta' di tipo "item" come valore semplice: le espone
 * come annotazioni affiancate. Per una riga di Part BOM si ottiene
 *
 *   "related_id@aras.id":         "656929986C..."     <- il GUID
 *   "related_id@aras.keyed_name": "P-1100"            <- l'etichetta leggibile
 *
 * e nessuna chiave "related_id". Peggio: quali annotazioni arrivano dipende da $select.
 *   - CON $select=related_id  -> arrivano @aras.id e @aras.keyed_name
 *   - SENZA $select           -> non arrivano affatto (su Part BOM)
 *   - su RelationshipType     -> arriva @aras.name anche senza $select
 *
 * Leggere direttamente row.related_id restituisce undefined e fa fallire in silenzio
 * qualunque navigazione: e' esattamente cosi' che l'esplosione della distinta
 * tornava un albero vuoto pur essendoci le righe. Tutto passa da qui.
 */
export interface ItemRef {
  id: string;
  keyedName: string | null;
}

export function readItemRef(row: Record<string, unknown>, prop: string): ItemRef | null {
  const id =
    str(row[`${prop}@aras.id`]) ??
    // Alcuni endpoint restituiscono comunque il valore semplice o un oggetto espanso.
    str(row[prop]) ??
    str((row[prop] as { id?: unknown } | undefined)?.id);

  if (!id) return null;

  const keyedName =
    str(row[`${prop}@aras.keyed_name`]) ?? str(row[`${prop}@aras.name`]) ?? null;

  return { id, keyedName };
}

/** Nome leggibile di un riferimento, quando non serve l'id. */
export function readRefName(row: Record<string, unknown>, prop: string): string | null {
  return (
    str(row[`${prop}@aras.name`]) ??
    str(row[`${prop}@aras.keyed_name`]) ??
    null
  );
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
