import { ArasClient } from "./client.js";
import { AmlClient } from "./aml.js";
import { readItemRef } from "./odata.js";

/**
 * Cruscotti, metriche e query salvate: la parte "analitica" di Aras.
 *
 * Su questa istanza sono gia' configurati e popolati (5 Dashboard, 20 Metric,
 * 10 Chart, 14 query salvate), ma non esiste un endpoint che li elenchi: sono
 * ItemType come gli altri e vanno interrogati per nome.
 */

export async function cruscotti(client: ArasClient, aml: AmlClient) {
  // Dashboard NON ha "label": selezionare una proprieta' inesistente fa fallire
  // l'intera query con 400. I nomi vanno letti dallo schema, non assunti.
  const page = await client.query<Record<string, unknown>>("Dashboard", {
    select: ["id", "name", "height", "width"], orderby: "name", top: 100,
  });

  // I widget di un Dashboard stanno in relazioni il cui nome non e' noto a priori:
  // si chiedono le RelationshipType del tipo e si interrogano una per una. Una
  // <Item action="get"/> generica dentro Relationships non le restituisce.
  const dashType = await client.query<Record<string, unknown>>("ItemType", {
    filter: `name eq 'Dashboard'`, select: ["id"], top: 1,
  });
  const relTypes = dashType.value[0]
    ? (await client.query<Record<string, unknown>>("RelationshipType", {
        filter: `source_id eq '${dashType.value[0]["id"]}'`, top: 20,
      }).catch(() => ({ value: [] as Array<Record<string, unknown>> }))).value.map((r) => String(r["name"]))
    : [];

  return Promise.all(page.value.map(async (d) => {
    const widget: string[] = [];
    for (const rt of relTypes) {
      const righe = await client.query<Record<string, unknown>>(rt, {
        filter: `source_id eq '${d["id"]}'`, select: ["related_id"], top: 50,
      }).catch(() => ({ value: [] as Array<Record<string, unknown>> }));
      for (const r of righe.value) {
        const nome = (r["related_id@aras.keyed_name"] as string) ?? null;
        if (nome) widget.push(`${rt}: ${nome}`);
      }
    }
    return {
      id: d["id"], nome: d["name"],
      dimensioni: `${d["width"] ?? "?"}x${d["height"] ?? "?"}`,
      contenuti: widget,
    };
  }));
}

export async function metriche(client: ArasClient, filtro?: string) {
  // Metric ha "label" e "frequency"; NON ha "description".
  const page = await client.query<Record<string, unknown>>("Metric", {
    select: ["id", "name", "label", "frequency"], orderby: "name", top: 200,
  });
  const v = filtro
    ? page.value.filter((m) => `${m["name"]} ${m["label"] ?? ""}`.toLowerCase().includes(filtro.toLowerCase()))
    : page.value;
  return v.map((m) => ({ id: m["id"], nome: m["name"], etichetta: m["label"] ?? null, frequenza: m["frequency"] ?? null }));
}

export async function grafici(client: ArasClient) {
  // Chart usa "title", non "label".
  const page = await client.query<Record<string, unknown>>("Chart", {
    select: ["id", "name", "title", "chart_type"], orderby: "name", top: 200,
  });
  return page.value.map((c) => ({ id: c["id"], nome: c["name"], titolo: c["title"] ?? null, tipo: c["chart_type"] ?? null }));
}

/** Query salvate del Query Builder. */
export async function querySalvate(client: ArasClient) {
  const page = await client.query<Record<string, unknown>>("qry_QueryDefinition", {
    select: ["id", "name", "description"], orderby: "name", top: 200,
  });
  return page.value.map((q) => ({ id: q["id"], nome: q["name"], descrizione: q["description"] ?? null }));
}

/**
 * Struttura di una query salvata: da quale ItemType parte, quali proprieta'
 * seleziona e quali parametri accetta. Serve a sapere come invocarla.
 */
export async function descriviQuery(aml: AmlClient, nome: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Se il nome non esiste Aras solleva "No items of type ... found": e' un esito
  // atteso, non un guasto, quindi si restituisce null e il chiamante elenca le query.
  const res = await aml.apply(
    `<Item type="qry_QueryDefinition" action="get" select="name,description"><name>${esc(nome)}</name>` +
    `<Relationships>` +
    `<Item type="qry_QueryItem" action="get" select="alias,item_type"/>` +
    `<Item type="qry_QueryParameter" action="get" select="name,default_value"/>` +
    `</Relationships></Item>`
  ).catch(() => null);
  if (!res) return null;
  const xml = res.raw;

  if (!/<Item[^>]*type="qry_QueryDefinition"/.test(xml)) return null;

  const items = [...xml.matchAll(/<Item[^>]*type="qry_QueryItem"[^>]*>([\s\S]*?)<\/Item>/g)].map((m) => ({
    alias: /<alias>([^<]*)<\/alias>/.exec(m[1]!)?.[1] ?? null,
    itemType: /<item_type[^>]*keyed_name="([^"]*)"/.exec(m[1]!)?.[1] ?? null,
  }));
  const parametri = [...xml.matchAll(/<Item[^>]*type="qry_QueryParameter"[^>]*>([\s\S]*?)<\/Item>/g)].map((m) => ({
    nome: /<name>([^<]*)<\/name>/.exec(m[1]!)?.[1] ?? null,
    default: /<default_value>([^<]*)<\/default_value>/.exec(m[1]!)?.[1] ?? null,
  }));

  return { nome, elementi: items, parametri };
}

/**
 * Esegue una query salvata del Query Builder.
 *
 * LIMITE NOTO, verificato sull'istanza. Nessuna delle azioni AML plausibili
 * esegue una qry_QueryDefinition da un client esterno:
 *   qry_Execute (per nome, per id, con parametri)  -> Item "Method" was not found
 *   ApplyQuery                                     -> Item "Method" was not found
 *   qry_ExecuteQueryDefinition                     -> Object reference not set
 * L'ultima risponde in modo diverso, quindi l'azione esiste ma richiede una
 * struttura di input che Aras non documenta nelle guide pubblicate; con ogni
 * probabilita' l'esecuzione presuppone il contesto del client Aras.
 *
 * Il tool restituisce quindi la STRUTTURA della query e indirizza agli
 * strumenti equivalenti, invece di propagare un errore incomprensibile.
 */
export async function eseguiQuery(
  aml: AmlClient,
  nome: string,
  parametri: Record<string, string>,
  maxRighe: number
) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const q = await aml.apply(
    `<Item type="qry_QueryDefinition" action="qry_ExecuteQueryDefinition"><name>${esc(nome)}</name>` +
    `<maxRecords>${maxRighe}</maxRecords></Item>`
  ).catch((e) => ({ items: [], raw: "", errore: e instanceof Error ? e.message : String(e) }));

  if (q.items.length) return { eseguita: true, elementi: q.items.length, risultati: q.items.slice(0, maxRighe) };

  const struttura = await descriviQuery(aml, nome);
  return {
    eseguita: false,
    motivo: "L'esecuzione delle query del Query Builder non e' raggiungibile da un client esterno " +
      "(nessuna action AML documentata la esegue; qry_Execute risponde 'Item \"Method\" was not found').",
    struttura,
    alternative: struttura
      ? `Questa query interroga ${struttura.elementi.map((e) => e.itemType).filter(Boolean).join(", ")}: ` +
        "usa aras_query_items su quegli ItemType, oppure aras_get_bom / aras_where_used se riguarda distinte."
      : "Usa aras_query_items sull'ItemType di interesse.",
  };
}

/** Configurazione dell'effettivita': scope, variabili e modelli disponibili. */
export async function configEffettivita(client: ArasClient, aml: AmlClient) {
  const [scope, vars, modelli, espressioni] = await Promise.all([
    client.query<Record<string, unknown>>("effs_scope", { select: ["id", "name"], top: 20 }).catch(() => ({ value: [] })),
    client.query<Record<string, unknown>>("effs_variable", { select: ["id", "name", "variable_type", "description"], top: 50 }).catch(() => ({ value: [] })),
    client.query<Record<string, unknown>>("effs_model", { select: ["id", "name", "label"], orderby: "name", top: 200 }).catch(() => ({ value: [] })),
    client.query<Record<string, unknown>>("effs_Part_BOM_expression", { select: ["id", "string_notation"], top: 50, count: true }).catch(() => ({ value: [], count: 0 })),
  ]);

  return {
    scope: (scope.value ?? []).map((s) => s["name"]),
    variabili: (vars.value ?? []).map((v) => ({ nome: v["name"], tipo: v["variable_type"], descrizione: v["description"] ?? null })),
    modelli: (modelli.value ?? []).map((m) => ({ id: m["id"], nome: m["name"] })),
    espressioniSuDistinta: (espressioni as { count?: number }).count ?? 0,
  };
}

/** Crea un modello di prodotto, usabile come valore della variabile Model. */
export async function creaModello(client: ArasClient, nome: string, etichetta?: string) {
  const gia = await client.query<Record<string, unknown>>("effs_model", {
    filter: `name eq '${nome.replace(/'/g, "''")}'`, select: ["id"], top: 1,
  });
  if (gia.value.length) return { creato: false, motivo: `Il modello "${nome}" esiste gia'.`, id: gia.value[0]!["id"] };
  const m = await client.create<Record<string, unknown>>("effs_model", { name: nome, label: etichetta ?? nome });
  return { creato: true, id: m["id"], nome };
}
