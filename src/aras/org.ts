import { ArasClient } from "./client.js";
import { AmlClient } from "./aml.js";

/**
 * Creazione di un utente: tre passi obbligati, non uno.
 *
 * Aras crea da se' un'Identity "alias" per ogni User (nome = "Nome Cognome",
 * is_alias=1) e ne ammette **una sola**: tentare di aggiungerne un'altra fallisce
 * con "The number of Alias relationships cannot be greater than 1". L'appartenenza
 * a un reparto o a un ruolo si esprime quindi con `Member`, dal gruppo verso
 * l'identita' alias dell'utente.
 */
export async function creaUtente(
  client: ArasClient,
  aml: AmlClient,
  dati: { login: string; nome: string; cognome: string; email?: string; azienda?: string },
  gruppi: string[]
) {
  const esistente = await client.query<Record<string, unknown>>("User", {
    filter: `login_name eq '${dati.login.replace(/'/g, "''")}'`, select: ["id"], top: 1,
  });
  if (esistente.value.length) {
    return { creato: false, motivo: `Esiste gia' un utente con login "${dati.login}".`, id: esistente.value[0]!["id"] };
  }

  const user = await client.create<Record<string, unknown>>("User", {
    login_name: dati.login,
    first_name: dati.nome,
    last_name: dati.cognome,
    ...(dati.email ? { email: dati.email } : {}),
    ...(dati.azienda ? { company_name: dati.azienda } : {}),
  });

  const nomeCompleto = `${dati.nome} ${dati.cognome}`.trim();
  const alias = await client.query<Record<string, unknown>>("Identity", {
    filter: `name eq '${nomeCompleto.replace(/'/g, "''")}'`, select: ["id", "name"], top: 1,
  });
  const aliasId = alias.value[0]?.["id"] as string | undefined;

  const aggiunti: string[] = [];
  const falliti: Array<{ gruppo: string; motivo: string }> = [];
  for (const g of gruppi) {
    if (!aliasId) { falliti.push({ gruppo: g, motivo: "identita' alias non trovata" }); continue; }
    const grp = await client.query<Record<string, unknown>>("Identity", {
      filter: `name eq '${g.replace(/'/g, "''")}'`, select: ["id"], top: 1,
    });
    const grpId = grp.value[0]?.["id"] as string | undefined;
    if (!grpId) { falliti.push({ gruppo: g, motivo: "gruppo inesistente" }); continue; }
    try {
      await client.create("Member", { source_id: grpId, related_id: aliasId });
      aggiunti.push(g);
    } catch (e) {
      falliti.push({ gruppo: g, motivo: e instanceof Error ? e.message.slice(0, 120) : "errore" });
    }
  }

  return {
    creato: true,
    id: user["id"],
    login: dati.login,
    identitaAlias: aliasId ? { id: aliasId, nome: nomeCompleto } : null,
    gruppiAggiunti: aggiunti,
    gruppiFalliti: falliti.length ? falliti : undefined,
  };
}

/** Crea un gruppo o ruolo (Identity non-alias), opzionalmente dentro un gruppo padre. */
export async function creaGruppo(
  client: ArasClient,
  nome: string,
  descrizione?: string,
  gruppoPadre?: string
) {
  const gia = await client.query<Record<string, unknown>>("Identity", {
    filter: `name eq '${nome.replace(/'/g, "''")}'`, select: ["id"], top: 1,
  });
  if (gia.value.length) {
    return { creato: false, motivo: `Esiste gia' un'identita' "${nome}".`, id: gia.value[0]!["id"] };
  }

  const g = await client.create<Record<string, unknown>>("Identity", {
    name: nome, ...(descrizione ? { description: descrizione } : {}),
  });

  let annidato: string | undefined;
  if (gruppoPadre) {
    const p = await client.query<Record<string, unknown>>("Identity", {
      filter: `name eq '${gruppoPadre.replace(/'/g, "''")}'`, select: ["id"], top: 1,
    });
    const pid = p.value[0]?.["id"] as string | undefined;
    if (pid) {
      await client.create("Member", { source_id: pid, related_id: g["id"] });
      annidato = gruppoPadre;
    }
  }
  return { creato: true, id: g["id"], nome, dentro: annidato };
}

/** Aggiunge o rimuove un'identita' da un gruppo. */
export async function gestisciAppartenenza(
  client: ArasClient,
  aml: AmlClient,
  gruppo: string,
  membro: string,
  azione: "aggiungi" | "rimuovi"
) {
  const trova = async (n: string) => {
    const r = await client.query<Record<string, unknown>>("Identity", {
      filter: `name eq '${n.replace(/'/g, "''")}'`, select: ["id", "name"], top: 1,
    });
    return r.value[0]?.["id"] as string | undefined;
  };
  const gid = await trova(gruppo);
  const mid = await trova(membro);
  if (!gid) return { fatto: false, motivo: `Gruppo "${gruppo}" inesistente.` };
  if (!mid) return { fatto: false, motivo: `Identita' "${membro}" inesistente.` };

  const righe = await client.query<Record<string, unknown>>("Member", {
    filter: `source_id eq '${gid}'`, select: ["id", "related_id"], top: 500,
  });
  const riga = righe.value.find((r) => (r["related_id@aras.id"] as string) === mid);

  if (azione === "aggiungi") {
    if (riga) return { fatto: false, motivo: `"${membro}" e' gia' membro di "${gruppo}".` };
    await client.create("Member", { source_id: gid, related_id: mid });
    return { fatto: true, azione, gruppo, membro };
  }
  if (!riga) return { fatto: false, motivo: `"${membro}" non e' membro di "${gruppo}".` };
  await aml.apply(`<Item type="Member" id="${riga["id"]}" action="delete"/>`);
  return { fatto: true, azione, gruppo, membro };
}
