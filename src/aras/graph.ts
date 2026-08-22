import { ArasClient } from "./client.js";
import { readItemRef } from "./odata.js";

/**
 * Navigazioni di dominio: le domande che si fanno davvero a un PLM e che una
 * query OData generica non risponde in un colpo solo.
 */

export interface WhereUsedNode {
  id: string;
  itemNumber: string;
  name: string | null;
  /** Quantita' con cui il componente entra in questo assieme. */
  qty: number;
  livello: number;
  parents: WhereUsedNode[];
  truncated?: "profondita-massima" | "ciclo";
}

/**
 * Where-used: risale la distinta per trovare tutti gli assiemi che usano un componente.
 *
 * E' la domanda inversa della BOM e la piu' importante prima di modificare un pezzo:
 * "se cambio questa vite, cosa impatto?". Aras non la offre come endpoint: si ottiene
 * filtrando Part BOM su related_id invece che su source_id.
 */
export async function whereUsed(
  client: ArasClient,
  partId: string,
  maxDepth: number
): Promise<WhereUsedNode> {
  const part = await client.getById<{ id: string; item_number: string; name: string | null }>(
    "Part", partId, ["id", "item_number", "name"]
  );
  const root: WhereUsedNode = {
    id: part.id, itemNumber: part.item_number, name: part.name,
    qty: 1, livello: 0, parents: [],
  };
  await climb(client, root, maxDepth, new Set([part.id]));
  return root;
}

async function climb(
  client: ArasClient,
  node: WhereUsedNode,
  remaining: number,
  descendants: Set<string>
): Promise<void> {
  if (remaining <= 0) { node.truncated = "profondita-massima"; return; }

  // $select obbligatorio: senza, Aras non emette le annotazioni source_id@aras.*
  const page = await client.query<Record<string, unknown>>("Part BOM", {
    filter: `related_id eq '${node.id}'`,
    select: ["source_id", "quantity"],
    top: 500,
  });

  for (const row of page.value) {
    const ref = readItemRef(row, "source_id");
    if (!ref) continue;
    const qty = Number(row["quantity"] ?? 1) || 1;

    if (descendants.has(ref.id)) {
      node.parents.push({
        id: ref.id, itemNumber: ref.keyedName ?? "(ciclo)", name: null,
        qty, livello: node.livello + 1, parents: [], truncated: "ciclo",
      });
      continue;
    }

    let parent: { id: string; item_number: string; name: string | null };
    try {
      parent = await client.getById("Part", ref.id, ["id", "item_number", "name"]);
    } catch {
      node.parents.push({
        id: ref.id, itemNumber: ref.keyedName ?? "(non accessibile)", name: null,
        qty, livello: node.livello + 1, parents: [],
      });
      continue;
    }

    const p: WhereUsedNode = {
      id: parent.id, itemNumber: parent.item_number, name: parent.name,
      qty, livello: node.livello + 1, parents: [],
    };
    node.parents.push(p);
    await climb(client, p, remaining - 1, new Set([...descendants, parent.id]));
  }
}

/** Righe di una relazione, con id e nome leggibile del capo opposto gia' risolti. */
export async function relatedItems(
  client: ArasClient,
  relationshipType: string,
  sourceId: string,
  extraSelect: string[] = []
): Promise<Array<{ id: string; keyedName: string | null; row: Record<string, unknown> }>> {
  const page = await client.query<Record<string, unknown>>(relationshipType, {
    filter: `source_id eq '${sourceId}'`,
    select: ["related_id", ...extraSelect],
    top: 500,
  });
  const out = [];
  for (const row of page.value) {
    const ref = readItemRef(row, "related_id");
    if (ref) out.push({ id: ref.id, keyedName: ref.keyedName, row });
  }
  return out;
}

/**
 * Tutta la documentazione di una Part: Document e CAD in una sola chiamata.
 * Sono due relazioni distinte in Aras (Part Document, Part CAD) ma per chi chiede
 * "che documenti ha questo pezzo" sono la stessa domanda.
 */
export async function documentsOf(client: ArasClient, partId: string) {
  const [docs, cads] = await Promise.all([
    relatedItems(client, "Part Document", partId),
    relatedItems(client, "Part CAD", partId),
  ]);

  const hydrate = async (type: string, items: Array<{ id: string; keyedName: string | null }>) =>
    Promise.all(items.map(async (i) => {
      try {
        const d = await client.getById<Record<string, unknown>>(type, i.id,
          ["id", "item_number", "name", "description", "state"]);
        return { tipo: type, id: i.id, item_number: d["item_number"], name: d["name"],
                 description: d["description"], state: d["state"] };
      } catch {
        return { tipo: type, id: i.id, item_number: i.keyedName, name: null,
                 description: null, state: null, nota: "non accessibile" };
      }
    }));

  const [documenti, modelli] = await Promise.all([
    hydrate("Document", docs),
    hydrate("CAD", cads),
  ]);
  return { documenti, modelliCad: modelli };
}

/**
 * Mappa Manufacturer Part -> nome del costruttore.
 *
 * Perche' non si filtra lato server: su "Manufacturer Manf Part" il filtro
 * `related_id eq '<id>'` restituisce SEMPRE zero righe, anche quando la riga esiste
 * ed espone related_id@aras.id con quello stesso valore. Il riferimento e' di tipo
 * polimorfo (nei metadati il tipo di destinazione risulta non risolto), e su questi
 * Aras non applica il filtro OData. Su Part BOM, dove related_id e' tipizzato a Part,
 * lo stesso filtro funziona: la differenza non e' documentata e non e' deducibile.
 * Si legge quindi l'elenco una volta sola e si indicizza in memoria.
 */
async function manufacturerIndex(client: ArasClient): Promise<Map<string, string>> {
  const page = await client.query<Record<string, unknown>>("Manufacturer Manf Part", {
    select: ["source_id", "related_id"],
    top: 500,
  });
  const map = new Map<string, string>();
  for (const row of page.value) {
    const mp = readItemRef(row, "related_id");
    const manuf = readItemRef(row, "source_id");
    if (mp && manuf?.keyedName) map.set(mp.id, manuf.keyedName);
  }
  return map;
}

/** Costruttori approvati (AML) per una Part, con il produttore risolto. */
export async function amlOf(client: ArasClient, partId: string) {
  const [rows, index] = await Promise.all([
    relatedItems(client, "Part AML", partId),
    manufacturerIndex(client),
  ]);

  return Promise.all(rows.map(async (r) => {
    try {
      const mp = await client.getById<Record<string, unknown>>("Manufacturer Part", r.id,
        ["id", "item_number", "name"]);
      return {
        manufacturerPart: mp["item_number"],
        descrizione: mp["name"],
        costruttore: index.get(r.id) ?? null,
        id: r.id,
      };
    } catch {
      return { manufacturerPart: r.keyedName, descrizione: null, costruttore: index.get(r.id) ?? null, id: r.id };
    }
  }));
}

/**
 * Impatto di una modifica: gli elementi realmente toccati da una ECR/ECN.
 *
 * La relazione non punta alla Part ma a un "Affected Item" intermedio, il cui
 * campo affected_id contiene l'elemento vero. Senza questo doppio salto si
 * ottiene una lista di id opachi che non dicono nulla.
 */
export async function changeImpact(client: ArasClient, changeType: "ECR" | "ECN", changeId: string) {
  const relType = `${changeType} Affected Item`;
  const rows = await relatedItems(client, relType, changeId);

  const impatti = await Promise.all(rows.map(async (r) => {
    try {
      const ai = await client.getById<Record<string, unknown>>("Affected Item", r.id,
        ["id", "affected_id", "affected_type", "item_action"]);
      const ref = readItemRef(ai, "affected_id");
      return {
        affectedItemId: r.id,
        elemento: ref?.keyedName ?? null,
        elementoId: ref?.id ?? null,
        tipo: (ai["affected_type"] as string) ?? null,
        azione: (ai["item_action"] as string) ?? null,
      };
    } catch {
      return { affectedItemId: r.id, elemento: r.keyedName, elementoId: null, tipo: null, azione: null };
    }
  }));

  return impatti;
}

/**
 * File allegati a un Document o a un CAD, con URL di download.
 *
 * Sul caricamento, verificato sull'istanza: un File NON puo' essere creato da un
 * client HTTP esterno. Sia `POST /Server/OData/File` sia AML `action="add"`
 * rispondono "File Item cannot be added": Aras rifiuta metadati di file privi di
 * contenuto vaultato. Il vault (`/vault/vaultserver.aspx`) risponde correttamente a
 * `BeginTransaction`, ma `UploadFile` rifiuta corpo binario, multipart e octet-stream
 * ("Can't bind model" / "Root element is missing"). La Programmer's Guide documenta
 * solo vie non raggiungibili da fuori: JavaScript di client (`aras.vault.selectFile`)
 * e C# di server (`setFileProperty` con path locale al server).
 * Il caricamento resta quindi da fare dall'interfaccia Aras; da qui si legge.
 */
export async function filesOf(client: ArasClient, itemType: "Document" | "CAD", itemId: string, baseUrl: string, database: string) {
  const relType = itemType === "Document" ? "Document File" : "CADFiles";
  const rows = await relatedItems(client, relType, itemId);

  return Promise.all(rows.map(async (r) => {
    try {
      const f = await client.getById<Record<string, unknown>>("File", r.id,
        ["id", "filename", "file_size", "mimetype", "checksum"]);
      const nome = String(f["filename"] ?? r.keyedName ?? "");
      return {
        id: r.id,
        filename: nome,
        bytes: Number(f["file_size"] ?? 0) || null,
        mimetype: (f["mimetype"] as string) ?? null,
        checksum: (f["checksum"] as string) ?? null,
        urlDownload: `${baseUrl}/vault/vaultserver.aspx?dbName=${encodeURIComponent(database)}` +
          `&fileId=${r.id}&fileName=${encodeURIComponent(nome)}`,
      };
    } catch {
      return { id: r.id, filename: r.keyedName, bytes: null, mimetype: null, checksum: null, urlDownload: null };
    }
  }));
}

/** Composizione di un'identita' (reparto): membri diretti, utenti e sotto-gruppi. */
export async function membersOf(client: ArasClient, identityId: string) {
  const rows = await relatedItems(client, "Member", identityId);
  return Promise.all(rows.map(async (r) => {
    try {
      const idn = await client.getById<Record<string, unknown>>("Identity", r.id,
        ["id", "name", "is_alias", "description"]);
      return {
        nome: idn["name"],
        // is_alias=1 identifica l'identita' personale di un utente, non un gruppo.
        tipo: String(idn["is_alias"]) === "1" ? "utente" : "gruppo",
        descrizione: idn["description"],
        id: r.id,
      };
    } catch {
      return { nome: r.keyedName, tipo: "?", descrizione: null, id: r.id };
    }
  }));
}
