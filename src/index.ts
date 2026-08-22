#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./aras/config.js";
import { ArasClient, ArasError } from "./aras/client.js";
import { SchemaCache, SYSTEM_MANAGED } from "./aras/schema.js";
import { explodeBom, BomNode } from "./aras/bom.js";
import { whereUsed, documentsOf, amlOf, changeImpact, membersOf, filesOf, WhereUsedNode } from "./aras/graph.js";
import { AmlClient } from "./aras/aml.js";
import { readItemRef } from "./aras/odata.js";
import { crossSearch, DEFAULT_SEARCH_TYPES } from "./aras/search.js";
import { revisionsOf, newRevision, planDelete } from "./aras/revisions.js";
import { workflowOf, activitiesOf, inBasketOf } from "./aras/workflow.js";
import { historyOf, validaAllaData } from "./aras/history.js";
import { mappaCicloVita, statiDisponibili, identitaCorrenti, percorso } from "./aras/lifecycle.js";
import { creaUtente, creaGruppo, gestisciAppartenenza } from "./aras/org.js";
import { leggiLogFile, leggiSystemEventLog } from "./aras/syslog.js";
import { ListCache } from "./aras/lists.js";
import { creaPart, creaDocumento, gestisciRigaBom, copiaPart, aggiungiManufacturerPart, componentiNonRilasciati } from "./aras/product.js";
import { creaModifica, aggiungiImpattato, avanzaModifica } from "./aras/changes.js";
import { creaItemType, aggiungiProprieta } from "./aras/schema-admin.js";
import { cruscotti, metriche, grafici, querySalvate, descriviQuery, eseguiQuery, configEffettivita, creaModello } from "./aras/analytics.js";
import { dettaglioPermesso, concediPermesso, sostituisciComponente, aggiornamentoMassivo, sequenze, metodi, esportaAml } from "./aras/admin-ops.js";
import { elencoReport, eseguiReport, cercaMessaggio, ricercheSalvate, delegaAttivita, importaAml } from "./aras/reports.js";

const cfg = loadConfig();
const client = new ArasClient(cfg);
const schema = new SchemaCache(client);
const aml = new AmlClient(cfg, client.tokens);
const lists = new ListCache(client, aml);

const server = new McpServer({ name: "aras-plm-mcp", version: "0.1.0" });

/** Ogni tool passa di qui: un errore Aras diventa testo utile, non uno stack trace. */
async function guard(fn: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await fn() }] };
  } catch (e) {
    const msg = e instanceof ArasError ? e.message : e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text" as const, text: `Errore: ${msg}` }], isError: true };
  }
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

// ---------------------------------------------------------------- connessione

server.tool(
  "aras_ping",
  "Verifica la connessione ad Aras Innovator e restituisce database, utente e numero di ItemType. Da usare per primo se qualcosa non funziona.",
  {},
  async () =>
    guard(async () => {
      const info = await client.ping();
      return json({ ...info, url: cfg.baseUrl, readOnly: cfg.readOnly });
    })
);

// ----------------------------------------------------------------- discovery

server.tool(
  "aras_list_item_types",
  "Elenca gli ItemType disponibili in Aras. L'istanza ne ha centinaia, quindi filtra con 'search' " +
    "(ricerca tollerante su nome ed etichetta) oppure con 'kind'. Usalo PRIMA di interrogare dati, " +
    "per scoprire il nome esatto del tipo.",
  {
    search: z.string().optional().describe("Termine di ricerca, es. 'part', 'change', 'bom'"),
    kind: z
      .enum(["domain", "relationship", "all"])
      .default("domain")
      .describe("domain = oggetti di business, relationship = relazioni, all = entrambi"),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async ({ search, kind, limit }) =>
    guard(async () => {
      let list = search ? await schema.searchItemTypes(search, 500) : await schema.allItemTypes();
      if (kind === "domain") list = list.filter((t) => !t.isRelationship);
      else if (kind === "relationship") list = list.filter((t) => t.isRelationship);

      const shown = list.slice(0, limit);
      return json({
        totale: list.length,
        mostrati: shown.length,
        itemTypes: shown.map((t) => ({
          name: t.name,
          label: t.label,
          relazione: t.isRelationship,
          versionabile: t.isVersionable,
        })),
      });
    })
);

server.tool(
  "aras_describe_item_type",
  "Restituisce lo schema completo di un ItemType: tutte le proprieta' con tipo di dato e obbligatorieta', " +
    "piu' le relazioni che partono da esso. Da usare PRIMA di scrivere query o di creare elementi, " +
    "cosi' non devi indovinare i nomi delle proprieta'.",
  {
    itemType: z.string().describe("Nome esatto dell'ItemType, es. 'Part', 'Document', 'ECN'"),
  },
  async ({ itemType }) =>
    guard(async () => {
      const info = await schema.findItemType(itemType);
      if (!info) {
        const near = await schema.searchItemTypes(itemType, 8);
        return json({
          errore: `ItemType "${itemType}" inesistente.`,
          forseCercavi: near.map((t) => t.name),
        });
      }
      const [props, rels] = await Promise.all([
        schema.propertiesOf(info.name),
        schema.relationshipsOf(info.name),
      ]);
      return json({
        itemType: info.name,
        label: info.label,
        versionabile: info.isVersionable,
        // Solo quelle che deve fornire il chiamante: le altre le riempie Aras.
        daFornireAllaCreazione: props
          .filter((p) => p.required && !SYSTEM_MANAGED.has(p.name))
          .map((p) => p.name),
        gestiteDaAras: props.filter((p) => p.required && SYSTEM_MANAGED.has(p.name)).map((p) => p.name),
        proprieta: props.map((p) => ({
          name: p.name,
          tipo: p.dataType,
          obbligatoria: p.required,
          label: p.label,
        })),
        relazioni: rels.map((r) => ({ name: r.name, verso: r.relatedItemType, label: r.label })),
      });
    })
);

// --------------------------------------------------------------------- query

server.tool(
  "aras_query_items",
  "Interroga elementi di un ItemType con sintassi OData. Se non sei sicuro dei nomi delle proprieta', " +
    "chiama prima aras_describe_item_type.",
  {
    itemType: z.string().describe("es. 'Part'"),
    filter: z
      .string()
      .optional()
      .describe("Filtro OData, es. \"item_number eq 'P-1000'\" oppure \"contains(name,'motor')\""),
    select: z.array(z.string()).optional().describe("Proprieta' da restituire; omesso = tutte"),
    orderby: z.string().optional().describe("es. 'item_number asc'"),
    top: z.number().int().min(1).max(500).default(25),
    skip: z.number().int().min(0).default(0),
  },
  async ({ itemType, filter, select, orderby, top, skip }) =>
    guard(async () => {
      const page = await client.query<Record<string, unknown>>(itemType, {
        filter,
        select,
        orderby,
        top,
        skip,
        count: true,
      });
      return json({
        itemType,
        totaleCorrispondenti: page.count,
        restituiti: page.value.length,
        items: page.value,
      });
    })
);

server.tool(
  "aras_get_item",
  "Recupera un singolo elemento tramite il suo id Aras (GUID a 32 caratteri).",
  {
    itemType: z.string(),
    id: z.string().describe("id dell'elemento"),
    select: z.array(z.string()).optional(),
  },
  async ({ itemType, id, select }) =>
    guard(async () => json(await client.getById(itemType, id, select)))
);

// ------------------------------------------------------------- relazioni/BOM

server.tool(
  "aras_get_relationships",
  "Restituisce le righe di una relazione a partire da un elemento sorgente, es. i documenti allegati " +
    "a una Part ('Part Document') o le modifiche che la riguardano ('Part Changes'). " +
    "Usa aras_describe_item_type per scoprire quali relazioni esistono.",
  {
    relationshipType: z.string().describe("es. 'Part Document', 'Part CAD'"),
    sourceId: z.string().describe("id dell'elemento di partenza"),
    top: z.number().int().min(1).max(500).default(100),
  },
  async ({ relationshipType, sourceId, top }) =>
    guard(async () => {
      // $select con related_id e' OBBLIGATORIO: senza, Aras non emette le annotazioni
      // related_id@aras.* e le righe tornano prive di qualunque riferimento — utili
      // quanto una lista di id opachi. Si aggiungono le proprieta' proprie della
      // relazione (quantity, reference_designator...) leggendole dallo schema.
      // Le proprieta' vengono in ordine alfabetico: troncare le prime N taglierebbe
      // proprio quelle che contano (quantity finisce dopo new_version e not_lockable).
      // Si escludono quindi per nome tutte quelle di servizio, senza limitare a priori.
      const RUMORE = new Set([
        "source_id", "related_id", "sort_order", "behavior", "new_version", "not_lockable",
        "is_current", "is_released", "generation", "major_rev", "minor_rev", "keyed_name",
        "css", "classification", "config_id", "locked_by_id", "itemtype",
        "external_id", "external_owner", "external_type",
      ]);
      const props = await schema.propertiesOf(relationshipType).catch(() => []);
      const proprie = props
        .map((p) => p.name)
        .filter((n) => !SYSTEM_MANAGED.has(n) && !RUMORE.has(n))
        .slice(0, 15);

      const page = await client.query<Record<string, unknown>>(relationshipType, {
        filter: `source_id eq '${sourceId}'`,
        select: ["id", "related_id", ...proprie],
        top,
        count: true,
      });

      const righe = page.value.map((r) => {
        const ref = readItemRef(r, "related_id");
        const extra: Record<string, unknown> = {};
        for (const p of proprie) if (r[p] !== undefined && r[p] !== null) extra[p] = r[p];
        return { rigaId: r["id"], verso: ref?.keyedName ?? null, versoId: ref?.id ?? null, ...extra };
      });

      return json({ relationshipType, sourceId, totale: page.count, righe });
    })
);

server.tool(
  "aras_get_bom",
  "Esplode la distinta base (BOM) di una Part in modo ricorsivo, restituendo l'albero dei componenti " +
    "con quantita' e quantita' cumulate. E' il modo corretto di rispondere a domande tipo " +
    "'da cosa e' composto questo prodotto' o 'quanti pezzi di X servono in totale'.",
  {
    partId: z.string().describe("id della Part radice"),
    depth: z.number().int().min(1).max(10).default(3).describe("Livelli di esplosione"),
  },
  async ({ partId, depth }) =>
    guard(async () => {
      const tree = await explodeBom(client, partId, depth);
      const flat: Array<{ item_number: string; livello: number; qtaCumulata: number }> = [];
      const walk = (n: BomNode, lvl: number) => {
        flat.push({ item_number: n.itemNumber, livello: lvl, qtaCumulata: n.cumulativeQty });
        n.children.forEach((c) => walk(c, lvl + 1));
      };
      tree.children.forEach((c) => walk(c, 1));
      return json({ radice: tree.itemNumber, profondita: depth, albero: tree, distintaPiatta: flat });
    })
);

// ----------------------------------------------------------------- scrittura

server.tool(
  "aras_create_item",
  "Crea un nuovo elemento. Le proprieta' vengono validate contro lo schema reale prima dell'invio. " +
    "Disabilitato se il server e' in sola lettura (ARAS_READONLY).",
  {
    itemType: z.string(),
    properties: z.record(z.unknown()).describe("Coppie proprieta'/valore, es. { item_number: 'P-1000', name: 'Vite' }"),
    dryRun: z.boolean().default(false).describe("Se true, valida soltanto e non scrive"),
  },
  async ({ itemType, properties, dryRun }) =>
    guard(async () => {
      const check = await schema.validateProperties(itemType, properties);
      if (!check.ok) {
        return json({
          scritto: false,
          motivo: "Le proprieta' non corrispondono allo schema",
          proprietaSconosciute: check.unknown,
          obbligatorieMancanti: check.missingRequired,
          suggerimento: `Chiama aras_describe_item_type con itemType="${itemType}"`,
        });
      }
      if (dryRun) return json({ scritto: false, validazione: "ok", anteprima: properties });
      const created = await client.create<Record<string, unknown>>(itemType, properties);
      return json({ scritto: true, item: created });
    })
);

server.tool(
  "aras_update_item",
  "Aggiorna le proprieta' di un elemento esistente. Validato contro lo schema. " +
    "ATTENZIONE: su un ItemType versionabile (Part, Document, CAD) Aras crea una NUOVA " +
    "GENERAZIONE a ogni update — anche solo per correggere una descrizione. Verificalo con " +
    "aras_get_revisions prima e dopo se lo storico revisioni ti interessa. " +
    "Disabilitato se il server e' in sola lettura.",
  {
    itemType: z.string(),
    id: z.string(),
    properties: z.record(z.unknown()),
    dryRun: z.boolean().default(false),
  },
  async ({ itemType, id, properties, dryRun }) =>
    guard(async () => {
      const check = await schema.validateProperties(itemType, properties);
      if (check.unknown.length) {
        return json({
          aggiornato: false,
          proprietaSconosciute: check.unknown,
          suggerimento: `Chiama aras_describe_item_type con itemType="${itemType}"`,
        });
      }
      if (dryRun) return json({ aggiornato: false, validazione: "ok", anteprima: properties });
      const updated = await client.update<Record<string, unknown>>(itemType, id, properties);
      return json({ aggiornato: true, item: updated });
    })
);

server.tool(
  "aras_search",
  "Ricerca trasversale su piu' ItemType contemporaneamente: cerca un termine nei campi " +
    "testuali (codice, nome, descrizione, titolo) di Part, Document, CAD, ECR, ECN, fornitori. " +
    "Da usare quando NON sai in che tipo si trovi cio' che cerchi â€” Aras non ha una ricerca globale.",
  {
    term: z.string().min(1).describe("Termine da cercare, es. 'girante', 'PMP-21', 'cavitazione'"),
    itemTypes: z
      .array(z.string())
      .optional()
      .describe(`Tipi da interrogare; default: ${DEFAULT_SEARCH_TYPES.join(", ")}`),
    perType: z.number().int().min(1).max(100).default(10).describe("Massimo risultati per tipo"),
  },
  async ({ term, itemTypes, perType }) =>
    guard(async () => {
      const tipi = itemTypes?.length ? itemTypes : DEFAULT_SEARCH_TYPES;
      const { hits, interrogati, ignorati } = await crossSearch(client, schema, term, tipi, perType);
      return json({
        termine: term,
        tipiInterrogati: interrogati,
        tipiIgnorati: ignorati.length ? ignorati : undefined,
        risultati: hits.length,
        hits,
      });
    })
);

server.tool(
  "aras_create_relationship",
  "Crea una riga di relazione fra due elementi (es. 'Part Document', 'Part BOM'). " +
    "Supporta anche gli elementi DIPENDENTI, che in Aras non possono essere creati prima: " +
    "passa dependentProperties invece di relatedId e l'elemento viene creato inline dentro la " +
    "relazione. E' l'unico modo di collegare un Affected Item a una ECR/ECN. " +
    "Disabilitato in sola lettura.",
  {
    relationshipType: z.string().describe("es. 'Part Document', 'ECR Affected Item'"),
    sourceId: z.string().describe("id dell'elemento di partenza"),
    relatedId: z.string().optional().describe("id dell'elemento gia' esistente da collegare"),
    dependentProperties: z
      .record(z.unknown())
      .optional()
      .describe(`Per elementi dipendenti, es. { affected_id: "<id Part>", affected_type: "Part" }`),
    properties: z.record(z.unknown()).optional().describe("Proprieta' sulla riga di relazione, es. { quantity: '4' }"),
  },
  async ({ relationshipType, sourceId, relatedId, dependentProperties, properties }) =>
    guard(async () => {
      if (!relatedId && !dependentProperties) {
        return json({
          creata: false,
          motivo: "Serve relatedId (elemento esistente) oppure dependentProperties (elemento dipendente).",
        });
      }
      const body: Record<string, unknown> = { source_id: sourceId, ...(properties ?? {}) };
      // related_id come oggetto = crea l'elemento dipendente insieme alla relazione.
      body["related_id"] = relatedId ?? dependentProperties;

      const created = await client.create<Record<string, unknown>>(relationshipType, body);
      return json({
        creata: true,
        relationshipType,
        modo: relatedId ? "collegamento a elemento esistente" : "elemento dipendente creato inline",
        riga: created,
      });
    })
);

// ------------------------------------------------- navigazione di dominio

server.tool(
  "aras_where_used",
  "Where-used: risale la distinta e trova TUTTI gli assiemi che usano un componente, " +
    "a qualunque livello. E' la domanda da fare prima di modificare o dismettere un pezzo " +
    "('se cambio questa vite, cosa impatto?'). E' l'inverso di aras_get_bom.",
  {
    partId: z.string().describe("id della Part componente"),
    depth: z.number().int().min(1).max(10).default(5).describe("Livelli di risalita"),
  },
  async ({ partId, depth }) =>
    guard(async () => {
      const tree = await whereUsed(client, partId, depth);
      const assiemi: Array<{ item_number: string; livello: number; qtaImpiegata: number }> = [];
      const walk = (n: WhereUsedNode) => {
        for (const p of n.parents) {
          assiemi.push({ item_number: p.itemNumber, livello: p.livello, qtaImpiegata: p.qty });
          walk(p);
        }
      };
      walk(tree);
      return json({
        componente: tree.itemNumber,
        usatoIn: assiemi.length,
        assiemi,
        albero: tree,
      });
    })
);

server.tool(
  "aras_get_documents",
  "Tutta la documentazione di una Part: Document (disegni, specifiche, manuali) e modelli CAD " +
    "in una sola chiamata. In Aras sono due relazioni distinte ma rispondono alla stessa domanda.",
  { partId: z.string() },
  async ({ partId }) => guard(async () => json(await documentsOf(client, partId)))
);

server.tool(
  "aras_get_files",
  "File fisici allegati a un Document o a un CAD, con nome, dimensione, MIME type e URL di " +
    "download dal vault. NOTA: il caricamento di file NON e' possibile da un client esterno — " +
    "Aras rifiuta la creazione di File senza contenuto vaultato ('File Item cannot be added'), " +
    "e le vie documentate sono solo JavaScript di client o C# di server. I file vanno caricati " +
    "dall'interfaccia Aras; da qui si leggono e si scaricano.",
  {
    itemType: z.enum(["Document", "CAD"]),
    id: z.string().describe("id del Document o del CAD"),
  },
  async ({ itemType, id }) =>
    guard(async () => {
      const files = await filesOf(client, itemType, id, cfg.baseUrl, cfg.database);
      return json({
        itemType, id,
        relazione: itemType === "Document" ? "Document File" : "CADFiles",
        allegati: files.length,
        files,
        nota: files.length ? undefined : "Nessun file allegato. Caricali dall'interfaccia Aras.",
      });
    })
);

server.tool(
  "aras_get_aml",
  "Costruttori approvati (Approved Manufacturer List) per una Part: i Manufacturer Part " +
    "omologati e il relativo costruttore. Serve per acquisti e per valutare second source.",
  { partId: z.string() },
  async ({ partId }) =>
    guard(async () => {
      const lista = await amlOf(client, partId);
      return json({ partId, costruttoriApprovati: lista.length, aml: lista });
    })
);

server.tool(
  "aras_get_change_impact",
  "Elementi realmente impattati da una modifica (ECR o ECN), risolvendo gli Affected Item. " +
    "In Aras la relazione non punta alla Part ma a un oggetto intermedio, quindi una query " +
    "diretta restituirebbe solo id opachi.",
  {
    changeType: z.enum(["ECR", "ECN"]),
    changeId: z.string().describe("id della ECR/ECN"),
  },
  async ({ changeType, changeId }) =>
    guard(async () => {
      const impatti = await changeImpact(client, changeType, changeId);
      return json({ changeType, changeId, elementiImpattati: impatti.length, impatti });
    })
);

server.tool(
  "aras_get_identity_members",
  "Membri di un'identita' Aras (reparto, gruppo, ruolo): utenti e sotto-gruppi. " +
    "Usa aras_query_items su 'Identity' per trovare l'id del reparto.",
  { identityId: z.string() },
  async ({ identityId }) =>
    guard(async () => {
      const membri = await membersOf(client, identityId);
      return json({ identityId, membri: membri.length, elenco: membri });
    })
);

// ------------------------------------------------ storico ed effettivita'

server.tool(
  "aras_get_history",
  "Traccia di audit di un elemento: chi ha fatto cosa e quando, attraverso tutte le revisioni. " +
    "Aras lega lo storico al config_id tramite un History Container, non all'id della singola " +
    "generazione, quindi copre l'intera vita dell'oggetto.",
  {
    itemType: z.string().describe("es. 'Part', 'ECR'"),
    id: z.string(),
    limite: z.number().int().min(1).max(200).default(50),
  },
  async ({ itemType, id, limite }) =>
    guard(async () => {
      const { containerId, voci, nota } = await historyOf(client, itemType, id, limite);
      return json({
        itemType, id, containerId,
        eventi: voci.length,
        azioni: [...new Set(voci.map((v) => v.azione))],
        storico: voci,
        nota,
      });
    })
);

server.tool(
  "aras_check_effectivity",
  "Verifica se una Part era valida a una certa data, in base a effective_date e superseded_date. " +
    "E' l'effettivita' basata sulle date, quella che Aras popola sempre. Per l'effettivita' " +
    "configurabile per modello/unita' usa aras_get_effectivity_config.",
  {
    partIds: z.array(z.string()).min(1).describe("id delle Part da verificare"),
    data: z.string().describe("Data in formato ISO, es. '2026-01-15'"),
  },
  async ({ partIds, data }) =>
    guard(async () => {
      const quando = new Date(data);
      if (Number.isNaN(quando.getTime())) {
        return json({ errore: `Data non interpretabile: "${data}". Usa il formato ISO, es. 2026-01-15.` });
      }
      const esiti = await Promise.all(partIds.map(async (pid) => {
        try {
          const p = await client.getById<Record<string, unknown>>("Part", pid,
            ["id", "item_number", "name", "effective_date", "superseded_date", "state", "is_released"]);
          const v = validaAllaData(p, quando);
          return {
            id: pid, item_number: p["item_number"], name: p["name"],
            stato: p["state"], rilasciata: String(p["is_released"]) === "1",
            ...v,
          };
        } catch (e) {
          return { id: pid, valida: false, motivo: e instanceof Error ? e.message.slice(0, 120) : "non leggibile" };
        }
      }));
      return json({
        data,
        verificate: esiti.length,
        valide: esiti.filter((e) => e.valida).length,
        esiti,
      });
    })
);

// --------------------------------------------------- workflow e InBasket

server.tool(
  "aras_get_workflow",
  "Processo di workflow di un elemento (ECR, ECN, Part...) con tutte le attivita', il loro " +
    "stato e a chi sono assegnate. E' il modo di rispondere a 'a che punto e' questa modifica' " +
    "e 'chi la sta bloccando'. Aras istanzia il processo automaticamente alla creazione.",
  {
    itemId: z.string().describe("id dell'elemento, es. una ECR"),
    conAttivita: z.boolean().default(true).describe("Include le attivita' e le assegnazioni"),
  },
  async ({ itemId, conAttivita }) =>
    guard(async () => {
      const processi = await workflowOf(client, itemId);
      if (!processi.length) {
        return json({ itemId, processi: 0, nota: "Nessun workflow associato a questo elemento." });
      }
      if (!conAttivita) return json({ itemId, processi });

      const dettaglio = await Promise.all(processi.map(async (p) => {
        const att = await activitiesOf(client, p.id);
        const aperte = att.filter((a) => !a.chiusaIl);
        return {
          ...p,
          attivita: att.length,
          attivitaAperte: aperte.map((a) => a.nome),
          inCaricoA: [...new Set(aperte.flatMap((a) =>
            a.assegnazioni.filter((s) => !s.chiusaIl).map((s) => s.identita).filter(Boolean)))],
          dettaglioAttivita: att,
        };
      }));
      return json({ itemId, processi: dettaglio });
    })
);

server.tool(
  "aras_get_inbasket",
  "Attivita' in carico a un'identita' (utente o gruppo): l'equivalente dell'InBasket di Aras. " +
    "Trova prima l'id dell'identita' con aras_query_items su 'Identity'.",
  {
    identityId: z.string().describe("id dell'Identity (utente o reparto)"),
    soloAperte: z.boolean().default(true).describe("Solo le assegnazioni non ancora chiuse"),
  },
  async ({ identityId, soloAperte }) =>
    guard(async () => {
      const compiti = await inBasketOf(client, identityId, soloAperte);
      return json({
        identityId,
        compiti: compiti.length,
        inRitardo: compiti.filter((c) => c.inRitardo).length,
        elenco: compiti,
      });
    })
);

server.tool(
  "aras_vote_activity",
  "Completa un'attivita' di workflow scegliendo una via di uscita (es. 'Approve', 'Reject'). " +
    "Passa da AML EvaluateActivity. Usa aras_get_workflow per trovare attivita' e assegnazione. " +
    "Disabilitato in sola lettura.",
  {
    activityId: z.string(),
    assignmentId: z.string().describe("id della Activity Assignment su cui si vota"),
    path: z.string().describe("Nome della via di uscita, es. 'Approve'"),
    commenti: z.string().optional(),
  },
  async ({ activityId, assignmentId, path, commenti }) =>
    guard(async () => {
      if (cfg.readOnly) {
        return json({ votato: false, motivo: "Server in sola lettura. Imposta ARAS_READONLY=false." });
      }
      // Aras vuole l'ID della via, non il nome: col nome risponde
      // "An internal error has occured". Si risolve sulle vie dell'attivita'.
      const vie = await client.query<Record<string, unknown>>("Workflow Process Path", {
        filter: `source_id eq '${activityId}'`, select: ["id", "name", "is_default"], orderby: "sort_order", top: 20,
      }).catch(() => ({ value: [] as Array<Record<string, unknown>> }));
      const scelta = vie.value.find((v) => String(v["name"]).toLowerCase() === path.toLowerCase())
        ?? (vie.value.length === 1 ? vie.value[0] : vie.value.find((v) => String(v["is_default"]) === "1"));
      if (!scelta) {
        return json({
          votato: false,
          motivo: `Via "${path}" inesistente su questa attivita'.`,
          vieDisponibili: vie.value.map((v) => v["name"]),
        });
      }

      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const r = await aml.apply(
        `<Item type="Activity" action="EvaluateActivity">` +
        `<Activity>${esc(activityId)}</Activity>` +
        `<ActivityAssignment>${esc(assignmentId)}</ActivityAssignment>` +
        `<Paths><Path id="${scelta["id"]}">${esc(String(scelta["name"]))}</Path></Paths>` +
        `<DelegateTo>0</DelegateTo>` +
        `<Tasks/><Variables/><Authentication mode=""/>` +
        `<Comments>${esc(commenti ?? "")}</Comments>` +
        // Obbligatorio: senza, Aras risponde con un generico "internal error".
        `<Complete>1</Complete>` +
        `</Item>`
      );
      return json({ votato: true, via: scelta["name"], risposta: r.items.slice(0, 3) });
    })
);

// ------------------------------------------------- revisioni e versioning

server.tool(
  "aras_get_revisions",
  "Storia completa delle revisioni di un elemento versionabile: tutte le generazioni con " +
    "revisione, stato, chi la tiene bloccata e quale e' la corrente. In Aras le generazioni " +
    "sono righe distinte con id diversi che condividono config_id, e una query normale " +
    "restituisce solo quella corrente: qui le vedi tutte.",
  {
    itemType: z.string().describe("es. 'Part', 'Document'"),
    id: z.string().describe("id di una qualsiasi generazione"),
  },
  async ({ itemType, id }) =>
    guard(async () => {
      const { configId, revisioni } = await revisionsOf(client, aml, itemType, id);
      return json({
        itemType,
        configId,
        generazioni: revisioni.length,
        corrente: revisioni.find((r) => r.isCurrent)?.majorRev ?? null,
        revisioni,
      });
    })
);

server.tool(
  "aras_new_revision",
  "Crea una nuova generazione (revisione) di un elemento versionabile, eseguendo la sequenza " +
    "lock -> version -> unlock richiesta da Aras. Disabilitato in sola lettura.",
  { itemType: z.string(), id: z.string() },
  async ({ itemType, id }) =>
    guard(async () => {
      if (cfg.readOnly) {
        return json({ creata: false, motivo: "Server in sola lettura. Imposta ARAS_READONLY=false." });
      }
      const r = await newRevision(aml, itemType, id);
      return json({ creata: !!r.nuovaGenerazione, ...r });
    })
);

server.tool(
  "aras_plan_delete",
  "ANALIZZA cosa comporterebbe cancellare un elemento, SENZA cancellarlo: quante generazioni " +
    "sparirebbero, se e' rilasciato, se e' bloccato, e in quali relazioni e' ancora referenziato. " +
    "Da chiamare SEMPRE prima di cancellare. Distingue purge (una generazione) da delete (tutte).",
  {
    itemType: z.string(),
    id: z.string(),
    modo: z.enum(["purge", "delete"]).default("purge")
      .describe("purge = solo questa generazione; delete = tutte le generazioni"),
    relazioni: z.array(z.string()).optional()
      .describe("Relazioni da controllare; default: le relazioni note dell'ItemType"),
  },
  async ({ itemType, id, modo, relazioni }) =>
    guard(async () => {
      let daControllare = relazioni;
      if (!daControllare?.length) {
        // Senza indicazioni si controllano le relazioni che partono dal tipo stesso.
        const rels = await schema.relationshipsOf(itemType).catch(() => []);
        daControllare = rels.map((r) => r.name).slice(0, 12);
      }
      const piano = await planDelete(client, aml, itemType, id, modo, daControllare);
      return json({
        itemType, id, ...piano,
        nota: piano.eseguibile
          ? "Nessun impedimento rilevato."
          : "Risolvi le avvertenze prima di procedere: la cancellazione e' irreversibile.",
      });
    })
);

server.tool(
  "aras_delete_item",
  "Cancella un elemento. RICHIEDE conferma esplicita e il modo desiderato. " +
    "purge elimina solo la generazione indicata, delete elimina TUTTE le generazioni. " +
    "Chiama prima aras_plan_delete. Disabilitato in sola lettura.",
  {
    itemType: z.string(),
    id: z.string(),
    modo: z.enum(["purge", "delete"]).describe("purge = una generazione; delete = tutte"),
    conferma: z.boolean().describe("Deve essere true: conferma di aver valutato l'impatto"),
    ignoraAvvertenze: z.boolean().default(false)
      .describe("Procede anche se aras_plan_delete segnala avvertenze"),
  },
  async ({ itemType, id, modo, conferma, ignoraAvvertenze }) =>
    guard(async () => {
      if (cfg.readOnly) {
        return json({ cancellato: false, motivo: "Server in sola lettura. Imposta ARAS_READONLY=false." });
      }
      if (!conferma) {
        return json({ cancellato: false, motivo: "Serve conferma esplicita (conferma=true)." });
      }
      const rels = await schema.relationshipsOf(itemType).catch(() => []);
      const piano = await planDelete(client, aml, itemType, id, modo, rels.map((r) => r.name).slice(0, 12));
      if (!piano.eseguibile && !ignoraAvvertenze) {
        return json({
          cancellato: false,
          motivo: "Avvertenze non risolte. Rivedi il piano, oppure passa ignoraAvvertenze=true.",
          piano,
        });
      }
      await aml.apply(`<Item type="${itemType}" id="${id}" action="${modo}"/>`);
      return json({ cancellato: true, modo, effetto: piano.effetto, avvertenzeIgnorate: piano.avvertenze });
    })
);

// ------------------------------------------------------ lifecycle e AML

server.tool(
  "aras_get_lifecycle_state",
  "Stato attuale di un elemento, stati verso cui l'utente corrente PUO' promuoverlo, e — se " +
    "non puo' — quale ruolo gli manca. In Aras ogni transizione ha un ruolo richiesto: se non " +
    "lo possiedi, getItemNextStates torna vuoto e promoteItem fallisce con un messaggio che " +
    "sembra dire 'transizione inesistente' mentre e' un problema di autorizzazione.",
  {
    itemType: z.string().describe("es. 'Part', 'ECR'"),
    id: z.string(),
  },
  async ({ itemType, id }) =>
    guard(async () => {
      const item = await client.getById<Record<string, unknown>>(itemType, id,
        ["id", "state", "is_released", "major_rev"]);
      const stato = String(item["state"] ?? "");

      const [disponibili, mappa, mie] = await Promise.all([
        statiDisponibili(aml, itemType, id),
        mappaCicloVita(aml, itemType),
        identitaCorrenti(client),
      ]);

      // Cio' che il grafo prevede da qui, indipendentemente da chi chiede.
      const teoriche = (mappa?.transizioni ?? []).filter((t) => t.da === stato);
      const bloccate = teoriche.filter((t) => !disponibili.includes(t.a));

      return json({
        itemType,
        statoAttuale: stato,
        rilasciato: String(item["is_released"]) === "1",
        revisione: item["major_rev"] ?? null,
        promuovibileA: disponibili,
        transizioniPreviste: teoriche.map((t) => ({ verso: t.a, ruoloRichiesto: t.ruoloRichiesto })),
        tueIdentita: mie,
        bloccate: bloccate.length
          ? bloccate.map((t) => ({
              verso: t.a,
              ruoloRichiesto: t.ruoloRichiesto,
              nota: `Serve l'identita' "${t.ruoloRichiesto}". Aggiungi il tuo utente a quel gruppo con aras_manage_membership.`,
            }))
          : undefined,
      });
    })
);

server.tool(
  "aras_get_lifecycle_map",
  "Grafo completo di un ciclo di vita: tutti gli stati e tutte le transizioni con il ruolo " +
    "richiesto da ciascuna. Serve per capire quali percorsi esistono e chi puo' percorrerli.",
  { nomeMappa: z.string().describe("Nome della Life Cycle Map, es. 'Part', 'ECR', 'Document'") },
  async ({ nomeMappa }) =>
    guard(async () => {
      const m = await mappaCicloVita(aml, nomeMappa);
      if (!m) return json({ errore: `Life Cycle Map "${nomeMappa}" inesistente.` });
      return json({
        mappa: m.nome,
        stati: m.stati,
        transizioni: m.transizioni.map((t) => `${t.da} -> ${t.a}${t.ruoloRichiesto ? `  [ruolo: ${t.ruoloRichiesto}]` : ""}`),
        ruoliCoinvolti: [...new Set(m.transizioni.map((t) => t.ruoloRichiesto).filter(Boolean))],
      });
    })
);

server.tool(
  "aras_release_item",
  "Rilascia un elemento portandolo allo stato target, percorrendo il grafo delle transizioni " +
    "passo per passo. Con dryRun mostra il percorso e i ruoli richiesti senza eseguire nulla. " +
    "NOTA: su un ItemType versionabile la promozione crea una nuova generazione, quindi l'id cambia.",
  {
    itemType: z.string(),
    id: z.string(),
    statoTarget: z.string().default("Released"),
    dryRun: z.boolean().default(true).describe("true = mostra il piano; false = esegue"),
  },
  async ({ itemType, id, statoTarget, dryRun }) =>
    guard(async () => {
      const item = await client.getById<Record<string, unknown>>(itemType, id, ["id", "state"]);
      const stato = String(item["state"] ?? "");
      const mappa = await mappaCicloVita(aml, itemType);
      if (!mappa) return json({ rilasciato: false, motivo: `Nessun ciclo di vita "${itemType}".` });

      const path = percorso(mappa, stato, statoTarget);
      if (!path) {
        return json({
          rilasciato: false,
          statoAttuale: stato,
          motivo: `Nessun percorso da "${stato}" a "${statoTarget}" nel grafo.`,
          transizioniDaQui: mappa.transizioni.filter((t) => t.da === stato).map((t) => t.a),
        });
      }

      const passi = path.slice(1).map((a, i) => {
        const t = mappa.transizioni.find((x) => x.da === path[i] && x.a === a);
        return { da: path[i]!, a, ruoloRichiesto: t?.ruoloRichiesto ?? null };
      });
      const mie = await identitaCorrenti(client);
      const mancanti = passi.filter((p) => p.ruoloRichiesto && !mie.includes(p.ruoloRichiesto));

      if (dryRun || cfg.readOnly) {
        return json({
          rilasciato: false,
          modalita: cfg.readOnly ? "server in sola lettura" : "dryRun",
          statoAttuale: stato, statoTarget,
          percorso: path.join(" -> "),
          passi,
          tueIdentita: mie,
          ruoliMancanti: mancanti.map((p) => p.ruoloRichiesto),
          eseguibile: mancanti.length === 0,
        });
      }

      let corrente = id;
      const eseguiti: string[] = [];
      for (const p of passi) {
        try {
          await aml.promote(itemType, corrente, p.a);
          eseguiti.push(`${p.da} -> ${p.a}`);
          // La promozione puo' versionare: si rilegge l'id corrente per il passo dopo.
          const dopo = await client.query<Record<string, unknown>>(itemType, {
            filter: `config_id eq '${(await client.getById<Record<string, unknown>>(itemType, corrente, ["config_id"]))["config_id@aras.id"]}'`,
            select: ["id", "state"], top: 1,
          }).catch(() => null);
          if (dopo?.value[0]?.["id"]) corrente = String(dopo.value[0]["id"]);
        } catch (e) {
          return json({
            rilasciato: false,
            passiEseguiti: eseguiti,
            bloccatoSu: `${p.da} -> ${p.a}`,
            ruoloRichiesto: p.ruoloRichiesto,
            errore: e instanceof Error ? e.message.slice(0, 250) : String(e),
          });
        }
      }
      const finale = await client.getById<Record<string, unknown>>(itemType, corrente, ["id", "state", "is_released"]);
      return json({
        rilasciato: true, percorso: path.join(" -> "), passiEseguiti: eseguiti,
        idFinale: corrente, statoFinale: finale["state"], is_released: finale["is_released"],
        nota: corrente !== id ? "L'id e' cambiato: la promozione ha creato una nuova generazione." : undefined,
      });
    })
);

// ------------------------------------------------------ anagrafica prodotto

server.tool(
  "aras_get_list_values",
  "Valori AMMESSI dalle proprieta' di tipo lista di un ItemType (es. make_buy, unit, " +
    "drawing_size). Da chiamare PRIMA di creare: un valore fuori lista supera la validazione " +
    "dello schema — il nome della proprieta' esiste — ma viene rifiutato o ignorato da Aras.",
  { itemType: z.string().describe("es. 'Part', 'Document'") },
  async ({ itemType }) => guard(async () => json({ itemType, liste: await lists.valuesFor(itemType) }))
);

server.tool(
  "aras_create_part",
  "Crea una Part con validazione dello schema E dei valori di lista, opzionalmente " +
    "agganciandola subito a un assieme padre in distinta.",
  {
    item_number: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    make_buy: z.string().optional().describe("Make oppure Buy"),
    unit: z.string().optional().describe("EA, IN, FT, MM, CM, M"),
    classification: z.string().optional(),
    cost: z.number().optional(),
    sottoAssieme: z.string().optional().describe("item_number dell'assieme padre"),
    quantita: z.number().default(1),
    riferimento: z.string().optional().describe("reference_designator in distinta"),
    dryRun: z.boolean().default(false),
  },
  async (a) =>
    guard(async () => {
      if (cfg.readOnly) return json({ creata: false, motivo: "Server in sola lettura." });
      const props: Record<string, unknown> = { item_number: a.item_number };
      for (const k of ["name", "description", "make_buy", "unit", "classification"] as const) {
        if (a[k] !== undefined) props[k] = a[k];
      }
      if (a.cost !== undefined) props["cost"] = a.cost;

      const sch = await schema.validateProperties("Part", props);
      const lst = await lists.validate("Part", props);
      if (!sch.ok || !lst.ok) {
        return json({
          creata: false, motivo: "Validazione fallita",
          proprietaSconosciute: sch.unknown.length ? sch.unknown : undefined,
          obbligatorieMancanti: sch.missingRequired.length ? sch.missingRequired : undefined,
          valoriFuoriLista: lst.errori.length ? lst.errori : undefined,
        });
      }
      if (a.dryRun) return json({ creata: false, validazione: "ok", anteprima: props });

      return json(await creaPart(client, props as Record<string, unknown> & { item_number: string },
        a.sottoAssieme ? { itemNumber: a.sottoAssieme, quantita: a.quantita, riferimento: a.riferimento } : undefined));
    })
);

server.tool(
  "aras_create_document",
  "Crea un Document (disegno, specifica, manuale) o un CAD e lo collega a una Part.",
  {
    tipo: z.enum(["Document", "CAD"]).default("Document"),
    item_number: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    drawing_size: z.string().optional().describe("Solo Document: A, B, C, D, E"),
    authoring_tool: z.string().optional(),
    perPart: z.string().optional().describe("item_number della Part a cui collegarlo"),
  },
  async ({ tipo, perPart, ...rest }) =>
    guard(async () => {
      if (cfg.readOnly) return json({ creato: false, motivo: "Server in sola lettura." });
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) props[k] = v;

      const sch = await schema.validateProperties(tipo, props);
      const lst = await lists.validate(tipo, props);
      if (!sch.ok || !lst.ok) {
        return json({
          creato: false, motivo: "Validazione fallita",
          proprietaSconosciute: sch.unknown.length ? sch.unknown : undefined,
          valoriFuoriLista: lst.errori.length ? lst.errori : undefined,
        });
      }
      return json(await creaDocumento(client, tipo, props as Record<string, unknown> & { item_number: string }, perPart));
    })
);

server.tool(
  "aras_manage_bom_line",
  "Aggiunge, aggiorna o rimuove una riga di distinta base fra due Part, per item_number.",
  {
    azione: z.enum(["aggiungi", "aggiorna", "rimuovi"]),
    assieme: z.string().describe("item_number del padre"),
    componente: z.string().describe("item_number del figlio"),
    quantita: z.number().optional(),
    riferimento: z.string().optional().describe("reference_designator, es. 'R1,R2'"),
  },
  async ({ azione, assieme, componente, quantita, riferimento }) =>
    guard(async () => {
      if (cfg.readOnly) return json({ fatto: false, motivo: "Server in sola lettura." });
      return json(await gestisciRigaBom(client, aml, azione, assieme, componente, quantita, riferimento));
    })
);

server.tool(
  "aras_copy_part",
  "Duplica una Part con le sue proprieta' di dominio e, se richiesto, la distinta di primo " +
    "livello. Revisione, stato e dati di audit vengono rigenerati da Aras.",
  {
    origine: z.string().describe("item_number da copiare"),
    nuovo: z.string().describe("item_number della copia"),
    nuovoNome: z.string().optional(),
    conDistinta: z.boolean().default(true),
  },
  async ({ origine, nuovo, nuovoNome, conDistinta }) =>
    guard(async () => {
      if (cfg.readOnly) return json({ copiata: false, motivo: "Server in sola lettura." });
      return json(await copiaPart(client, origine, nuovo, nuovoNome, conDistinta));
    })
);

server.tool(
  "aras_add_manufacturer_part",
  "Aggiunge un componente commerciale (Manufacturer Part) e lo approva su una Part, creando " +
    "il costruttore se non esiste. Copre in un passo Manufacturer, Manufacturer Part e Part AML.",
  {
    mpn: z.string().describe("Codice del costruttore"),
    descrizione: z.string(),
    costruttore: z.string(),
    perPart: z.string().describe("item_number della Part su cui approvarlo"),
  },
  async ({ mpn, descrizione, costruttore, perPart }) =>
    guard(async () => {
      if (cfg.readOnly) return json({ fatto: false, motivo: "Server in sola lettura." });
      return json(await aggiungiManufacturerPart(client, mpn, descrizione, costruttore, perPart));
    })
);

server.tool(
  "aras_check_release_readiness",
  "Verifica se un assieme e' pronto per il rilascio: elenca i componenti della distinta non " +
    "ancora rilasciati. Rilasciare un padre con figli in Preliminary e' l'errore piu' comune.",
  {
    partId: z.string(),
    profondita: z.number().int().min(1).max(10).default(5),
  },
  async ({ partId, profondita }) =>
    guard(async () => {
      const r = await componentiNonRilasciati(client, partId, profondita);
      return json({
        ...r,
        pronto: r.nonRilasciati.length === 0,
        nota: r.nonRilasciati.length
          ? `${r.nonRilasciati.length} componenti non rilasciati: rilasciali prima dell'assieme.`
          : "Tutti i componenti sono rilasciati.",
      });
    })
);

// ------------------------------------------------------ gestione modifiche

server.tool(
  "aras_create_change",
  "Crea una ECR o una ECN con i suoi elementi impattati. Il numero (ECR-100001...) lo genera " +
    "Aras e non va fornito. Gli Affected Item sono creati inline dentro la relazione: e' " +
    "l'unico modo che funziona.",
  {
    tipo: z.enum(["ECR", "ECN"]),
    title: z.string(),
    description: z.string().optional(),
    proposed_solution: z.string().optional().describe("Solo ECR"),
    implementation_plan: z.string().optional().describe("Solo ECN"),
    impattati: z.array(z.object({
      itemType: z.string().default("Part"),
      itemNumber: z.string(),
    })).default([]),
  },
  async ({ tipo, impattati, ...dati }) =>
    guard(async () => {
      if (cfg.readOnly) return json({ creata: false, motivo: "Server in sola lettura." });
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(dati)) if (v !== undefined) props[k] = v;
      const sch = await schema.validateProperties(tipo, props);
      if (sch.unknown.length) {
        return json({ creata: false, proprietaSconosciute: sch.unknown, suggerimento: `aras_describe_item_type ${tipo}` });
      }
      return json(await creaModifica(client, tipo, props, impattati));
    })
);

server.tool(
  "aras_add_affected_item",
  "Aggiunge un elemento fra quelli impattati da una ECR/ECN esistente.",
  {
    tipo: z.enum(["ECR", "ECN"]),
    changeId: z.string(),
    itemType: z.string().default("Part"),
    itemNumber: z.string(),
  },
  async ({ tipo, changeId, itemType, itemNumber }) =>
    guard(async () => {
      if (cfg.readOnly) return json({ aggiunto: false, motivo: "Server in sola lettura." });
      return json(await aggiungiImpattato(client, tipo, changeId, itemType, itemNumber));
    })
);

server.tool(
  "aras_advance_change",
  "Fa avanzare una ECR/ECN votando l'attivita' ATTIVA del suo workflow. Fra le attivita' del " +
    "processo una sola e' Active: le Pending sono a valle e votarle non produce effetti. " +
    "dryRun mostra quale verrebbe votata.",
  {
    changeId: z.string(),
    via: z.string().describe("Nome della via di uscita, es. 'Approve', 'Reject'"),
    commenti: z.string().optional(),
    dryRun: z.boolean().default(true),
  },
  async ({ changeId, via, commenti, dryRun }) =>
    guard(async () => {
      if (cfg.readOnly && !dryRun) return json({ avanzata: false, motivo: "Server in sola lettura." });
      return json(await avanzaModifica(client, aml, changeId, via, commenti, dryRun || cfg.readOnly));
    })
);

// ------------------------------------------------ organizzazione e ruoli

server.tool(
  "aras_create_user",
  "Crea un utente e lo iscrive ai gruppi indicati. In Aras servono tre passi: lo User, " +
    "l'Identity alias che Aras genera da se', e le righe Member verso i gruppi. Creare un " +
    "secondo Alias fallisce ('cannot be greater than 1'), quindi l'appartenenza passa da Member.",
  {
    login: z.string(), nome: z.string(), cognome: z.string(),
    email: z.string().optional(), azienda: z.string().optional(),
    gruppi: z.array(z.string()).default([]).describe("Nomi di Identity a cui iscriverlo"),
  },
  async ({ login, nome, cognome, email, azienda, gruppi }) =>
    guard(async () => {
      if (cfg.readOnly) return json({ creato: false, motivo: "Server in sola lettura." });
      return json(await creaUtente(client, aml, { login, nome, cognome, email, azienda }, gruppi));
    })
);

server.tool(
  "aras_create_group",
  "Crea un gruppo o ruolo (Identity), opzionalmente annidato in un gruppo padre. " +
    "I ruoli servono anche per le transizioni di ciclo di vita, che richiedono un'identita'.",
  {
    nome: z.string(), descrizione: z.string().optional(),
    gruppoPadre: z.string().optional().describe("Nome del gruppo in cui annidarlo"),
  },
  async ({ nome, descrizione, gruppoPadre }) =>
    guard(async () => {
      if (cfg.readOnly) return json({ creato: false, motivo: "Server in sola lettura." });
      return json(await creaGruppo(client, nome, descrizione, gruppoPadre));
    })
);

server.tool(
  "aras_manage_membership",
  "Aggiunge o rimuove un'identita' da un gruppo. E' il modo di concedere un ruolo — " +
    "per esempio dare 'Aras PLM' a un utente perche' possa rilasciare le Part.",
  {
    gruppo: z.string().describe("Nome del gruppo/ruolo"),
    membro: z.string().describe("Nome dell'identita' da aggiungere/rimuovere"),
    azione: z.enum(["aggiungi", "rimuovi"]),
  },
  async ({ gruppo, membro, azione }) =>
    guard(async () => {
      if (cfg.readOnly) return json({ fatto: false, motivo: "Server in sola lettura." });
      return json(await gestisciAppartenenza(client, aml, gruppo, membro, azione));
    })
);

server.tool(
  "aras_get_type_permissions",
  "Quali identita' possono aggiungere, modificare o cancellare istanze di un ItemType, e se " +
    "l'utente corrente ne fa parte. E' la risposta a 'perche' non riesco a creare questo': " +
    "Aras restituisce i dinieghi di permesso come errore 500 generico, non come 403.",
  { itemType: z.string().describe("es. 'Manufacturer', 'Part'") },
  async ({ itemType }) =>
    guard(async () => {
      const info = await schema.findItemType(itemType);
      if (!info) return json({ errore: `ItemType "${itemType}" inesistente.` });

      // Le identita' abilitate stanno in relazioni "Can Add"/"Can Update"... sull'ItemType.
      const xml = (await aml.apply(
        `<Item type="ItemType" action="get" id="${info.id}" select="name"><Relationships>` +
        `<Item type="Can Add" action="get" select="related_id"/></Relationships></Item>`
      )).raw;
      const canAdd = [...xml.matchAll(/<related_id[^>]*keyed_name="([^"]*)"/g)]
        .map((m) => m[1]!).filter((v, i, a) => a.indexOf(v) === i);

      const mie = await identitaCorrenti(client);
      const puoiAggiungere = canAdd.length === 0 || canAdd.some((c) => mie.includes(c));

      return json({
        itemType: info.name,
        identitaConPermessoAdd: canAdd,
        tueIdentita: mie,
        puoiAggiungere,
        nota: puoiAggiungere
          ? undefined
          : `Serve una di queste identita': ${canAdd.join(", ")}. ` +
            `Concedila con aras_manage_membership (gruppo = "${canAdd[0]}", membro = la tua identita').`,
      });
    })
);

server.tool(
  "aras_get_my_identities",
  "Identita' possedute dall'utente configurato, incluse quelle ereditate per appartenenza a " +
    "gruppi. Serve a capire perche' una promozione o una scrittura viene rifiutata.",
  {},
  async () => guard(async () => json({ utente: cfg.username, identita: await identitaCorrenti(client) }))
);

// --------------------------------------- cruscotti, metriche, query salvate

server.tool(
  "aras_list_dashboards",
  "Cruscotti configurati in Aras, con i tipi di contenuto che ospitano. Su un'istanza " +
    "standard ne esistono gia' diversi (Engineering Efficiency, Time To Manufacturing...).",
  {},
  async () =>
    guard(async () => {
      const d = await cruscotti(client, aml);
      return json({ cruscotti: d.length, elenco: d });
    })
);

server.tool(
  "aras_list_metrics",
  "Metriche e indicatori definiti in Aras (es. 'ECR Cycle Time', 'Cost vs. Goal', " +
    "'CAD Model Release Time'). Filtra per nome se ne cerchi una in particolare.",
  { filtro: z.string().optional() },
  async ({ filtro }) =>
    guard(async () => {
      const [m, g] = await Promise.all([metriche(client, filtro), grafici(client)]);
      return json({ metriche: m.length, elenco: m, grafici: g.length, graficiElenco: g });
    })
);

server.tool(
  "aras_list_queries",
  "Query salvate del Query Builder. Sono interrogazioni preconfezionate che Aras usa " +
    "internamente e che puoi riusare, es. 'PE_BomStructure' o 'Aras.Resolution.LatestReleased'.",
  {},
  async () =>
    guard(async () => {
      const q = await querySalvate(client);
      return json({ query: q.length, elenco: q });
    })
);

server.tool(
  "aras_describe_query",
  "Struttura di una query salvata: da quali ItemType parte e quali parametri accetta. " +
    "Da chiamare prima di eseguirla.",
  { nome: z.string().describe("Nome della qry_QueryDefinition") },
  async ({ nome }) =>
    guard(async () => {
      const d = await descriviQuery(aml, nome);
      if (!d) {
        const tutte = await querySalvate(client);
        return json({ errore: `Query "${nome}" inesistente.`, disponibili: tutte.map((q) => q.nome) });
      }
      return json(d);
    })
);

server.tool(
  "aras_run_query",
  "Tenta di eseguire una query salvata del Query Builder. LIMITE NOTO: l'esecuzione non e' " +
    "raggiungibile da un client esterno — nessuna action AML documentata la esegue. Il tool " +
    "restituisce allora la STRUTTURA della query e indica con quali strumenti ottenere gli " +
    "stessi dati (aras_query_items, aras_get_bom, aras_where_used).",
  {
    nome: z.string(),
    parametri: z.record(z.string()).default({}),
    maxRighe: z.number().int().min(1).max(500).default(50),
  },
  async ({ nome, parametri, maxRighe }) =>
    guard(async () => json({ query: nome, ...(await eseguiQuery(aml, nome, parametri, maxRighe)) }))
);

// ------------------------------------------------------------ effettivita'

server.tool(
  "aras_get_effectivity_config",
  "Configurazione dell'effettivita': scope, variabili (Model, Unit, Date), modelli di " +
    "prodotto definiti e quante espressioni sono impostate sulle righe di distinta.",
  {},
  async () => guard(async () => json(await configEffettivita(client, aml)))
);

server.tool(
  "aras_create_effectivity_model",
  "Crea un modello di prodotto, usabile come valore della variabile Model dell'effettivita' " +
    "(es. 'CP-40', 'CP-60').",
  { nome: z.string(), etichetta: z.string().optional() },
  async ({ nome, etichetta }) =>
    guard(async () => {
      if (cfg.readOnly) return json({ creato: false, motivo: "Server in sola lettura." });
      return json(await creaModello(client, nome, etichetta));
    })
);

// ------------------------------------------------- amministrazione schema

server.tool(
  "aras_create_item_type",
  "Crea un nuovo ItemType con le sue proprieta'. ATTENZIONE: Aras documenta questa " +
    "configurazione solo dall'interfaccia (Administration -> ItemTypes), perche' oltre alla " +
    "riga servono default permission, TOC Access e identita' Can Add. Il tool tenta l'intera " +
    "sequenza e riporta passo per passo cosa e' riuscito, verificando alla fine se l'ItemType " +
    "accetta davvero istanze.",
  {
    nome: z.string().describe("Nome dell'ItemType, es. 'Progetto'"),
    etichetta: z.string().optional(),
    versionabile: z.boolean().default(false),
    permissionName: z.string().optional().describe("Nome del Permission da usare come default"),
    canAddIdentity: z.string().optional().describe("Identita' abilitata a creare istanze"),
    proprieta: z.array(z.object({
      nome: z.string(),
      tipo: z.string().describe("string, text, integer, decimal, date, boolean, item, list"),
      lunghezza: z.number().optional(),
      obbligatoria: z.boolean().optional(),
      etichetta: z.string().optional(),
    })).default([]),
  },
  async ({ nome, ...opz }) =>
    guard(async () => {
      if (cfg.readOnly) return json({ creato: false, motivo: "Server in sola lettura." });
      return json(await creaItemType(client, aml, nome, opz));
    })
);

server.tool(
  "aras_add_property",
  "Aggiunge una proprieta' a un ItemType esistente.",
  {
    itemType: z.string(),
    nome: z.string(),
    tipo: z.string().describe("string, text, integer, decimal, date, boolean, item, list"),
    lunghezza: z.number().optional().describe("Per le stringhe"),
    obbligatoria: z.boolean().default(false),
    etichetta: z.string().optional(),
  },
  async ({ itemType, ...p }) =>
    guard(async () => {
      if (cfg.readOnly) return json({ aggiunta: false, motivo: "Server in sola lettura." });
      return json(await aggiungiProprieta(client, aml, itemType, p));
    })
);

// ------------------------------------------------ permessi e operazioni massive

server.tool(
  "aras_get_permission_detail",
  "Diritti concessi da un Permission alle varie identita': chi puo' leggere, modificare, " +
    "cancellare e scoprire gli elementi che lo usano.",
  { nomePermesso: z.string().describe("es. 'New Part', 'Aras PLM Full'") },
  async ({ nomePermesso }) =>
    guard(async () => {
      const d = await dettaglioPermesso(client, nomePermesso);
      if (!d) {
        const p = await client.query<Record<string, unknown>>("Permission", { select: ["name"], orderby: "name", top: 50 });
        return json({ errore: `Permission "${nomePermesso}" inesistente.`, disponibili: p.value.map((x) => x["name"]) });
      }
      return json(d);
    })
);

server.tool(
  "aras_grant_permission",
  "Concede o modifica i diritti di un'identita' su un Permission. Nota: senza 'scoprire' " +
    "(can_discover) l'elemento non compare nemmeno nelle ricerche, quindi viene concesso " +
    "automaticamente insieme alla lettura.",
  {
    nomePermesso: z.string(),
    identita: z.string(),
    leggere: z.boolean().default(true),
    modificare: z.boolean().default(false),
    cancellare: z.boolean().default(false),
    scoprire: z.boolean().optional(),
  },
  async ({ nomePermesso, identita, ...diritti }) =>
    guard(async () => {
      if (cfg.readOnly) return json({ fatto: false, motivo: "Server in sola lettura." });
      return json(await concediPermesso(client, aml, nomePermesso, identita, diritti));
    })
);

server.tool(
  "aras_replace_component",
  "Sostituisce un componente con un altro in TUTTE le distinte che lo usano — obsolescenza, " +
    "second source. dryRun (default) mostra prima quali assiemi verrebbero toccati.",
  {
    vecchio: z.string().describe("item_number del componente da sostituire"),
    nuovo: z.string().describe("item_number del sostituto"),
    dryRun: z.boolean().default(true),
  },
  async ({ vecchio, nuovo, dryRun }) =>
    guard(async () => {
      if (cfg.readOnly && !dryRun) return json({ sostituito: false, motivo: "Server in sola lettura." });
      return json(await sostituisciComponente(client, vecchio, nuovo, dryRun || cfg.readOnly));
    })
);

server.tool(
  "aras_bulk_update",
  "Aggiorna in blocco tutti gli elementi che corrispondono a un filtro OData. " +
    "dryRun (default) elenca cosa verrebbe toccato senza scrivere.",
  {
    itemType: z.string(),
    filtro: z.string().describe("Filtro OData, es. \"make_buy eq 'Buy'\""),
    valori: z.record(z.unknown()).describe("Proprieta' da impostare"),
    dryRun: z.boolean().default(true),
    massimo: z.number().int().min(1).max(500).default(100),
  },
  async ({ itemType, filtro, valori, dryRun, massimo }) =>
    guard(async () => {
      if (cfg.readOnly && !dryRun) return json({ aggiornati: 0, motivo: "Server in sola lettura." });
      const sch = await schema.validateProperties(itemType, valori);
      if (sch.unknown.length) {
        return json({ aggiornati: 0, proprietaSconosciute: sch.unknown, suggerimento: `aras_describe_item_type ${itemType}` });
      }
      return json(await aggiornamentoMassivo(client, itemType, filtro, valori, dryRun || cfg.readOnly, massimo));
    })
);

server.tool(
  "aras_list_sequences",
  "Sequenze di numerazione automatica configurate (ECR, ECN, Part...) con il prossimo valore " +
    "che verrebbe assegnato.",
  {},
  async () => guard(async () => json({ sequenze: await sequenze(client) }))
);

server.tool(
  "aras_list_methods",
  "Metodi server definiti in Aras, ricercabili per nome. Utili per capire quale logica " +
    "personalizzata esiste, e invocabili con aras_aml_request.",
  {
    cerca: z.string().optional(),
    limite: z.number().int().min(1).max(200).default(30),
  },
  async ({ cerca, limite }) => guard(async () => json(await metodi(client, cerca, limite)))
);

server.tool(
  "aras_export_aml",
  "Esporta elementi in AML, il formato nativo di scambio di Aras: utile per travasare " +
    "configurazioni fra istanze o per conservare uno stato.",
  {
    itemType: z.string(),
    filtro: z.string().optional().describe("Clausola AML where, es. \"[Part].item_number like 'PMP-%'\""),
    conRelazioni: z.boolean().default(false),
    massimo: z.number().int().min(1).max(200).default(50),
  },
  async ({ itemType, filtro, conRelazioni, massimo }) =>
    guard(async () => {
      const r = await esportaAml(aml, itemType, filtro, conRelazioni, massimo);
      return json({ itemType: r.itemType, elementi: r.elementi, aml: r.aml.slice(0, 12000) });
    })
);

// ------------------------------------------------ report e diagnostica

server.tool(
  "aras_list_reports",
  "Report configurati in Aras, con gli ItemType a cui sono agganciati. Su un'istanza " +
    "standard ce ne sono gia' diversi: BOM Costing Report, BOM Quantity Rollup Report, " +
    "Approved Vendors Report.",
  {},
  async () =>
    guard(async () => {
      const r = await elencoReport(client);
      return json({ report: r.length, elenco: r });
    })
);

server.tool(
  "aras_run_report",
  "Esegue un report e restituisce i DATI (la trasformazione XSL serve solo alla resa " +
    "grafica nel client). Molti report sono parametrici: passa contestoId con l'id " +
    "dell'elemento su cui eseguirlo.",
  {
    nome: z.string(),
    contestoId: z.string().optional().describe("id dell'elemento di contesto, es. una Part"),
    massimo: z.number().int().min(1).max(200).default(50),
  },
  async ({ nome, contestoId, massimo }) =>
    guard(async () => {
      const r = await eseguiReport(client, aml, nome, contestoId, massimo);
      if (!r) {
        const tutti = await elencoReport(client);
        return json({ errore: `Report "${nome}" inesistente.`, disponibili: tutti.map((x) => x.nome) });
      }
      return json(r);
    })
);

server.tool(
  "aras_lookup_error",
  "Cerca nel catalogo dei messaggi di Aras (UserMessage) per capire un errore opaco. " +
    "Contiene i template di TUTTI i messaggi del server con i segnaposto {0}: cercando " +
    "parte del testo ricevuto si risale al codice e al significato.",
  {
    testo: z.string().describe("Parte del messaggio o del codice, es. 'no default permission'"),
    limite: z.number().int().min(1).max(50).default(10),
  },
  async ({ testo, limite }) => guard(async () => json(await cercaMessaggio(client, testo, limite)))
);

server.tool(
  "aras_list_saved_searches",
  "Ricerche salvate dagli utenti, con i criteri che usano.",
  {},
  async () =>
    guard(async () => {
      const s = await ricercheSalvate(client);
      return json({ ricerche: s.length, elenco: s });
    })
);

server.tool(
  "aras_delegate_activity",
  "Delega un'attivita' di workflow a un'altra identita', invece di votarla. " +
    "Usa aras_get_workflow per trovare attivita' e assegnazione.",
  {
    activityId: z.string(),
    assignmentId: z.string(),
    aIdentita: z.string().describe("Nome dell'identita' a cui delegare"),
    commenti: z.string().optional(),
    dryRun: z.boolean().default(true),
  },
  async ({ activityId, assignmentId, aIdentita, commenti, dryRun }) =>
    guard(async () => {
      if (cfg.readOnly && !dryRun) return json({ delegata: false, motivo: "Server in sola lettura." });
      return json(await delegaAttivita(client, aml, activityId, assignmentId, aIdentita, commenti, dryRun || cfg.readOnly));
    })
);

server.tool(
  "aras_import_aml",
  "Applica un pacchetto AML: l'inverso di aras_export_aml. dryRun (default) analizza il " +
    "contenuto e segnala quante azioni distruttive contiene prima di eseguirlo.",
  {
    contenuto: z.string().describe("Frammento AML, uno o piu' <Item .../>"),
    dryRun: z.boolean().default(true),
  },
  async ({ contenuto, dryRun }) =>
    guard(async () => {
      if (cfg.readOnly && !dryRun) return json({ importato: false, motivo: "Server in sola lettura." });
      return json(await importaAml(aml, contenuto, dryRun || cfg.readOnly));
    })
);

// ------------------------------------------------------------------- log

server.tool(
  "aras_get_logs",
  "Log di Aras da due sorgenti: i file del server su disco (Innovator, OAuth, Client) e " +
    "l'ItemType SystemEventLog a database. Su un'installazione nuova possono essere entrambe " +
    "vuote: il logging su file va abilitato nella configurazione del server.",
  {
    righe: z.number().int().min(1).max(500).default(80).describe("Righe per file, dalla coda"),
    filtro: z.string().optional().describe("Espressione regolare, es. 'error|exception'"),
    includiDatabase: z.boolean().default(true),
  },
  async ({ righe, filtro, includiDatabase }) =>
    guard(async () => {
      const file = await leggiLogFile(cfg.installDir, righe, filtro);
      const db = includiDatabase ? await leggiSystemEventLog(client, 50) : undefined;
      const totaleRighe = file.sorgenti.reduce((n, s) => n + s.righe.length, 0);
      return json({
        installDir: cfg.installDir,
        fileConRighe: file.sorgenti.filter((s) => s.righe.length).length,
        righeTotali: totaleRighe,
        sorgenti: file.sorgenti,
        sorgentiVuote: file.vuote,
        systemEventLog: db,
        nota: totaleRighe === 0 && !db?.totale
          ? "Nessun log disponibile: logging su file non attivo e SystemEventLog vuoto."
          : undefined,
      });
    })
);

server.tool(
  "aras_promote_item",
  "Promuove un elemento a un nuovo stato del ciclo di vita (es. Part da Preliminary a Released). " +
    "Passa da AML perche' OData non espone le transizioni. Disabilitato in sola lettura.",
  {
    itemType: z.string(),
    id: z.string(),
    toState: z.string().describe("Stato di destinazione, da aras_get_lifecycle_state"),
  },
  async ({ itemType, id, toState }) =>
    guard(async () => {
      if (cfg.readOnly) {
        return json({
          promosso: false,
          motivo: "Server in sola lettura. Imposta ARAS_READONLY=false per promuovere.",
        });
      }
      const r = await aml.promote(itemType, id, toState);
      return json({ promosso: true, nuovoStato: toState, risposta: r.items.slice(0, 3) });
    })
);

server.tool(
  "aras_aml_request",
  "Via di fuga: esegue AML (Aras Markup Language) grezzo contro InnovatorServer.aspx. " +
    "Da usare solo per cio' che OData non copre â€” logiche di query non esprimibili con $filter, " +
    "metodi server, azioni speciali. Passa il frammento <Item .../>, l'envelope SOAP e' automatico. " +
    "Le action che scrivono sono bloccate in sola lettura.",
  {
    itemXml: z
      .string()
      .describe(`es. <Item type="Part" action="get" select="item_number,name" maxRecords="10"/>`),
  },
  async ({ itemXml }) =>
    guard(async () => {
      const action = /action\s*=\s*"([^"]+)"/i.exec(itemXml)?.[1]?.toLowerCase() ?? "";
      const readOnlyActions = ["get", "getitemnextstates", "getitemrepeatconfig", "getrelationships"];
      if (cfg.readOnly && action && !readOnlyActions.includes(action)) {
        return json({
          eseguito: false,
          motivo: `Action "${action}" bloccata: il server e' in sola lettura. ` +
            `Consentite: ${readOnlyActions.join(", ")}. Imposta ARAS_READONLY=false per le altre.`,
        });
      }
      const r = await aml.apply(itemXml);
      return json({ eseguito: true, elementi: r.items.length, items: r.items.slice(0, 50) });
    })
);

// ------------------------------------------------------------------- avvio

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout e' riservato al protocollo MCP: la diagnostica va su stderr.
console.error(`aras-plm-mcp avviato â€” ${cfg.baseUrl} db=${cfg.database} readOnly=${cfg.readOnly}`);










