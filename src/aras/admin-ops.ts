import { ArasClient } from "./client.js";
import { AmlClient } from "./aml.js";
import { readItemRef } from "./odata.js";

/**
 * Diritti concessi da un Permission alle varie identita'.
 * Le righe stanno nell'ItemType `Access`: source_id = Permission,
 * related_id = Identity, e cinque flag booleani per le operazioni.
 */
export async function dettaglioPermesso(client: ArasClient, nomePermesso: string) {
  const p = await client.query<Record<string, unknown>>("Permission", {
    filter: `name eq '${nomePermesso.replace(/'/g, "''")}'`, select: ["id", "name", "is_private"], top: 1,
  });
  const perm = p.value[0];
  if (!perm) return null;

  const acc = await client.query<Record<string, unknown>>("Access", {
    filter: `source_id eq '${perm["id"]}'`,
    select: ["id", "related_id", "can_get", "can_update", "can_delete", "can_discover", "can_change_access"],
    top: 200,
  });

  return {
    permesso: perm["name"],
    id: perm["id"],
    privato: String(perm["is_private"]) === "1",
    concessioni: acc.value.map((a) => ({
      identita: readItemRef(a, "related_id")?.keyedName ?? null,
      accessoId: a["id"],
      leggere: String(a["can_get"]) === "1",
      modificare: String(a["can_update"]) === "1",
      cancellare: String(a["can_delete"]) === "1",
      scoprire: String(a["can_discover"]) === "1",
      cambiareAccessi: String(a["can_change_access"]) === "1",
    })),
  };
}

/** Concede o revoca diritti a un'identita' su un Permission. */
export async function concediPermesso(
  client: ArasClient,
  aml: AmlClient,
  nomePermesso: string,
  identita: string,
  diritti: { leggere?: boolean; modificare?: boolean; cancellare?: boolean; scoprire?: boolean }
) {
  const p = await client.query<Record<string, unknown>>("Permission", {
    filter: `name eq '${nomePermesso.replace(/'/g, "''")}'`, select: ["id"], top: 1,
  });
  const permId = p.value[0]?.["id"] as string | undefined;
  if (!permId) return { fatto: false, motivo: `Permission "${nomePermesso}" inesistente.` };

  const i = await client.query<Record<string, unknown>>("Identity", {
    filter: `name eq '${identita.replace(/'/g, "''")}'`, select: ["id"], top: 1,
  });
  const idnId = i.value[0]?.["id"] as string | undefined;
  if (!idnId) return { fatto: false, motivo: `Identita' "${identita}" inesistente.` };

  const b = (v: boolean | undefined) => (v ? "1" : "0");
  const campi = {
    can_get: b(diritti.leggere),
    can_update: b(diritti.modificare),
    can_delete: b(diritti.cancellare),
    // Senza can_discover l'elemento non compare nemmeno nelle ricerche: si concede
    // per default quando si concede la lettura, altrimenti il permesso e' inerte.
    can_discover: b(diritti.scoprire ?? diritti.leggere),
  };

  const esistenti = await client.query<Record<string, unknown>>("Access", {
    filter: `source_id eq '${permId}'`, select: ["id", "related_id"], top: 200,
  });
  const riga = esistenti.value.find((a) => readItemRef(a, "related_id")?.id === idnId);

  // Azzerare i flag lascia una riga Access inerte ma presente: per togliere davvero
  // la concessione va rimossa la riga, altrimenti resta a sporcare il Permission.
  const tuttiFalsi = Object.values(campi).every((v) => v === "0");
  if (tuttiFalsi && riga) {
    await aml.apply(`<Item type="Access" id="${riga["id"]}" action="delete"/>`);
    return { fatto: true, azione: "revocata", permesso: nomePermesso, identita };
  }
  if (tuttiFalsi) {
    return { fatto: false, motivo: `"${identita}" non ha concessioni su "${nomePermesso}": niente da revocare.` };
  }

  if (riga) {
    await client.update("Access", String(riga["id"]), campi);
    return { fatto: true, azione: "aggiornata", permesso: nomePermesso, identita, diritti: campi };
  }
  await client.create("Access", { source_id: permId, related_id: idnId, ...campi });
  return { fatto: true, azione: "creata", permesso: nomePermesso, identita, diritti: campi };
}

/**
 * Sostituisce un componente con un altro in tutte le distinte che lo usano.
 * Operazione classica di ingegneria (obsolescenza, second source) che senza
 * questo tool richiederebbe di trovare a mano ogni riga di distinta.
 */
export async function sostituisciComponente(
  client: ArasClient,
  vecchio: string,
  nuovo: string,
  dryRun: boolean
) {
  const trova = async (num: string) => {
    const r = await client.query<Record<string, unknown>>("Part", {
      filter: `item_number eq '${num.replace(/'/g, "''")}'`, select: ["id", "item_number"], top: 1,
    });
    return r.value[0] ?? null;
  };
  const v = await trova(vecchio);
  const n = await trova(nuovo);
  if (!v) return { sostituito: false, motivo: `Part "${vecchio}" inesistente.` };
  if (!n) return { sostituito: false, motivo: `Part "${nuovo}" inesistente.` };

  const righe = await client.queryAll<Record<string, unknown>>("Part BOM", {
    filter: `related_id eq '${v["id"]}'`,
    select: ["id", "source_id", "quantity"],
    top: 500,
  }, 2000);

  const impatti = await Promise.all(righe.value.map(async (r) => {
    const src = readItemRef(r, "source_id");
    return { rigaId: String(r["id"]), assieme: src?.keyedName ?? src?.id ?? "?", quantita: r["quantity"] };
  }));

  if (dryRun) {
    return {
      sostituito: false, modalita: "dryRun",
      da: vecchio, a: nuovo,
      righeInteressate: impatti.length,
      assiemi: impatti.map((x) => x.assieme),
      impatti,
    };
  }

  const fatte: string[] = [];
  const falliti: Array<{ assieme: string; motivo: string }> = [];
  for (const i of impatti) {
    try {
      await client.update("Part BOM", i.rigaId, { related_id: n["id"] });
      fatte.push(i.assieme);
    } catch (e) {
      falliti.push({ assieme: i.assieme, motivo: e instanceof Error ? e.message.slice(0, 140) : "errore" });
    }
  }
  return { sostituito: true, da: vecchio, a: nuovo, assiemiAggiornati: fatte, falliti: falliti.length ? falliti : undefined };
}

/** Aggiornamento massivo di elementi selezionati da un filtro. */
export async function aggiornamentoMassivo(
  client: ArasClient,
  itemType: string,
  filtro: string,
  valori: Record<string, unknown>,
  dryRun: boolean,
  massimo: number
) {
  const page = await client.query<Record<string, unknown>>(itemType, {
    filter: filtro, select: ["id", "item_number", "name"], top: massimo, count: true,
  });

  const elementi = page.value.map((x) => ({
    id: String(x["id"]),
    etichetta: String(x["item_number"] ?? x["name"] ?? x["id"]),
  }));

  if (dryRun) {
    return {
      aggiornati: 0, modalita: "dryRun",
      corrispondenti: page.count ?? elementi.length,
      interessati: elementi.length,
      elementi: elementi.slice(0, 50),
      valori,
      nota: (page.count ?? 0) > massimo
        ? `Attenzione: ${page.count} elementi corrispondono al filtro ma il limite e' ${massimo}.`
        : undefined,
    };
  }

  let ok = 0;
  const falliti: Array<{ elemento: string; motivo: string }> = [];
  for (const e of elementi) {
    try { await client.update(itemType, e.id, valori); ok++; }
    catch (err) { falliti.push({ elemento: e.etichetta, motivo: err instanceof Error ? err.message.slice(0, 140) : "errore" }); }
  }
  return { aggiornati: ok, suTotale: elementi.length, falliti: falliti.length ? falliti : undefined };
}

/** Sequenze di numerazione automatica configurate. */
export async function sequenze(client: ArasClient) {
  const page = await client.query<Record<string, unknown>>("Sequence", {
    select: ["id", "name", "prefix", "suffix", "current_value", "step", "pad_to"], orderby: "name", top: 100,
  });
  return page.value.map((s) => ({
    nome: s["name"],
    prossimo: `${s["prefix"] ?? ""}${Number(s["current_value"] ?? 0) + Number(s["step"] ?? 1)}${s["suffix"] ?? ""}`,
    valoreCorrente: s["current_value"],
    passo: s["step"],
  }));
}

/** Metodi server definiti, ricercabili per nome. */
export async function metodi(client: ArasClient, cerca: string | undefined, limite: number) {
  const filtro = cerca ? `contains(name,'${cerca.replace(/'/g, "''")}')` : undefined;
  const page = await client.query<Record<string, unknown>>("Method", {
    filter: filtro, select: ["id", "name", "method_type", "comments"], orderby: "name", top: limite, count: true,
  });
  return {
    totale: page.count ?? page.value.length,
    metodi: page.value.map((m) => ({ nome: m["name"], tipo: m["method_type"] ?? null, note: m["comments"] ?? null })),
  };
}

/** Esporta elementi in AML, il formato nativo di scambio di Aras. */
export async function esportaAml(
  aml: AmlClient,
  itemType: string,
  filtro: string | undefined,
  conRelazioni: boolean,
  massimo: number
) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const where = filtro ? ` where="${esc(filtro)}"` : "";
  const rel = conRelazioni ? `<Relationships><Item action="get"/></Relationships>` : "";
  const res = await aml.apply(
    `<Item type="${esc(itemType)}" action="get" maxRecords="${massimo}"${where}>${rel}</Item>`
  );
  return { itemType, elementi: res.items.length, aml: res.raw };
}
