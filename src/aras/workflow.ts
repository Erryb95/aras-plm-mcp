import { ArasClient } from "./client.js";
import { readItemRef } from "./odata.js";
import { relatedItems } from "./graph.js";

export interface Assegnazione {
  id: string;
  identita: string | null;
  stato: string | null;
  richiesta: boolean;
  chiusaDa: string | null;
  chiusaIl: string | null;
  inRitardo: boolean;
  commenti: string | null;
}

export interface ViaUscita {
  id: string;
  nome: string;
  predefinita: boolean;
}

export interface AttivitaWf {
  id: string;
  nome: string;
  stato: string | null;
  iniziale: boolean;
  finale: boolean;
  automatica: boolean;
  attivaDal: string | null;
  chiusaIl: string | null;
  assegnazioni: Assegnazione[];
  /** Vie di uscita percorribili: senza, votare o delegare non e' possibile. */
  vie: ViaUscita[];
}

/**
 * Processo di workflow associato a un elemento (ECR, ECN, Part...).
 *
 * Il collegamento non e' una proprieta' dell'elemento ma una relazione a se stante,
 * l'ItemType `Workflow`: source_id punta all'elemento, related_id al Workflow Process.
 * Aras istanzia il processo automaticamente alla creazione di una ECR/ECN, quindi
 * esiste anche se nessuno l'ha avviato a mano.
 */
export async function workflowOf(client: ArasClient, itemId: string) {
  // Niente $filter su source_id: "Workflow" e' una relazione POLIMORFA (ha source_type,
  // perche' la sorgente puo' essere una ECR, una ECN, una Part...). Su questi riferimenti
  // Aras rifiuta il filtro OData con 400 "Value cannot be null (Parameter 'criteria')".
  // Stessa famiglia di problemi di Manufacturer Manf Part, ma qui l'errore e' esplicito
  // invece che silenzioso. Si scorre l'elenco e si confronta l'annotazione in memoria.
  const link = await client.queryAll<Record<string, unknown>>("Workflow", {
    select: ["source_id", "related_id", "source_type", "state"],
    top: 500,
  }, 2000);

  const processi = [];
  for (const row of link.value) {
    if (readItemRef(row, "source_id")?.id !== itemId) continue;
    const ref = readItemRef(row, "related_id");
    if (!ref) continue;
    try {
      const wp = await client.getById<Record<string, unknown>>("Workflow Process", ref.id,
        ["id", "name", "state", "active_date", "closed_date"]);
      processi.push({
        id: ref.id,
        nome: (wp["name"] as string) ?? ref.keyedName,
        stato: (wp["state"] as string) ?? null,
        attivoDal: (wp["active_date"] as string) ?? null,
        chiusoIl: (wp["closed_date"] as string) ?? null,
      });
    } catch {
      processi.push({ id: ref.id, nome: ref.keyedName, stato: null, attivoDal: null, chiusoIl: null });
    }
  }
  return processi;
}

/** Attivita' di un processo, con le assegnazioni risolte. */
export async function activitiesOf(client: ArasClient, processId: string): Promise<AttivitaWf[]> {
  const righe = await relatedItems(client, "Workflow Process Activity", processId);

  const attivita = await Promise.all(righe.map(async (r): Promise<AttivitaWf> => {
    let a: Record<string, unknown> = {};
    try {
      a = await client.getById<Record<string, unknown>>("Activity", r.id,
        ["id", "name", "state", "is_start", "is_end", "is_auto", "active_date", "closed_date"]);
    } catch { /* attivita' non leggibile: si riporta comunque con i dati della relazione */ }

    const asg = await client.query<Record<string, unknown>>("Activity Assignment", {
      filter: `source_id eq '${r.id}'`,
      select: ["id", "related_id", "state", "is_required", "closed_by", "closed_on", "is_overdue", "comments"],
      top: 100,
    }).catch(() => ({ value: [] as Array<Record<string, unknown>> }));

    // Le vie di uscita sono righe di "Workflow Process Path" che partono dall'attivita'.
    // Senza di esse votare e delegare falliscono con "The path is not specified":
    // Aras vuole l'ID del path, non il suo nome.
    const paths = await client.query<Record<string, unknown>>("Workflow Process Path", {
      filter: `source_id eq '${r.id}'`,
      select: ["id", "name", "is_default"],
      orderby: "sort_order",
      top: 20,
    }).catch(() => ({ value: [] as Array<Record<string, unknown>> }));

    return {
      id: r.id,
      nome: String(a["name"] ?? r.keyedName ?? ""),
      stato: (a["state"] as string) ?? null,
      iniziale: String(a["is_start"]) === "1",
      finale: String(a["is_end"]) === "1",
      automatica: String(a["is_auto"]) === "1",
      attivaDal: (a["active_date"] as string) ?? null,
      chiusaIl: (a["closed_date"] as string) ?? null,
      assegnazioni: asg.value.map((s) => ({
        id: String(s["id"] ?? ""),
        identita: readItemRef(s, "related_id")?.keyedName ?? null,
        stato: (s["state"] as string) ?? null,
        richiesta: String(s["is_required"]) === "1",
        chiusaDa: readItemRef(s, "closed_by")?.keyedName ?? null,
        chiusaIl: (s["closed_on"] as string) ?? null,
        inRitardo: String(s["is_overdue"]) === "1",
        commenti: (s["comments"] as string) ?? null,
      })),
      vie: paths.value.map((v) => ({
        id: String(v["id"] ?? ""),
        nome: String(v["name"] ?? ""),
        predefinita: String(v["is_default"]) === "1",
      })),
    };
  }));

  // L'attivita' iniziale prima, la finale in fondo: e' l'ordine in cui si legge un processo.
  return attivita.sort((x, y) =>
    (y.iniziale ? 1 : 0) - (x.iniziale ? 1 : 0) || (x.finale ? 1 : 0) - (y.finale ? 1 : 0) || x.nome.localeCompare(y.nome)
  );
}

/**
 * Attivita' in carico a un'identita': l'equivalente dell'InBasket.
 *
 * Si parte dalle Activity Assignment aperte verso quell'identita' e si risale
 * all'attivita' e al processo. Il filtro sullo stato e' volutamente lasco: gli stati
 * delle assegnazioni variano da configurazione a configurazione, quindi si considera
 * "aperta" ogni assegnazione senza closed_on invece di elencare stati attesi.
 */
export async function inBasketOf(client: ArasClient, identityId: string, soloAperte: boolean) {
  const page = await client.query<Record<string, unknown>>("Activity Assignment", {
    filter: `related_id eq '${identityId}'`,
    select: ["id", "source_id", "state", "closed_on", "is_overdue", "is_required"],
    top: 200,
  });

  const righe = soloAperte ? page.value.filter((r) => !r["closed_on"]) : page.value;

  return Promise.all(righe.map(async (r) => {
    const act = readItemRef(r, "source_id");
    let nomeAttivita: string | null = act?.keyedName ?? null;
    let statoAttivita: string | null = null;
    if (act) {
      try {
        const a = await client.getById<Record<string, unknown>>("Activity", act.id, ["id", "name", "state"]);
        nomeAttivita = (a["name"] as string) ?? nomeAttivita;
        statoAttivita = (a["state"] as string) ?? null;
      } catch { /* non leggibile: resta il keyed_name */ }
    }
    return {
      assegnazioneId: String(r["id"] ?? ""),
      attivita: nomeAttivita,
      attivitaId: act?.id ?? null,
      statoAttivita,
      statoAssegnazione: (r["state"] as string) ?? null,
      richiesta: String(r["is_required"]) === "1",
      inRitardo: String(r["is_overdue"]) === "1",
      chiusa: !!r["closed_on"],
    };
  }));
}
