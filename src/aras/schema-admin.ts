import { ArasClient } from "./client.js";
import { AmlClient } from "./aml.js";

/**
 * Creazione di ItemType, proprieta' e permessi via API.
 *
 * Il pezzo che rende il tipo utilizzabile e' una riga `Allowed Permission` con
 * **`is_default=1`**: e' quella, e non una proprieta' dell'ItemType, a stabilire
 * quale Permission ereditano le istanze. Senza il flag, Aras rifiuta ogni istanza
 * con "Cannot add instances of X because no default permission has been specified",
 * pur avendo accettato la relazione.
 *
 * Due strade sbagliate che sembrano giuste:
 *  - `default_permission_id`: NON esiste come proprieta' di ItemType (scriverla
 *    non da' errore, semplicemente non fa nulla);
 *  - `permission_id`: esiste e si persiste, ma governa chi puo' modificare la
 *    DEFINIZIONE del tipo, non le sue istanze. Su Part vale "ItemType", mentre le
 *    Part reali ereditano "New Part" dalla Allowed Permission marcata is_default.
 *
 * Tutto in una sola transazione: ItemType, Allowed Permission, Can Add e Property
 * come Relationships annidate nella add.
 */
export async function creaItemType(
  client: ArasClient,
  aml: AmlClient,
  nome: string,
  opzioni: {
    etichetta?: string;
    versionabile?: boolean;
    permissionName?: string;
    canAddIdentity?: string;
    proprieta?: Array<{ nome: string; tipo: string; lunghezza?: number; obbligatoria?: boolean; etichetta?: string }>;
  }
) {
  const passi: Array<{ passo: string; esito: string }> = [];
  const esistente = await client.query<Record<string, unknown>>("ItemType", {
    filter: `name eq '${nome.replace(/'/g, "''")}'`, select: ["id", "name"], top: 1,
  });
  if (esistente.value.length) {
    return { creato: false, motivo: `ItemType "${nome}" esiste gia'.`, id: esistente.value[0]!["id"] };
  }

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Permission da cui le istanze erediteranno i diritti. "New Part" e' quella che
  // Aras usa per le Part: riusarla da subito un tipo funzionante.
  const nomePerm = opzioni.permissionName ?? "New Part";
  const p = await client.query<Record<string, unknown>>("Permission", {
    filter: `name eq '${nomePerm.replace(/'/g, "''")}'`, select: ["id", "name"], top: 1,
  }).catch(() => ({ value: [] as Array<Record<string, unknown>> }));
  const permId = p.value[0]?.["id"] as string | undefined;
  if (!permId) {
    return { creato: false, motivo: `Permission "${nomePerm}" inesistente: senza, il tipo non accetterebbe istanze.` };
  }

  let identId: string | undefined;
  if (opzioni.canAddIdentity) {
    const idn = await client.query<Record<string, unknown>>("Identity", {
      filter: `name eq '${opzioni.canAddIdentity.replace(/'/g, "''")}'`, select: ["id"], top: 1,
    });
    identId = idn.value[0]?.["id"] as string | undefined;
  }

  // Tutto in una transazione: ItemType + permesso di default + Can Add + proprieta'.
  const relazioni =
    `<Item type="Allowed Permission" action="add"><related_id>${permId}</related_id><is_default>1</is_default></Item>` +
    (identId ? `<Item type="Can Add" action="add"><related_id>${identId}</related_id></Item>` : "") +
    (opzioni.proprieta ?? []).map((pr) =>
      `<Item type="Property" action="add">` +
      `<name>${esc(pr.nome)}</name><label>${esc(pr.etichetta ?? pr.nome)}</label>` +
      `<data_type>${esc(pr.tipo)}</data_type>` +
      (pr.lunghezza ? `<stored_length>${pr.lunghezza}</stored_length>` : "") +
      (pr.obbligatoria ? `<is_required>1</is_required>` : "") +
      `</Item>`
    ).join("");

  const r = await aml.apply(
    `<Item type="ItemType" action="add">` +
    `<name>${esc(nome)}</name><label>${esc(opzioni.etichetta ?? nome)}</label>` +
    `<is_versionable>${opzioni.versionabile ? 1 : 0}</is_versionable>` +
    `<is_relationship>0</is_relationship>` +
    `<instance_data>${esc(nome.toUpperCase())}</instance_data>` +
    `<Relationships>${relazioni}</Relationships></Item>`
  );
  const nuovoId = r.items.find((i) => i["id"])?.["id"];
  passi.push({ passo: "ItemType", esito: nuovoId ? `creato (${nuovoId})` : "id non restituito" });
  if (!nuovoId) return { creato: false, motivo: "Aras non ha restituito l'id del nuovo ItemType.", passi };

  passi.push({ passo: "Allowed Permission", esito: `${nomePerm}, is_default=1` });
  passi.push({ passo: "Can Add", esito: identId ? `concesso a ${opzioni.canAddIdentity}` : "non richiesto" });

  const propCreate = (opzioni.proprieta ?? []).map((x) => x.nome);
  passi.push({ passo: "Property", esito: `${propCreate.length} create nella stessa transazione` });

  // 5. verifica reale: si riesce a creare un'istanza e poi rimuoverla?
  // Le proprieta' obbligatorie vanno valorizzate, altrimenti il test fallisce sul
  // vincolo NOT NULL e non sul permesso, che e' cio' che si vuole davvero verificare.
  const segnaposto = (opzioni.proprieta ?? [])
    .filter((pr) => pr.obbligatoria)
    .map((pr) => {
      const v = /int|decimal|float/i.test(pr.tipo) ? "0"
        : /date/i.test(pr.tipo) ? new Date(0).toISOString().slice(0, 19)
        : /bool/i.test(pr.tipo) ? "0" : "ZZ-VERIFICA";
      return `<${esc(pr.nome)}>${v}</${esc(pr.nome)}>`;
    }).join("");

  let istanziabile = false;
  let erroreIstanza: string | undefined;
  try {
    const prova = await aml.apply(`<Item type="${esc(nome)}" action="add">${segnaposto}</Item>`);
    const provaId = prova.items.find((i) => i["id"])?.["id"];
    if (provaId) {
      istanziabile = true;
      await aml.apply(`<Item type="${esc(nome)}" id="${provaId}" action="delete"/>`).catch(() => null);
    }
  } catch (e) {
    erroreIstanza = e instanceof Error ? e.message.slice(0, 220) : String(e);
  }
  passi.push({ passo: "istanziabile", esito: istanziabile ? "si', verificato creando e rimuovendo un'istanza" : `no — ${erroreIstanza ?? "motivo ignoto"}` });

  return {
    creato: true, id: nuovoId, nome,
    proprietaCreate: propCreate,
    istanziabile,
    passi,
    nota: istanziabile
      ? undefined
      : "L'ItemType esiste ma non accetta istanze. Verifica che la riga Allowed Permission " +
        "abbia is_default=1: e' quella, non una proprieta' del tipo, a stabilire i diritti " +
        "ereditati dalle istanze.",
  };
}

/** Aggiunge una proprieta' a un ItemType esistente. */
export async function aggiungiProprieta(
  client: ArasClient,
  aml: AmlClient,
  itemType: string,
  p: { nome: string; tipo: string; lunghezza?: number; obbligatoria?: boolean; etichetta?: string }
) {
  const t = await client.query<Record<string, unknown>>("ItemType", {
    filter: `name eq '${itemType.replace(/'/g, "''")}'`, select: ["id"], top: 1,
  });
  const tid = t.value[0]?.["id"] as string | undefined;
  if (!tid) return { aggiunta: false, motivo: `ItemType "${itemType}" inesistente.` };

  const gia = await client.query<Record<string, unknown>>("Property", {
    filter: `source_id eq '${tid}'`, select: ["name"], top: 500,
  });
  if (gia.value.some((x) => x["name"] === p.nome)) {
    return { aggiunta: false, motivo: `La proprieta' "${p.nome}" esiste gia' su "${itemType}".` };
  }

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  await aml.apply(
    `<Item type="Property" action="add"><source_id>${tid}</source_id>` +
    `<name>${esc(p.nome)}</name><label>${esc(p.etichetta ?? p.nome)}</label>` +
    `<data_type>${esc(p.tipo)}</data_type>` +
    (p.lunghezza ? `<stored_length>${p.lunghezza}</stored_length>` : "") +
    (p.obbligatoria ? `<is_required>1</is_required>` : "") +
    `</Item>`
  );
  return { aggiunta: true, itemType, proprieta: p.nome, tipo: p.tipo };
}
