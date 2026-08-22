import { ArasClient } from "./client.js";
import { AmlClient } from "./aml.js";
import { readItemRef } from "./odata.js";

/** Report configurati, con gli ItemType a cui sono agganciati. */
export async function elencoReport(client: ArasClient) {
  const [rep, legami] = await Promise.all([
    client.query<Record<string, unknown>>("Report", {
      select: ["id", "name", "label", "type", "target", "location"], orderby: "name", top: 200,
    }),
    client.query<Record<string, unknown>>("Item Report", {
      select: ["source_id", "related_id"], top: 200,
    }).catch(() => ({ value: [] as Array<Record<string, unknown>> })),
  ]);

  // Item Report lega un ItemType (source) a un Report (related).
  const perReport = new Map<string, string[]>();
  for (const l of legami.value) {
    const rep = readItemRef(l, "related_id");
    const tipo = readItemRef(l, "source_id");
    if (!rep) continue;
    const lista = perReport.get(rep.id) ?? [];
    if (tipo?.keyedName) lista.push(tipo.keyedName);
    perReport.set(rep.id, lista);
  }

  return rep.value.map((r) => ({
    id: r["id"],
    nome: r["name"],
    etichetta: r["label"] ?? null,
    tipo: r["type"] ?? null,
    ambito: r["target"] ?? null,
    perItemType: perReport.get(String(r["id"])) ?? [],
  }));
}

/**
 * Esegue un Report.
 *
 * Un Report Aras contiene in `report_query` la query AML da eseguire, con
 * eventuali segnaposto. Qui si legge la definizione e si esegue la query:
 * la trasformazione XSL, che serve solo alla resa grafica nel client, viene
 * ignorata perche' a un modello interessano i dati.
 */
export async function eseguiReport(
  client: ArasClient,
  aml: AmlClient,
  nome: string,
  contestoId: string | undefined,
  massimo: number
) {
  const r = await client.query<Record<string, unknown>>("Report", {
    filter: `name eq '${nome.replace(/'/g, "''")}'`,
    select: ["id", "name", "report_query", "method", "type", "target"], top: 1,
  });
  const rep = r.value[0];
  if (!rep) return null;

  let query = String(rep["report_query"] ?? "").trim();

  // Un Report puo' essere di due nature: con una query AML propria, oppure
  // delegato a un Method server. Nel secondo caso report_query e' vuoto e va
  // invocato il metodo, passando l'elemento di contesto come Item.
  if (!query) {
    const metodo = readItemRef(rep, "method");
    if (!metodo) {
      return { report: nome, eseguito: false, motivo: "Il report non ha ne' una query AML ne' un Method associato." };
    }
    const nomeMetodo = metodo.keyedName ?? metodo.id;
    try {
      const res = await aml.apply(
        `<Item type="Method" action="${String(nomeMetodo).replace(/"/g, "")}"` +
        (contestoId ? ` id="${contestoId}"` : "") + `/>`
      );
      return {
        report: nome, eseguito: true, via: `Method "${nomeMetodo}"`,
        elementi: res.items.length, risultati: res.items.slice(0, massimo),
      };
    } catch (e) {
      return {
        report: nome, eseguito: false, via: `Method "${nomeMetodo}"`,
        motivo: e instanceof Error ? e.message.slice(0, 250) : String(e),
        // Un Method di tipo JavaScript e' codice di CLIENT: gira nel browser di Aras
        // e non e' invocabile dal server, quindi nessun client esterno puo' eseguirlo.
        nota: /not supported: JavaScript/i.test(e instanceof Error ? e.message : "")
          ? "Questo report e' scritto in JavaScript di client: gira solo nell'interfaccia Aras, " +
            "non e' eseguibile da un client esterno. Usa aras_run_query o aras_get_bom per ottenere gli stessi dati."
          : "I report basati su Method possono richiedere un elemento di contesto specifico.",
      };
    }
  }

  // I report parametrici usano segnaposto per l'elemento di contesto.
  if (contestoId) {
    query = query.replace(/<!--\s*\$\{ID\}\s*-->|\$\{ID\}|@ID/g, contestoId);
  }

  try {
    const res = await aml.apply(query);
    return {
      report: nome,
      eseguito: true,
      elementi: res.items.length,
      risultati: res.items.slice(0, massimo),
    };
  } catch (e) {
    return {
      report: nome, eseguito: false,
      motivo: e instanceof Error ? e.message.slice(0, 250) : String(e),
      queryUsata: query.slice(0, 400),
      nota: contestoId ? undefined : "Molti report richiedono un elemento di contesto: prova a passare contestoId.",
    };
  }
}

/**
 * Catalogo dei messaggi di errore di Aras.
 *
 * L'ItemType `UserMessage` contiene i template di TUTTI i messaggi che il server
 * puo' restituire, con i segnaposto {0}, {1}. Serve a capire un errore opaco:
 * cercando parte del testo ricevuto si risale al codice e al significato.
 */
export async function cercaMessaggio(client: ArasClient, testo: string, limite: number) {
  const t = testo.replace(/'/g, "''");
  const page = await client.query<Record<string, unknown>>("UserMessage", {
    filter: `contains(name,'${t}') or contains(text,'${t}')`,
    select: ["id", "name", "text"], top: limite, count: true,
  });
  return {
    corrispondenti: page.count ?? page.value.length,
    messaggi: page.value.map((m) => ({ codice: m["name"], testo: m["text"] })),
  };
}

/** Ricerche salvate degli utenti. */
export async function ricercheSalvate(client: ArasClient) {
  const page = await client.query<Record<string, unknown>>("SavedSearch", {
    select: ["id", "itname", "label", "criteria", "show_on_toc"], top: 100,
  });
  return page.value.map((s) => ({
    nome: s["itname"] ?? s["label"] ?? s["id"],
    etichetta: s["label"] ?? null,
    inMenu: String(s["show_on_toc"]) === "1",
    criteri: String(s["criteria"] ?? "").slice(0, 300) || null,
  }));
}

/**
 * Delega un'attivita' di workflow a un'altra identita'.
 * Aras lo esprime come EvaluateActivity con DelegateTo valorizzato: e' la stessa
 * chiamata del voto, ma invece di percorrere una via passa il compito a qualcun altro.
 */
export async function delegaAttivita(
  client: ArasClient,
  aml: AmlClient,
  activityId: string,
  assignmentId: string,
  aIdentita: string,
  commenti: string | undefined,
  dryRun: boolean
) {
  const i = await client.query<Record<string, unknown>>("Identity", {
    filter: `name eq '${aIdentita.replace(/'/g, "''")}'`, select: ["id", "name"], top: 1,
  });
  const idnId = i.value[0]?.["id"] as string | undefined;
  if (!idnId) return { delegata: false, motivo: `Identita' "${aIdentita}" inesistente.` };

  // Anche la delega richiede una via: con <Paths/> vuoto Aras risponde
  // "The path is not specified". Si usa la via predefinita dell'attivita'.
  const paths = await client.query<Record<string, unknown>>("Workflow Process Path", {
    filter: `source_id eq '${activityId}'`, select: ["id", "name", "is_default"], orderby: "sort_order", top: 20,
  }).catch(() => ({ value: [] as Array<Record<string, unknown>> }));
  const via = paths.value.find((v) => String(v["is_default"]) === "1") ?? paths.value[0];

  if (dryRun) {
    return {
      delegata: false, modalita: "dryRun",
      attivita: activityId, assegnazione: assignmentId, a: aIdentita,
      viaUsata: via ? via["name"] : null,
      vieDisponibili: paths.value.map((v) => v["name"]),
    };
  }
  if (!via) {
    return { delegata: false, motivo: `L'attivita' non espone vie di uscita: la delega richiede un path.` };
  }

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  try {
    const res = await aml.apply(
      `<Item type="Activity" action="EvaluateActivity">` +
      `<Activity>${activityId}</Activity><ActivityAssignment>${assignmentId}</ActivityAssignment>` +
      `<Paths><Path id="${via["id"]}">${esc(String(via["name"]))}</Path></Paths>` +
      `<DelegateTo>${idnId}</DelegateTo>` +
      `<Tasks/><Variables/><Authentication mode=""/>` +
      `<Comments>${esc(commenti ?? "")}</Comments>` +
      // Obbligatorio anche per la delega: vedi avanzaModifica in changes.ts.
      `<Complete>1</Complete></Item>`
    );
    return { delegata: true, a: aIdentita, via: via["name"], risposta: res.items.slice(0, 3) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Aras verifica che chi delega appartenga all'identita' assegnataria: e' un
    // rifiuto legittimo, non un guasto. Si dice a chi e' assegnata l'attivita'.
    if (/not from allowed identity/i.test(msg)) {
      const asg = await client.query<Record<string, unknown>>("Activity Assignment", {
        filter: `source_id eq '${activityId}'`, select: ["related_id"], top: 20,
      }).catch(() => ({ value: [] as Array<Record<string, unknown>> }));
      const assegnatari = asg.value
        .map((a) => a["related_id@aras.keyed_name"] as string)
        .filter(Boolean);
      return {
        delegata: false,
        motivo: `L'utente corrente non appartiene all'identita' assegnataria dell'attivita'.`,
        assegnataA: assegnatari,
        rimedio: assegnatari.length
          ? `Iscrivi il tuo utente a "${assegnatari[0]}" con aras_manage_membership, oppure delega da un utente che ne fa parte.`
          : "Verifica le assegnazioni con aras_get_workflow.",
      };
    }
    throw e;
  }
}

/** Applica un pacchetto AML: l'inverso di aras_export_aml. */
export async function importaAml(aml: AmlClient, contenuto: string, dryRun: boolean) {
  const azioni = [...contenuto.matchAll(/action\s*=\s*"([^"]+)"/gi)].map((m) => m[1]!.toLowerCase());
  const elementi = (contenuto.match(/<Item\b/g) ?? []).length;
  const distruttive = azioni.filter((a) => ["delete", "purge"].includes(a));

  if (dryRun) {
    return {
      importato: false, modalita: "dryRun",
      elementiNelPacchetto: elementi,
      azioni: [...new Set(azioni)],
      azioniDistruttive: distruttive.length,
      nota: distruttive.length
        ? `Il pacchetto contiene ${distruttive.length} azioni distruttive (delete/purge): rivedilo prima di applicarlo.`
        : undefined,
    };
  }

  const res = await aml.apply(contenuto);
  return { importato: true, elementiRestituiti: res.items.length, risposta: res.items.slice(0, 10) };
}
