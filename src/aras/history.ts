import { ArasClient } from "./client.js";
import { readItemRef } from "./odata.js";

export interface VoceStorico {
  azione: string;
  quando: string | null;
  chi: string | null;
  revisione: string | null;
  stato: string | null;
  versione: number | null;
  commenti: string | null;
}

/**
 * Traccia di audit di un elemento: chi ha fatto cosa e quando.
 *
 * Aras non lega lo storico all'`id` dell'elemento ma al suo `config_id`, tramite un
 * "History Container" per oggetto; le righe `History` puntano al container con
 * `source_id`. Il doppio salto e' necessario: cercare History per `item_id` trova solo
 * la generazione indicata, mentre il container copre l'intera storia dell'oggetto
 * attraverso tutte le revisioni.
 */
export async function historyOf(
  client: ArasClient,
  itemType: string,
  id: string,
  limite: number
): Promise<{ containerId: string | null; voci: VoceStorico[]; nota?: string }> {
  const item = await client.getById<Record<string, unknown>>(itemType, id, ["id", "config_id"]);
  const cfg = readItemRef(item, "config_id");
  const configId = cfg?.id ?? id;

  const cont = await client.query<Record<string, unknown>>("History Container", {
    filter: `item_config_id eq '${configId}'`,
    select: ["id", "item_keyed_name", "itemtype_id"],
    top: 5,
  });

  const containerId = cont.value[0] ? String(cont.value[0]["id"] ?? "") : null;
  if (!containerId) {
    return {
      containerId: null,
      voci: [],
      // La tracciatura si attiva per ItemType tramite un History Template: se non e'
      // configurata per questo tipo, non esiste alcuno storico da mostrare.
      nota: `Nessun History Container per questo elemento: la tracciatura potrebbe non essere ` +
        `attiva sull'ItemType "${itemType}" (si configura con un History Template).`,
    };
  }

  const page = await client.query<Record<string, unknown>>("History", {
    filter: `source_id eq '${containerId}'`,
    select: ["action", "created_on", "created_by_id", "item_major_rev", "item_state", "item_version", "comments"],
    orderby: "created_on desc",
    top: limite,
  });

  const voci: VoceStorico[] = page.value.map((h) => ({
    azione: String(h["action"] ?? ""),
    quando: (h["created_on"] as string) ?? null,
    chi: readItemRef(h, "created_by_id")?.keyedName ?? null,
    revisione: (h["item_major_rev"] as string) ?? null,
    stato: (h["item_state"] as string) ?? null,
    versione: h["item_version"] != null ? Number(h["item_version"]) : null,
    commenti: (h["comments"] as string) ?? null,
  }));

  return { containerId, voci };
}

/**
 * Verifica se una Part e' valida a una certa data.
 *
 * Non essendo installato il modulo Effectivity, l'effettivita' si ricava dai campi
 * data che Aras popola comunque: `effective_date` (da quando vale) e `superseded_date`
 * (da quando e' stata rimpiazzata). Una Part senza `effective_date` si considera valida:
 * il campo vuoto significa "non ancora datata", non "mai valida".
 */
export function validaAllaData(part: Record<string, unknown>, data: Date): { valida: boolean; motivo: string } {
  const eff = part["effective_date"] ? new Date(String(part["effective_date"])) : null;
  const sup = part["superseded_date"] ? new Date(String(part["superseded_date"])) : null;

  if (eff && data < eff) {
    return { valida: false, motivo: `non ancora effettiva (dal ${eff.toISOString().slice(0, 10)})` };
  }
  if (sup && data >= sup) {
    return { valida: false, motivo: `rimpiazzata il ${sup.toISOString().slice(0, 10)}` };
  }
  return { valida: true, motivo: eff ? `effettiva dal ${eff.toISOString().slice(0, 10)}` : "nessuna data di effettivita'" };
}
