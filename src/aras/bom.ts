import { ArasClient } from "./client.js";
import { readItemRef } from "./odata.js";

export interface BomNode {
  id: string;
  itemNumber: string;
  name: string | null;
  /** Quantita' su questa riga di distinta (rispetto al padre diretto). */
  qty: number;
  /** Quantita' totale rispetto alla radice: prodotto delle qty lungo il percorso. */
  cumulativeQty: number;
  children: BomNode[];
  /** Valorizzato se il ramo e' stato troncato invece che esploso del tutto. */
  truncated?: "profondita-massima" | "ciclo";
}

interface PartRow {
  id: string;
  item_number: string;
  name: string | null;
}

/**
 * Esplode ricorsivamente la distinta base di una Part.
 *
 * Due protezioni che una semplice ricorsione non avrebbe:
 *  - limite di profondita', perche' una BOM industriale puo' essere profonda decine di livelli;
 *  - rilevamento dei cicli lungo il percorso corrente, perche' un data model mal configurato
 *    puo' contenere una Part che si riferisce indirettamente a se stessa e la ricorsione
 *    non terminerebbe mai.
 */
export async function explodeBom(
  client: ArasClient,
  rootId: string,
  maxDepth: number
): Promise<BomNode> {
  const root = await client.getById<PartRow>("Part", rootId, ["id", "item_number", "name"]);
  const node: BomNode = {
    id: root.id,
    itemNumber: root.item_number,
    name: root.name,
    qty: 1,
    cumulativeQty: 1,
    children: [],
  };
  await expand(client, node, maxDepth, new Set([root.id]));
  return node;
}

async function expand(
  client: ArasClient,
  node: BomNode,
  remaining: number,
  ancestors: Set<string>
): Promise<void> {
  if (remaining <= 0) {
    node.truncated = "profondita-massima";
    return;
  }

  // $select e' necessario: senza, Aras non emette le annotazioni related_id@aras.*
  // e la riga arriva priva di qualunque riferimento al componente.
  const page = await client.query<Record<string, unknown>>("Part BOM", {
    filter: `source_id eq '${node.id}'`,
    select: ["related_id", "quantity"],
    top: 500,
  });

  for (const row of page.value) {
    const ref = readItemRef(row, "related_id");
    if (!ref) continue;
    const childId = ref.id;

    const qty = Number(row["quantity"] ?? 1) || 1;

    if (ancestors.has(childId)) {
      node.children.push({
        id: childId,
        itemNumber: "(ciclo)",
        name: null,
        qty,
        cumulativeQty: node.cumulativeQty * qty,
        children: [],
        truncated: "ciclo",
      });
      continue;
    }

    let part: PartRow;
    try {
      part = await client.getById<PartRow>("Part", childId, ["id", "item_number", "name"]);
    } catch {
      // Un componente puo' essere non leggibile per permessi: lo segnaliamo senza far
      // fallire l'intera esplosione. L'annotazione keyed_name resta comunque utile.
      node.children.push({
        id: childId,
        itemNumber: ref.keyedName ?? "(non accessibile)",
        name: null,
        qty,
        cumulativeQty: node.cumulativeQty * qty,
        children: [],
      });
      continue;
    }

    const child: BomNode = {
      id: part.id,
      itemNumber: part.item_number,
      name: part.name,
      qty,
      cumulativeQty: node.cumulativeQty * qty,
      children: [],
    };
    node.children.push(child);

    // Il set di antenati e' per-ramo: la stessa Part puo' comparire legittimamente
    // in rami diversi della distinta, ma non due volte lungo lo stesso percorso.
    await expand(client, child, remaining - 1, new Set([...ancestors, part.id]));
  }
}
