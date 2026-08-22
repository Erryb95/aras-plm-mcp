import { ArasClient } from "./client.js";
import { AmlClient } from "./aml.js";
import { readItemRef } from "./odata.js";

export interface Revision {
  id: string;
  generation: number;
  majorRev: string | null;
  isCurrent: boolean;
  isReleased: boolean;
  state: string | null;
  modifiedOn: string | null;
  lockedBy: string | null;
}

/**
 * Storia delle revisioni di un elemento versionabile.
 *
 * DEVE passare da AML: l'OData di Aras e' strutturalmente cieco alle generazioni
 * non correnti. Verificato su istanza reale con una Part portata a 3 generazioni:
 *
 *   OData  $filter=config_id eq '<cfg>'                  -> 1 riga  (solo gen 3)
 *   OData  $filter=config_id eq '<cfg>' and is_current eq '0' -> 0 righe
 *   AML    action="get" where="config_id='<cfg>'"        -> 1 elemento
 *   AML    action="get" queryType="Any"                  -> 1 elemento
 *   AML    action="getItemAllVersions"                   -> 3 elementi, gen 1 2 3
 *
 * Solo l'ultima vede lo storico. Filtrare su config_id via OData sembra funzionare
 * ma restituisce in silenzio un solo record: e' il tipo di errore che fa credere
 * di avere lo storico quando non lo si ha.
 */
export async function revisionsOf(
  client: ArasClient,
  aml: AmlClient,
  itemType: string,
  id: string
): Promise<{ configId: string | null; revisioni: Revision[] }> {
  const item = await client.getById<Record<string, unknown>>(itemType, id,
    ["id", "config_id", "generation", "major_rev", "is_current"]);
  const cfg = readItemRef(item, "config_id");

  let righe: Array<Record<string, string>>;
  try {
    const res = await aml.apply(`<Item type="${itemType}" id="${id}" action="getItemAllVersions"/>`);
    righe = res.items.filter((r) => r["id"]);
  } catch {
    // Tipo non versionabile: getItemAllVersions solleva eccezione. C'e' una sola riga.
    righe = [];
  }

  if (!righe.length) {
    return {
      configId: cfg?.id ?? null,
      revisioni: [{
        id, generation: Number(item["generation"] ?? 1), majorRev: (item["major_rev"] as string) ?? null,
        isCurrent: true, isReleased: false, state: null, modifiedOn: null, lockedBy: null,
      }],
    };
  }

  const revisioni: Revision[] = righe
    .map((r) => ({
      id: r["id"] ?? "",
      generation: Number(r["generation"] ?? 0),
      majorRev: r["major_rev"] ?? null,
      isCurrent: r["is_current"] === "1",
      isReleased: r["is_released"] === "1",
      state: r["state"] ?? null,
      modifiedOn: r["modified_on"] ?? null,
      // In AML il lock arriva come attributo/elemento locked_by_id valorizzato.
      lockedBy: r["locked_by_id"] ? (r["locked_by_id_keyed_name"] ?? r["locked_by_id"]) : null,
    }))
    .sort((a, b) => a.generation - b.generation);

  return { configId: cfg?.id ?? null, revisioni };
}

/**
 * Crea una nuova generazione.
 *
 * Sequenza imposta da Aras (Programmer's Guide, tabella Built in Action Methods):
 * `version` azzera locked_by_id sull'originale e lo imposta sulla nuova generazione,
 * quindi l'elemento DEVE essere bloccato prima. Si sblocca dopo, altrimenti resta
 * in carico all'utente corrente e nessun altro puo' modificarlo.
 */
export async function newRevision(
  aml: AmlClient,
  itemType: string,
  id: string
): Promise<{ nuovaGenerazione: string | null; passi: string[] }> {
  const passi: string[] = [];

  await aml.apply(`<Item type="${itemType}" id="${id}" action="lock"/>`);
  passi.push("lock");

  const versioned = await aml.apply(`<Item type="${itemType}" id="${id}" action="version"/>`);
  passi.push("version");

  const nuovo = versioned.items.find((i) => i["id"] && i["id"] !== id)?.["id"] ?? null;

  // Lo sblocco va tentato sulla NUOVA generazione: e' li' che version ha spostato il lock.
  const target = nuovo ?? id;
  try {
    await aml.apply(`<Item type="${itemType}" id="${target}" action="unlock"/>`);
    passi.push("unlock");
  } catch {
    passi.push("unlock fallito (elemento resta bloccato)");
  }

  return { nuovaGenerazione: nuovo, passi };
}

export interface DeletePlan {
  eseguibile: boolean;
  modo: "purge" | "delete";
  effetto: string;
  dipendenze: Array<{ relazione: string; righe: number }>;
  avvertenze: string[];
}

/**
 * Analizza cosa comporterebbe cancellare un elemento, senza cancellarlo.
 *
 * Distinzione che la Programmer's Guide rende esplicita e che e' facile fraintendere:
 *   purge  -> elimina SOLO la generazione indicata
 *   delete -> elimina TUTTE le generazioni dell'oggetto
 * Su un tipo non versionabile le due coincidono. Su una Part con storico, `delete`
 * cancella anni di revisioni: e' irreversibile e non deve mai essere il default.
 */
export async function planDelete(
  client: ArasClient,
  aml: AmlClient,
  itemType: string,
  id: string,
  modo: "purge" | "delete",
  relazioniDaControllare: string[]
): Promise<DeletePlan> {
  const avvertenze: string[] = [];
  const dipendenze: Array<{ relazione: string; righe: number }> = [];

  const { revisioni } = await revisionsOf(client, aml, itemType, id);
  const altre = revisioni.length - 1;

  if (modo === "delete" && altre > 0) {
    avvertenze.push(`"delete" eliminerebbe TUTTE le ${revisioni.length} generazioni, non solo questa.`);
  }
  if (revisioni.some((r) => r.isReleased)) {
    avvertenze.push("Almeno una generazione risulta rilasciata (is_released): cancellarla altera lo storico approvato.");
  }
  const bloccate = revisioni.filter((r) => r.lockedBy);
  if (bloccate.length) {
    avvertenze.push(`${bloccate.length} generazione/i risultano bloccate da: ${[...new Set(bloccate.map((b) => b.lockedBy))].join(", ")}.`);
  }

  // Un elemento ancora referenziato lascerebbe relazioni orfane.
  for (const rel of relazioniDaControllare) {
    for (const campo of ["source_id", "related_id"]) {
      try {
        const page = await client.query<Record<string, unknown>>(rel, {
          filter: `${campo} eq '${id}'`, select: [campo], top: 200, count: true,
        });
        const n = page.count ?? page.value.length;
        if (n > 0) dipendenze.push({ relazione: `${rel} (${campo})`, righe: n });
      } catch {
        // Relazione inesistente o filtro non applicabile (riferimenti polimorfi):
        // si annota come non verificabile invece di far fallire l'analisi.
        dipendenze.push({ relazione: `${rel} (${campo})`, righe: -1 });
      }
    }
  }

  const referenziato = dipendenze.filter((d) => d.righe > 0);
  if (referenziato.length) {
    avvertenze.push(
      `L'elemento e' ancora referenziato in ${referenziato.length} relazione/i: ` +
      referenziato.map((d) => `${d.relazione}=${d.righe}`).join(", ")
    );
  }
  if (dipendenze.some((d) => d.righe === -1)) {
    avvertenze.push("Alcune relazioni non sono verificabili via OData (riferimenti polimorfi): controllo incompleto.");
  }

  return {
    eseguibile: avvertenze.length === 0,
    modo,
    effetto: modo === "purge"
      ? "elimina solo questa generazione"
      : `elimina tutte le ${revisioni.length} generazioni`,
    dipendenze,
    avvertenze,
  };
}
