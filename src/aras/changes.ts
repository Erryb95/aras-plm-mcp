import { ArasClient } from "./client.js";
import { AmlClient } from "./aml.js";
import { readItemRef } from "./odata.js";
import { workflowOf, activitiesOf } from "./workflow.js";

/**
 * Crea una ECR o una ECN con i suoi Affected Item.
 *
 * `item_number` NON va fornito: su ECR/ECN e' di tipo `sequence` e lo genera Aras
 * (ECR-100001, ECR-100002...). Fornirlo produce numerazioni incoerenti.
 *
 * Gli Affected Item sono elementi DIPENDENTI: non esistono da soli. Crearli prima
 * fallisce con "Dependent Affected Item cannot be create: source item not found",
 * e collegare direttamente la Part viola una FOREIGN KEY. Vanno creati inline
 * passando `related_id` come oggetto anziche' come id.
 */
export async function creaModifica(
  client: ArasClient,
  tipo: "ECR" | "ECN",
  dati: Record<string, unknown>,
  elementiImpattati: Array<{ itemType: string; itemNumber: string }>
) {
  if ("item_number" in dati) delete dati["item_number"];

  const change = await client.create<Record<string, unknown>>(tipo, dati);
  const relType = `${tipo} Affected Item`;

  const agganciati: string[] = [];
  const falliti: Array<{ elemento: string; motivo: string }> = [];

  for (const e of elementiImpattati) {
    const found = await client.query<Record<string, unknown>>(e.itemType, {
      filter: `item_number eq '${e.itemNumber.replace(/'/g, "''")}'`, select: ["id"], top: 1,
    }).catch(() => ({ value: [] as Array<Record<string, unknown>> }));
    const id = found.value[0]?.["id"] as string | undefined;
    if (!id) { falliti.push({ elemento: e.itemNumber, motivo: `${e.itemType} inesistente` }); continue; }
    try {
      await client.create(relType, {
        source_id: change["id"],
        related_id: { affected_id: id, affected_type: e.itemType },
      });
      agganciati.push(e.itemNumber);
    } catch (err) {
      falliti.push({ elemento: e.itemNumber, motivo: err instanceof Error ? err.message.slice(0, 140) : "errore" });
    }
  }

  const riletta = await client.getById<Record<string, unknown>>(tipo, String(change["id"]),
    ["id", "item_number", "title", "state"]).catch(() => change);

  return {
    creata: true, tipo,
    id: change["id"],
    numero: riletta["item_number"] ?? null,
    stato: riletta["state"] ?? null,
    elementiImpattati: agganciati,
    falliti: falliti.length ? falliti : undefined,
  };
}

/** Aggiunge un elemento impattato a una modifica esistente. */
export async function aggiungiImpattato(
  client: ArasClient,
  tipo: "ECR" | "ECN",
  changeId: string,
  itemType: string,
  itemNumber: string
) {
  const found = await client.query<Record<string, unknown>>(itemType, {
    filter: `item_number eq '${itemNumber.replace(/'/g, "''")}'`, select: ["id"], top: 1,
  });
  const id = found.value[0]?.["id"] as string | undefined;
  if (!id) return { aggiunto: false, motivo: `${itemType} "${itemNumber}" inesistente.` };

  const relType = `${tipo} Affected Item`;
  const gia = await client.query<Record<string, unknown>>(relType, {
    filter: `source_id eq '${changeId}'`, select: ["id", "related_id"], top: 200,
  });
  for (const r of gia.value) {
    const aiId = readItemRef(r, "related_id")?.id;
    if (!aiId) continue;
    const ai = await client.getById<Record<string, unknown>>("Affected Item", aiId, ["affected_id"]).catch(() => null);
    if (ai && readItemRef(ai, "affected_id")?.id === id) {
      return { aggiunto: false, motivo: `"${itemNumber}" e' gia' fra gli elementi impattati.` };
    }
  }

  await client.create(relType, { source_id: changeId, related_id: { affected_id: id, affected_type: itemType } });
  return { aggiunto: true, elemento: itemNumber, a: tipo };
}

/**
 * Fa avanzare una modifica votando l'attivita' attualmente Active del suo workflow.
 *
 * Distinzione che conta: fra le attivita' del processo molte sono `Pending` — a valle,
 * non ancora raggiungibili — e una sola e' `Active`. Votare una Pending non fa nulla.
 */
export async function avanzaModifica(
  client: ArasClient,
  aml: AmlClient,
  changeId: string,
  via: string,
  commenti?: string,
  dryRun = true
) {
  const processi = await workflowOf(client, changeId);
  if (!processi.length) return { avanzata: false, motivo: "Nessun workflow associato a questa modifica." };

  const attivita = await activitiesOf(client, processi[0]!.id);
  const attive = attivita.filter((a) => a.stato === "Active" && !a.chiusaIl);

  if (!attive.length) {
    return {
      avanzata: false,
      motivo: "Nessuna attivita' Active da votare.",
      processo: processi[0]!.nome,
      statoProcesso: processi[0]!.stato,
      attivitaPendenti: attivita.filter((a) => a.stato === "Pending").map((a) => a.nome),
    };
  }

  const a = attive[0]!;
  const assegnazione = a.assegnazioni[0];

  // Aras vuole l'ID della via, non il nome: passare il nome produce
  // "An internal error has occured". Si risolve il nome sulle vie dell'attivita'.
  const scelta = a.vie.find((v) => v.nome.toLowerCase() === via.toLowerCase())
    ?? (a.vie.length === 1 ? a.vie[0] : a.vie.find((v) => v.predefinita));

  const piano = {
    processo: processi[0]!.nome,
    attivita: a.nome,
    attivitaId: a.id,
    assegnataA: a.assegnazioni.map((s) => s.identita).filter(Boolean),
    vieDisponibili: a.vie.map((v) => v.nome),
    viaScelta: scelta?.nome ?? null,
  };

  if (dryRun) return { avanzata: false, modalita: "dryRun", piano };
  if (!assegnazione) return { avanzata: false, motivo: `L'attivita' "${a.nome}" non ha assegnazioni su cui votare.`, piano };
  if (!scelta) {
    return {
      avanzata: false,
      motivo: `Via "${via}" inesistente su "${a.nome}".`,
      vieDisponibili: a.vie.map((v) => v.nome),
      piano,
    };
  }

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const r = await aml.apply(
    `<Item type="Activity" action="EvaluateActivity">` +
    `<Activity>${a.id}</Activity><ActivityAssignment>${assegnazione.id}</ActivityAssignment>` +
    `<Paths><Path id="${scelta.id}">${esc(scelta.nome)}</Path></Paths>` +
    `<DelegateTo>0</DelegateTo><Tasks/><Variables/><Authentication mode=""/>` +
    `<Comments>${esc(commenti ?? "")}</Comments>` +
    // <Complete> e' obbligatorio: senza, Aras risponde "An internal error has
    // occured" e solo il log del server rivela il motivo vero,
    // "Workflow: EvaluateActivity: Complete value not found".
    `<Complete>1</Complete></Item>`
  );
  return { avanzata: true, piano, risposta: r.items.slice(0, 3) };
}
