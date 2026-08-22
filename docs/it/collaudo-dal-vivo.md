# Collaudo dal vivo — 69 tool

Ogni tool è stato chiamato almeno una volta contro l'istanza reale
(Aras Innovator 2025, database `InnovatorSolutions`, dati ACME Pumps).

Tre canali di verifica:

| Canale | Copertura |
|---|---|
| Connessione MCP di Claude Code (`mcp__aras-plm__*`) | 27 tool, chiamati interattivamente |
| `tools/live-check.mjs` sul build corrente | 40 verifiche, incluse tutte le scritture bloccate |
| 8 suite automatiche | ~168 controlli, incluse scritture reali su elementi `ZZ-` |

## Difetti trovati e corretti durante il collaudo

**`aras_get_relationships` restituiva righe senza riferimenti.** Interrogava
senza `$select`, e Aras in quel caso non emette le annotazioni `related_id@aras.*`:
il risultato erano righe di metadati opachi che non dicevano a cosa puntassero.
È la stessa trappola documentata nel README — il tool ci era caduto dentro.
Corretto: ora ogni riga riporta `verso`, `versoId` e le proprietà proprie della
relazione (`quantity: 8` sulla vite in distinta).

**Il filtro delle proprietà tagliava quelle che contano.** Prendevo le prime 10
in ordine alfabetico, e `quantity` viene dopo `new_version` e `not_lockable`:
il risultato mostrava rumore e ometteva il dato utile. Ora l'esclusione è per
nome, non per posizione.

**`aras_list_dashboards` restituiva sempre `contenuti: []`.** Una
`<Item action="get"/>` generica dentro `Relationships` non restituisce le righe:
vanno chieste le `RelationshipType` del tipo e interrogate una per una.
Ora `Design To Goal` mostra `Cost vs. Goal` e `Weight vs. Goal`.

**`aras_run_query` propagava un fault incomprensibile.** Sei azioni AML
verificate, nessuna esegue una `qry_QueryDefinition` da un client esterno.
Ora il tool dichiara il limite, restituisce la struttura della query e indirizza
agli strumenti equivalenti.

**`aras_check_effectivity` mentiva nella propria descrizione**, affermando che il
modulo Effectivity non fosse installato. Era una conclusione errata rimasta nel
testo: il modulo c'è, con prefisso `effs_`.

**Il workflow non avanzava.** `aras_advance_change`, `aras_vote_activity` e
`aras_delegate_activity` fallivano tutti con `An internal error has occured` —
un messaggio che non dice nulla. Due cause distinte, trovate una alla volta:

1. Aras vuole l'**ID** della via di uscita, non il suo nome. Le vie sono righe di
   `Workflow Process Path` che partono dall'attività, e non erano esposte da nessun
   tool: si tiravano a indovinare. Ora `aras_get_workflow` le restituisce.
2. Manca l'elemento **`<Complete>1</Complete>`** nella `EvaluateActivity`. Questo
   l'ha rivelato il log del server appena attivato: il messaggio pubblico resta
   generico, ma nel log compare `Workflow: EvaluateActivity: Complete value not found`.

Verificato: `Submit ECR` passa da `Active` a `Closed` e il processo avanza a
`Review ECR`.

**La revoca dei permessi lasciava righe orfane.** Azzerare i flag di una riga
`Access` la lasciava presente ma inerte, sporcando il Permission. Ora azzerarli
tutti rimuove la riga.

**La delega rifiutata non spiegava perché.** Aras verifica che chi delega
appartenga all'identità assegnataria e risponde `User is not from allowed
identity` — rifiuto legittimo, non guasto. Ora il tool dice a chi è assegnata
l'attività e come rimediare.

## Costruire una mappa di workflow da fuori

Serviva un workflow di rilascio per le Part, che Aras non fornisce. Costruirlo
via AML ha fatto emergere tre comportamenti che non danno errore e per questo
costano ore.

**`<ApplyItem>` applica un solo `<Item>`.** Un batch `<AML>` con piu' elementi
viene accettato, risponde senza fault, ed esegue **solo il primo**. La prima
mappa risultava creata ma era un guscio vuoto: nessuna attivita', nessuna via.
Ogni elemento va applicato con una chiamata propria.

**`Activity Template` e' un ItemType dipendente.** Creato da solo risponde
`Dependent Activity Template cannot be create: source item not found`. Va creato
**dentro** il `related_id` della riga `Workflow Map Activity` che lo lega alla
mappa — la stessa regola gia' documentata per `Affected Item`.

**`where="[Tipo].name='...'"` non regge i nomi di ItemType con spazi.**
Aras rifiuta il riferimento alla tabella e restituisce **zero righe senza
errore**: il codice conclude che l'elemento non esiste e ne crea un duplicato.
Il confronto per proprieta' (`<Item type="Workflow Map" action="get"><name>...</name></Item>`)
funziona.

**L'avvio automatico del processo.** Aras istanzia il workflow alla creazione
dell'elemento se l'ItemType ha una riga `Allowed Workflow` con `is_default=1`.
Non basta scriverla: i metadati dell'ItemType sono in cache e finche' non viene
invalidata la riga non ha effetto. Una `edit` sull'ItemType — anche a valore
invariato — la invalida senza riavviare IIS.

L'azione AML `instantiateWorkflow` invece non e' utilizzabile da un client
esterno: con l'attributo `id` risponde `idlist cannot be empty`, senza risponde
`"" is not a valid id` da `GetInstanitationProcessItemInfoHandler`. Sette forme
provate. La via praticabile e' il workflow predefinito.

**Due dinieghi che sembrano guasti.** Votare un'attivita' senza appartenere
all'identita' assegnataria da' `User is not from allowed identity`; promuovere
senza il ruolo della transizione da' `failed to get the transition to promote`.
Il secondo sembra dire che la transizione non esiste, ed e' un permesso.

## Limiti noti, verificati

| Limite | Prova |
|---|---|
| Caricamento file nel vault | Sei tentativi distinti, tutti respinti — `File Item cannot be added`, `Can't bind model` |
| Espressioni di effettività su distinta | `definition` è un XML non documentato; Aras risponde `'named-constant' or 'constant' node must be presented` |
| Esecuzione query del Query Builder | Nessuna action AML la esegue da fuori |
| Report basati su JavaScript | `Method type not supported: JavaScript` — è codice di client |

In tutti e quattro i casi il tool corrispondente **dichiara il limite e indica
un'alternativa**, invece di fallire in modo opaco.

## Stato per area

| Area | Tool | Esito |
|---|---|---|
| Connessione e scoperta | 5 | verificati |
| Lettura e navigazione | 13 | verificati |
| Prodotto e distinta | 7 | verificati |
| Modifiche e workflow | 7 | verificati |
| Revisioni e cancellazione | 4 | verificati |
| Organizzazione e permessi | 7 | verificati |
| Ciclo di vita | 4 | verificati |
| Schema su misura | 2 | verificati |
| Analisi e report | 9 | verificati (2 con limite dichiarato) |
| Operazioni massive e AML | 7 | verificati |
| Log e diagnostica | 4 | verificati |

Le 21 operazioni di scrittura rifiutano correttamente quando
`ARAS_READONLY=true`, e funzionano su elementi usa-e-getta quando è `false`.
I dati ACME non sono mai stati modificati dal collaudo.
