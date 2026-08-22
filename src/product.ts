import { ArasClient } from "./client.js";
import { AmlClient } from "./aml.js";
import { readItemRef } from "./odata.js";
import { explodeBom } from "./bom.js";

/** Trova un elemento per item_number, o null. */
async function perNumero(client: ArasClient, tipo: string, num: string) {
  const r = await client.query<Record<string, unknown>>(tipo, {
    filter: `item_number eq '${num.replace(/'/g, "''")}'`,
    select: ["id", "item_number", "name", "state"],
    top: 1,
  });
  return r.value[0] ?? null;
}

/** Crea una Part, opzionalmente agganciandola subito a un assieme padre. */
export async function creaPart(
  client: ArasClient,
  dati: Record<string, unknown> & { item_number: string },
  padre?: { itemNumber: string; quantita: number; riferimento?: string }
) {
  const gia = await perNumero(client, "Part", dati.item_number);
  if (gia) return { creata: false, motivo: `Esiste gia' la Part "${dati.item_number}".`, id: gia["id"] };

  const part = await client.create<Record<string, unknown>>("Part", dati);

  let inDistinta;
  if (padre) {
    const p = await perNumero(client, "Part", padre.itemNumber);
    if (!p) {
      inDistinta = { agganciata: false, motivo: `Assieme padre "${padre.itemNumber}" inesistente.` };
    } else {
      await client.create("Part BOM", {
        source_id: p["id"], related_id: part["id"],
        quantity: String(padre.quantita),
        ...(padre.riferimento ? { reference_designator: padre.riferimento } : {}),
      });
      inDistinta = { agganciata: true, sotto: padre.itemNumber, quantita: padre.quantita };
    }
  }
  return { creata: true, id: part["id"], item_number: dati.item_number, inDistinta };
}

/** Crea un Document o un CAD e lo collega a una Part. */
export async function creaDocumento(
  client: ArasClient,
  tipo: "Document" | "CAD",
  dati: Record<string, unknown> & { item_number: string },
  partNumber?: string
) {
  // Se il documento esiste gia' si usa quello: chi ha chiesto perPart vuole il
  // collegamento, non necessariamente un elemento nuovo. Uscire qui senza
  // collegare — come faceva prima — restituiva un id e nessuna relazione, e il
  // chiamante non aveva modo di accorgersene.
  const gia = await perNumero(client, tipo, dati.item_number);
  const doc = gia ?? (await client.create<Record<string, unknown>>(tipo, dati));

  const collegato = partNumber
    ? await collegaAPart(client, tipo, doc["id"] as string, partNumber)
    : undefined;

  return {
    creato: !gia,
    ...(gia ? { motivo: `Esisteva gia' ${tipo} "${dati.item_number}": riusato.` } : {}),
    id: doc["id"],
    item_number: dati.item_number,
    collegato,
  };
}

/**
 * Collega un documento a una Part, senza duplicare se la riga c'e' gia', e
 * verificando l'esito invece di darlo per scontato.
 */
async function collegaAPart(client: ArasClient, tipo: "Document" | "CAD", docId: string, partNumber: string) {
  const rel = tipo === "Document" ? "Part Document" : "Part CAD";
  const p = await perNumero(client, "Part", partNumber);
  if (!p) return { fatto: false, relazione: rel, motivo: `Part "${partNumber}" inesistente.` };

  const esistenti = await client.query<Record<string, unknown>>(rel, {
    filter: `source_id eq '${p["id"]}'`, select: ["id", "related_id"], top: 200,
  });
  const gia = esistenti.value.some((r) => readItemRef(r, "related_id")?.id === docId);
  if (!gia) await client.create(rel, { source_id: p["id"], related_id: docId });

  // Verifica: il collegamento va confermato, non annunciato.
  const dopo = await client.query<Record<string, unknown>>(rel, {
    filter: `source_id eq '${p["id"]}'`, select: ["id", "related_id"], top: 200,
  });
  const confermato = dopo.value.some((r) => readItemRef(r, "related_id")?.id === docId);

  return confermato
    ? { fatto: true, relazione: rel, aPart: partNumber, partId: p["id"], gia }
    : { fatto: false, relazione: rel, aPart: partNumber, partId: p["id"],
        motivo: "La riga di relazione non risulta presente dopo la creazione." };
}

/** Aggiunge, aggiorna o rimuove una riga di distinta. */
export async function gestisciRigaBom(
  client: ArasClient,
  aml: AmlClient,
  azione: "aggiungi" | "aggiorna" | "rimuovi",
  padreNum: string,
  figlioNum: string,
  quantita?: number,
  riferimento?: string
) {
  const padre = await perNumero(client, "Part", padreNum);
  const figlio = await perNumero(client, "Part", figlioNum);
  if (!padre) return { fatto: false, motivo: `Assieme "${padreNum}" inesistente.` };
  if (!figlio) return { fatto: false, motivo: `Componente "${figlioNum}" inesistente.` };

  const righe = await client.query<Record<string, unknown>>("Part BOM", {
    filter: `source_id eq '${padre["id"]}'`,
    select: ["id", "related_id", "quantity", "reference_designator"],
    top: 500,
  });
  const riga = righe.value.find((r) => readItemRef(r, "related_id")?.id === figlio["id"]);

  if (azione === "aggiungi") {
    if (riga) return { fatto: false, motivo: `"${figlioNum}" e' gia' in distinta sotto "${padreNum}".`, rigaId: riga["id"] };
    const nuova = await client.create<Record<string, unknown>>("Part BOM", {
      source_id: padre["id"], related_id: figlio["id"],
      quantity: String(quantita ?? 1),
      ...(riferimento ? { reference_designator: riferimento } : {}),
    });
    return { fatto: true, azione, rigaId: nuova["id"], padre: padreNum, figlio: figlioNum, quantita: quantita ?? 1 };
  }

  if (!riga) return { fatto: false, motivo: `"${figlioNum}" non e' in distinta sotto "${padreNum}".` };

  if (azione === "rimuovi") {
    await aml.apply(`<Item type="Part BOM" id="${riga["id"]}" action="delete"/>`);
    return { fatto: true, azione, padre: padreNum, figlio: figlioNum };
  }

  const patch: Record<string, unknown> = {};
  if (quantita !== undefined) patch["quantity"] = String(quantita);
  if (riferimento !== undefined) patch["reference_designator"] = riferimento;
  if (!Object.keys(patch).length) return { fatto: false, motivo: "Niente da aggiornare: indica quantita' o riferimento." };
  await client.update("Part BOM", String(riga["id"]), patch);
  return { fatto: true, azione, padre: padreNum, figlio: figlioNum, ...patch };
}

/**
 * Duplica una Part, opzionalmente con la sua distinta di primo livello.
 * Aras non offre una copia "profonda" via API: si ricrea l'oggetto e si
 * riagganciano le stesse righe di distinta ai medesimi componenti.
 */
export async function copiaPart(
  client: ArasClient,
  origineNum: string,
  nuovoNum: string,
  nuovoNome?: string,
  conDistinta = true
) {
  const src = await client.query<Record<string, unknown>>("Part", {
    filter: `item_number eq '${origineNum.replace(/'/g, "''")}'`, top: 1,
  });
  const o = src.value[0];
  if (!o) return { copiata: false, motivo: `Part "${origineNum}" inesistente.` };
  if (await perNumero(client, "Part", nuovoNum)) {
    return { copiata: false, motivo: `Esiste gia' la Part "${nuovoNum}".` };
  }

  // Si copiano solo le proprieta' di dominio: id, revisione, stato e audit li rifa' Aras.
  const escluse = new Set(["id", "config_id", "created_by_id", "created_on", "modified_by_id",
    "modified_on", "permission_id", "generation", "is_current", "is_released", "major_rev",
    "minor_rev", "state", "current_state", "keyed_name", "itemtype", "locked_by_id",
    "new_version", "not_lockable", "owned_by_id", "managed_by_id", "team_id", "css"]);
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (escluse.has(k) || k.includes("@") || v === null) continue;
    props[k] = v;
  }
  props["item_number"] = nuovoNum;
  if (nuovoNome) props["name"] = nuovoNome;

  const nuova = await client.create<Record<string, unknown>>("Part", props);

  let righe = 0;
  if (conDistinta) {
    const bom = await client.query<Record<string, unknown>>("Part BOM", {
      filter: `source_id eq '${o["id"]}'`,
      select: ["related_id", "quantity", "reference_designator"], top: 500,
    });
    for (const r of bom.value) {
      const figlio = readItemRef(r, "related_id");
      if (!figlio) continue;
      await client.create("Part BOM", {
        source_id: nuova["id"], related_id: figlio.id,
        quantity: String(r["quantity"] ?? 1),
        ...(r["reference_designator"] ? { reference_designator: r["reference_designator"] } : {}),
      });
      righe++;
    }
  }
  return { copiata: true, id: nuova["id"], da: origineNum, a: nuovoNum, righeDistintaCopiate: righe };
}

/** Crea un Manufacturer Part, lo lega al costruttore e lo approva su una Part (AML). */
export async function aggiungiManufacturerPart(
  client: ArasClient,
  mpn: string,
  descrizione: string,
  costruttore: string,
  partNumber: string
) {
  const trovaPerNome = async (tipo: string, nome: string) => {
    const r = await client.query<Record<string, unknown>>(tipo, {
      filter: `name eq '${nome.replace(/'/g, "''")}'`, select: ["id", "name"], top: 1,
    });
    return r.value[0] ?? null;
  };

  let costr = await trovaPerNome("Manufacturer", costruttore);
  let costruttoreCreato = false;
  if (!costr) {
    costr = await client.create<Record<string, unknown>>("Manufacturer", { name: costruttore });
    costruttoreCreato = true;
  }

  let mp = await perNumero(client, "Manufacturer Part", mpn);
  let mpCreata = false;
  if (!mp) {
    mp = await client.create<Record<string, unknown>>("Manufacturer Part", { item_number: mpn, name: descrizione });
    mpCreata = true;
    await client.create("Manufacturer Manf Part", { source_id: costr["id"], related_id: mp["id"] });
  }

  const part = await perNumero(client, "Part", partNumber);
  if (!part) return { fatto: false, motivo: `Part "${partNumber}" inesistente.`, manufacturerPartId: mp["id"] };

  const gia = await client.query<Record<string, unknown>>("Part AML", {
    filter: `source_id eq '${part["id"]}'`, select: ["related_id"], top: 100,
  });
  if (gia.value.some((r) => readItemRef(r, "related_id")?.id === mp!["id"])) {
    return { fatto: false, motivo: `"${mpn}" e' gia' approvato su "${partNumber}".` };
  }
  await client.create("Part AML", { source_id: part["id"], related_id: mp["id"] });

  return {
    fatto: true, manufacturerPart: mpn, costruttore, approvatoSu: partNumber,
    costruttoreCreato, manufacturerPartCreata: mpCreata,
  };
}

/** Componenti della distinta non ancora rilasciati: blocca il rilascio dell'assieme. */
export async function componentiNonRilasciati(client: ArasClient, partId: string, profondita: number) {
  const albero = await explodeBom(client, partId, profondita);
  const visti = new Map<string, { itemNumber: string; id: string }>();
  const raccogli = (n: typeof albero) => {
    for (const c of n.children) {
      visti.set(c.id, { itemNumber: c.itemNumber, id: c.id });
      raccogli(c);
    }
  };
  raccogli(albero);

  const esiti = await Promise.all([...visti.values()].map(async (c) => {
    try {
      const p = await client.getById<Record<string, unknown>>("Part", c.id, ["id", "item_number", "state", "is_released"]);
      return { ...c, stato: p["state"] as string, rilasciata: String(p["is_released"]) === "1" };
    } catch {
      return { ...c, stato: null, rilasciata: false };
    }
  }));
  return {
    radice: albero.itemNumber,
    componenti: esiti.length,
    nonRilasciati: esiti.filter((e) => !e.rilasciata),
  };
}
