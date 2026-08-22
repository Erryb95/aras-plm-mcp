import { ArasClient } from "./client.js";
import { SchemaCache } from "./schema.js";

/** Tipi di dominio interrogati per default da una ricerca trasversale. */
export const DEFAULT_SEARCH_TYPES = [
  "Part", "Document", "CAD", "ECR", "ECN", "Manufacturer", "Manufacturer Part",
];

/** Campi testuali su cui cercare, in ordine di rilevanza. */
const TEXT_FIELDS = ["item_number", "name", "description", "title", "keyed_name"];

/** Campi di sistema: cercarci dentro produce solo rumore. */
const SKIP_FIELDS = new Set([
  "css", "classification", "state", "major_rev", "minor_rev", "keyed_name",
  "external_id", "external_owner", "external_type", "config_id", "id",
]);

export interface Hit {
  itemType: string;
  id: string;
  etichetta: string;
  campo: string;
  valore: string;
}

/**
 * Ricerca trasversale su piu' ItemType.
 *
 * Aras non ha un endpoint di ricerca globale: si puo' solo interrogare un tipo per
 * volta. Con centinaia di tipi, chi cerca "girante" non sa a priori se sia una Part,
 * un Document o un CAD. Qui si interrogano in parallelo i tipi indicati, costruendo
 * per ciascuno un filtro solo sui campi testuali che quel tipo possiede davvero
 * (letti dallo schema): un contains() su un campo inesistente fa fallire l'intera
 * query con 400, quindi il filtro non puo' essere fisso.
 */
export async function crossSearch(
  client: ArasClient,
  schema: SchemaCache,
  term: string,
  itemTypes: string[],
  perType: number
): Promise<{ hits: Hit[]; interrogati: string[]; ignorati: Array<{ tipo: string; motivo: string }> }> {
  const safe = term.replace(/'/g, "''");
  const hits: Hit[] = [];
  const interrogati: string[] = [];
  const ignorati: Array<{ tipo: string; motivo: string }> = [];

  await Promise.all(
    itemTypes.map(async (tipo) => {
      let campi: string[];
      try {
        const props = await schema.propertiesOf(tipo);
        const disponibili = new Set(props.map((p) => p.name));
        campi = TEXT_FIELDS.filter((f) => disponibili.has(f));

        // Un ItemType su misura non usa i nomi standard: puo' avere "codice" e
        // "titolo" invece di item_number e name. Senza questo ripiego la ricerca
        // restituirebbe zero risultati pur essendoci i dati.
        // Attenzione: keyed_name esiste su OGNI ItemType, quindi da solo non prova
        // che il tipo usi la nomenclatura standard — altrimenti il ripiego non
        // scatterebbe mai e si cercherebbe in un campo quasi sempre vuoto.
        const soloKeyedName = campi.length === 1 && campi[0] === "keyed_name";
        if (!campi.length || soloKeyedName) {
          const propri = props
            .filter((p) => ["string", "text"].includes(p.dataType) && !SKIP_FIELDS.has(p.name))
            .map((p) => p.name)
            .slice(0, 8);
          if (propri.length) campi = propri;
        }
        if (!campi.length) { ignorati.push({ tipo, motivo: "nessun campo testuale" }); return; }
      } catch (e) {
        ignorati.push({ tipo, motivo: e instanceof Error ? e.message : "tipo inesistente" });
        return;
      }

      const filter = campi.map((f) => `contains(${f},'${safe}')`).join(" or ");
      try {
        const page = await client.query<Record<string, unknown>>(tipo, {
          filter,
          select: [...new Set(["id", ...campi])],
          top: perType,
        });
        interrogati.push(tipo);
        for (const row of page.value) {
          // Si riporta il primo campo che contiene davvero il termine: dice
          // *perche'* l'elemento e' stato trovato, non solo che lo e' stato.
          const campo = campi.find((f) =>
            String(row[f] ?? "").toLowerCase().includes(term.toLowerCase())
          ) ?? campi[0]!;
          hits.push({
            itemType: tipo,
            id: String(row["id"] ?? ""),
            etichetta: String(row["item_number"] ?? row["name"] ?? row["keyed_name"] ?? row["id"] ?? ""),
            campo,
            valore: String(row[campo] ?? "").slice(0, 200),
          });
        }
      } catch (e) {
        ignorati.push({ tipo, motivo: e instanceof Error ? e.message.slice(0, 120) : "query fallita" });
      }
    })
  );

  // Chi cerca per codice si aspetta la corrispondenza esatta in cima.
  const t = term.toLowerCase();
  hits.sort((a, b) => {
    const score = (h: Hit) =>
      h.etichetta.toLowerCase() === t ? 0 : h.etichetta.toLowerCase().startsWith(t) ? 1 : 2;
    return score(a) - score(b) || a.itemType.localeCompare(b.itemType);
  });

  return { hits, interrogati, ignorati };
}
