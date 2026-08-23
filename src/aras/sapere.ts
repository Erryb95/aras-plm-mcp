import { ArasClient } from "./client.js";

/**
 * Consultazione prima di agire.
 *
 * La documentazione ufficiale di Aras e' il corpus sbagliato per un client
 * esterno: descrive JavaScript di client e C# di server, cioe' proprio le vie
 * che da fuori non funzionano. Chi la seguisse verrebbe indirizzato con
 * sicurezza su strade cieche.
 *
 * Le fonti che valgono sono due, e nessuna e' un manuale:
 *   1. il sapere empirico su cosa funziona davvero da fuori, con la prova;
 *   2. l'istanza stessa — UserMessage, Method, schema — che e' la verita' di
 *      QUELLA installazione e non di una generica.
 *
 * Questo modulo espone entrambe.
 */

export type Voce = {
  argomento: string;
  chiavi: string[];
  problema: string;
  risposta: string;
  prova?: string;
  tool?: string;
};

/**
 * Ogni voce e' stata verificata contro un'istanza reale. Dove c'e' `prova`,
 * quello e' il messaggio esatto che Aras restituisce.
 */
export const SAPERE: Voce[] = [
  {
    argomento: "Riferimenti fra elementi che arrivano vuoti",
    chiavi: ["related_id", "source_id", "riferimento", "vuoto", "null", "distinta", "bom", "relazione", "annotazione"],
    problema: "Una query su una relazione restituisce righe senza il riferimento all'elemento collegato.",
    risposta:
      "Aras espone i riferimenti SOLO come annotazioni OData (related_id@aras.id, " +
      "related_id@aras.keyed_name) e SOLO se la proprieta' compare in $select. Senza $select " +
      "non arriva nulla e le righe sembrano metadati opachi. E' il modo piu' facile di " +
      "costruire un esploratore di distinta che restituisce un albero vuoto senza un errore.",
    tool: "aras_get_relationships, aras_get_bom",
  },
  {
    argomento: "Generazioni precedenti invisibili",
    chiavi: ["revisione", "generazione", "storico", "versione", "is_current", "precedente"],
    problema: "Le revisioni passate di una Part non compaiono in nessuna query.",
    risposta:
      "OData vede solo la generazione corrente: $filter=is_current eq '0' restituisce zero " +
      "righe. Lo storico passa da AML, azione getItemAllVersions.",
    tool: "aras_get_revisions",
  },
  {
    argomento: "Il workflow non avanza",
    chiavi: ["workflow", "attivita", "voto", "avanzare", "EvaluateActivity", "internal error"],
    problema: "Votare un'attivita' risponde 'An internal error has occured', che non dice nulla.",
    risposta:
      "Due cause distinte. (1) Aras vuole l'ID della via di uscita, non il suo nome: le vie " +
      "sono righe di Workflow Process Path che partono dall'attivita'. (2) La EvaluateActivity " +
      "richiede un elemento <Complete>1</Complete> che non compare in nessuna documentazione.",
    prova: "Workflow: EvaluateActivity: Complete value not found  (solo nel log del server)",
    tool: "aras_get_workflow, aras_vote_activity, aras_advance_change",
  },
  {
    argomento: "Promozione che sembra non esistere",
    chiavi: ["promozione", "promote", "rilascio", "transizione", "stato", "released", "failed to get the transition"],
    problema: "Promuovere risponde che non trova la transizione, ma la transizione esiste.",
    risposta:
      "Non e' un difetto: e' un permesso. Ogni transizione di ciclo di vita richiede un ruolo. " +
      "Se non lo possiedi, getItemNextStates torna vuoto e promoteItem fallisce con un " +
      "messaggio che sembra dire 'transizione inesistente'.",
    prova: "Internal Error: failed to get the transition to promote the Part from X to Y",
    tool: "aras_get_lifecycle_state, aras_get_lifecycle_map",
  },
  {
    argomento: "Diniego di permesso travestito da guasto",
    chiavi: ["permesso", "403", "500", "access", "denied", "autorizzazione"],
    problema: "Una scrittura fallisce con HTTP 500 e un messaggio generico.",
    risposta:
      "Aras restituisce i dinieghi di permesso come 500 generico, non come 403. Prima di " +
      "cercare un difetto, verifica quale identita' ha il permesso di Add sull'ItemType.",
    tool: "aras_get_type_permissions, aras_lookup_error",
  },
  {
    argomento: "Batch AML che esegue solo il primo elemento",
    chiavi: ["aml", "batch", "ApplyItem", "piu elementi", "silenzioso"],
    problema: "Un <AML> con piu' <Item> viene accettato senza errore ma solo il primo ha effetto.",
    risposta:
      "<ApplyItem> applica UN SOLO Item. Il batch non da' errore: risponde come se avesse " +
      "funzionato. Ogni elemento va applicato con una chiamata propria.",
    tool: "aras_aml_request",
  },
  {
    argomento: "ItemType dipendenti",
    chiavi: ["dipendente", "dependent", "source item not found", "Affected Item", "Activity Template"],
    problema: "Creare l'elemento risponde 'Dependent X cannot be create: source item not found'.",
    risposta:
      "L'ItemType e' dipendente (is_dependent=1): non puo' esistere da solo. Va creato DENTRO " +
      "il related_id della relazione che lo lega al padre, nella stessa chiamata. Vale per " +
      "Affected Item e per Activity Template.",
    prova: "Dependent Activity Template cannot be create: source item not found.",
    tool: "aras_add_affected_item, aras_create_relationship",
  },
  {
    argomento: "Where con nomi di ItemType che contengono spazi",
    chiavi: ["where", "spazio", "nome", "zero righe", "duplicato", "tabella"],
    problema: "Una where su un tipo come 'Workflow Map' restituisce zero righe, ma l'elemento esiste.",
    risposta:
      "Aras rifiuta il riferimento alla tabella e restituisce zero righe SENZA errore, quindi " +
      "il codice conclude che l'elemento non esiste e ne crea un duplicato. Confronta per " +
      "proprieta': <Item type=\"Workflow Map\" action=\"get\"><name>...</name></Item>.",
  },
  {
    argomento: "Avvio automatico del workflow alla creazione",
    chiavi: ["workflow", "automatico", "allowed workflow", "is_default", "cache", "instantiateWorkflow"],
    problema: "L'elemento viene creato ma nessun processo parte.",
    risposta:
      "Aras istanzia il workflow alla creazione se l'ItemType ha una riga Allowed Workflow con " +
      "is_default=1. Scrivere la riga non basta: i metadati dell'ItemType sono in cache. Una " +
      "edit sull'ItemType, anche a valore invariato, la invalida senza riavviare IIS. " +
      "L'azione instantiateWorkflow non e' utilizzabile da un client esterno.",
    prova: "instantiateWorkflow: 'idlist cannot be empty' con l'attributo id, '\"\" is not a valid id' senza",
  },
  {
    argomento: "Aggiornare una Part crea una nuova generazione",
    chiavi: ["update", "modifica", "generazione", "versionabile", "id cambiato"],
    problema: "Dopo un update l'id non e' piu' valido.",
    risposta:
      "Su un ItemType versionabile (Part, Document, CAD) Aras crea una NUOVA generazione a " +
      "ogni update, anche solo per correggere una descrizione. L'id cambia. Ritrova " +
      "l'elemento per item_number invece di conservare l'id.",
    tool: "aras_get_revisions, aras_query_items",
  },
  {
    argomento: "Valori di lista rifiutati dal server",
    chiavi: ["lista", "list", "valore", "make_buy", "drawing_size", "rifiutato"],
    problema: "Una proprieta' esiste ma il valore viene rifiutato.",
    risposta:
      "Le proprieta' basate su lista accettano solo i valori definiti, e la distinzione fra " +
      "maiuscole e minuscole conta: 'make' viene rifiutato dove 'Make' passa. La validazione " +
      "sullo schema non basta, perche' il NOME della proprieta' e' corretto.",
    tool: "aras_get_list_values",
  },
  {
    argomento: "Contenuto dei file dal vault",
    chiavi: ["file", "vault", "download", "pdf", "disegno", "allegato", "contenuto"],
    problema: "Come si legge il contenuto di un allegato.",
    risposta:
      "Si scarica dalla media resource OData File('<id>')/$value, con ripiego sull'endpoint " +
      "del vault. Entrambe rispondono con lo stesso token OAuth del resto del server. Il " +
      "CARICAMENTO invece non e' possibile da un client esterno: i file vanno caricati " +
      "dall'interfaccia Aras.",
    prova: "File Item cannot be added / Can't bind model  (sei tentativi di caricamento)",
    tool: "aras_get_files, aras_read_file",
  },
  {
    argomento: "Votare o delegare un'attivita' altrui",
    chiavi: ["voto", "delega", "allowed identity", "assegnatario", "identita"],
    problema: "'Can't complete activity. User is not from allowed identity.'",
    risposta:
      "Rifiuto legittimo, non guasto: chi vota deve appartenere all'identita' assegnataria. " +
      "Guarda a chi e' assegnata l'attivita' e iscrivi la tua identita', oppure delega.",
    tool: "aras_get_workflow, aras_manage_membership, aras_delegate_activity",
  },
  {
    argomento: "Cancellare un elemento referenziato",
    chiavi: ["cancellare", "delete", "referenziato", "ordine", "distinta"],
    problema: "La cancellazione fallisce o va fatta in un ordine preciso.",
    risposta:
      "Aras rifiuta finche' una riga di relazione referenzia l'elemento. Si cancella " +
      "dall'assieme verso i componenti, mai il contrario. Verifica prima cosa lo blocca.",
    tool: "aras_plan_delete",
  },
  {
    argomento: "Proprieta' scritte che spariscono senza errore",
    chiavi: ["cost", "costo", "rollup", "calcolata", "sparita", "non applicata", "silenzio", "ignorata"],
    problema: "Una proprieta' dichiarata viene accettata in scrittura ma rileggendola non c'e'.",
    risposta:
      "Aras ha proprieta' che accetta e ignora. Su Part, 'cost' e' calcolata dal rollup " +
      "('PE: rollup all parts in DB'): passarla in creazione non da' errore e non ha effetto. " +
      "Nessun messaggio, nessun codice: il campo resta vuoto. E' un caso diverso da x/y su " +
      "Workflow Map Activity, che non sono nemmeno dichiarate. La difesa e' la stessa: " +
      "rileggere. aras_create_item, aras_update_item e aras_create_part restituiscono " +
      "'proprietaNonApplicate' quando succede.",
    prova: "cost: 142.5 in creazione -> campo vuoto sia in OData sia nell'interfaccia Aras",
    tool: "aras_create_item, aras_update_item, aras_create_part",
  },
  {
    argomento: "Coordinate dei nodi di una mappa di workflow",
    chiavi: ["x", "y", "coordinate", "nodi", "designer", "sovrapposti", "grafo", "workflow map activity"],
    problema: "La mappa creata da fuori disegna tutti i nodi impilati nell'origine.",
    risposta:
      "x e y NON sono proprieta' dichiarate di Workflow Map Activity: describe_item_type ne " +
      "elenca 27 e queste non ci sono. Aras pero' le memorizza e le restituisce in lettura — " +
      "una riga di serie ha x=244, y=95. Scriverle da fuori non da' errore e non ha effetto: " +
      "l'AML risponde 200, aggiorna modified_on, e lascia il default 10,10. Il designer di " +
      "Aras le scrive per una via privata. Rimedio: disporre i nodi una volta a mano; il " +
      "processo funziona comunque.",
    prova: "aras_update_item -> proprietaSconosciute: [\"x\",\"y\"]  ·  AML edit -> 200 e valore invariato",
  },
  {
    argomento: "Cosa non si puo' fare da un client esterno",
    chiavi: ["limite", "impossibile", "non funziona", "query builder", "report javascript", "effettivita"],
    problema: "Quali sono i limiti reali, verificati.",
    risposta:
      "Cinque. (1) Caricare file nel vault (la LETTURA invece funziona). (2) Espressioni di effettivita' su distinta: " +
      "definition e' un XML non documentato. (3) Eseguire le query del Query Builder: nessuna " +
      "azione AML le esegue da fuori. (4) Report basati su JavaScript: e' codice di client. " +
      "Il tool corrispondente dichiara il limite e indica un'alternativa.",
    prova: "Method type not supported: JavaScript  /  'named-constant' or 'constant' node must be presented",
  },
];

const normalizza = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s_]/g, " ");

/**
 * Parole troppo comuni per essere indizi: senza escluderle, "come si fa il
 * caffe" trova una corrispondenza perche' "come" compare in mezza base.
 */
const RUMORE = new Set([
  "come", "cosa", "perche", "quando", "dove", "quale", "quali", "che", "chi",
  "non", "una", "uno", "del", "della", "dei", "delle", "con", "per", "sul",
  "sulla", "questo", "questa", "essere", "fare", "faccio", "posso", "devo",
  "the", "and", "for", "with", "how", "why", "what", "does", "this", "that",
]);

/** Punteggio: le chiavi valgono, il testo pesa poco, il rumore niente. */
function punteggio(v: Voce, parole: string[]): number {
  const testo = normalizza([v.argomento, v.problema, v.risposta, v.chiavi.join(" "), v.prova ?? "", v.tool ?? ""].join(" "));
  let p = 0;
  for (const w of parole) {
    if (w.length < 3 || RUMORE.has(w)) continue;
    if (v.chiavi.some((k) => normalizza(k).includes(w))) p += 3;
    else if (testo.includes(w)) p += 1;
  }
  return p;
}

// Sotto questa soglia la corrispondenza e' rumore: una sola parola generica
// finita per caso nel testo. Meglio dire "non lo so" che indirizzare male.
const SOGLIA = 3;

export function cercaSapere(domanda: string, quante = 3) {
  const parole = [...new Set(normalizza(domanda).split(/\s+/).filter(Boolean))];
  return SAPERE
    .map((v) => ({ v, p: punteggio(v, parole) }))
    .filter((x) => x.p >= SOGLIA)
    .sort((a, b) => b.p - a.p)
    .slice(0, quante)
    .map((x) => x.v);
}

/**
 * L'istanza come fonte: i messaggi che quel server puo' davvero restituire e i
 * metodi che ha installati. Piu' attendibile di un manuale generico, perche'
 * riflette la configurazione reale.
 */
export async function cercaNellIstanza(client: ArasClient, domanda: string) {
  const parole = normalizza(domanda).split(/\s+/).filter((w) => w.length >= 4).slice(0, 4);
  if (!parole.length) return { messaggi: [], metodi: [] };

  const filtro = (campo: string) => parole.map((w) => `contains(tolower(${campo}),'${w}')`).join(" or ");

  const [msg, met] = await Promise.all([
    client.query<Record<string, unknown>>("UserMessage", {
      filter: filtro("message"), select: ["id", "name", "message"], top: 5,
    }).catch(() => ({ value: [] })),
    client.query<Record<string, unknown>>("Method", {
      filter: filtro("name"), select: ["id", "name", "method_type", "comments"], top: 5,
    }).catch(() => ({ value: [] })),
  ]);

  return {
    messaggi: msg.value.map((m) => ({ nome: m["name"], testo: m["message"] })),
    metodi: met.value.map((m) => ({ nome: m["name"], tipo: m["method_type"], commento: m["comments"] })),
  };
}
