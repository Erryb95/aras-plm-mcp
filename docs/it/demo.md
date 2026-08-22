# Copione della demo

Un esempio eseguibile per ogni funzionalità, in ordine di racconto.
Ogni blocco è una domanda in linguaggio naturale seguita dal tool che la risolve.

> Per la versione **a flussi interi** — dieci domande che vanno dalla richiesta
> alla conclusione — vedi [DEMO-FLUSSI.md](DEMO-FLUSSI.md), collaudato da
> `node test-flussi.mjs` (43 verifiche).

**Prima di iniziare**, un solo controllo:

```
aras_ping
```

Deve rispondere `InnovatorSolutions`, `admin`, `484` ItemType, `readOnly: true`.
Se non risponde, Aras non è avviato: `iisreset` da un prompt amministratore.

---

## Atto I — Dalla domanda alla risposta

Il filo conduttore: **so solo una parola**, e arrivo a una risposta operativa.

### 1. Non so nemmeno dove cercare

> *«Qualcuno ha segnalato un problema di cavitazione. Cosa c'è in Aras?»*

```
aras_search   term: "cavitazione"
```

Interroga **sette ItemType in parallelo**, costruendo per ciascuno un filtro solo
sui campi testuali che quel tipo possiede davvero. Trova `ECR-100001` e `ECN-100001`.

*Da dire:* Aras non ha una ricerca globale. Con 484 tipi, senza questo devi già
sapere dove guardare.

### 2. Cosa dice la segnalazione

```
aras_get_item   itemType: "ECR"   id: "09A25FA7FEC74926B5C3908B3FEFC13B"
```

### 3. Cosa impatta davvero

```
aras_get_change_impact   changeType: "ECR"   changeId: "09A25FA7FEC74926B5C3908B3FEFC13B"
```

Risponde `PMP-2110`. *Da dire:* in Aras la relazione non punta alla Part ma a un
oggetto intermedio, `Affected Item`. Una query diretta restituirebbe un id opaco.

### 4. Se cambio quel pezzo, cosa si muove

```
aras_where_used   partId: "EFF354DBADF84DD0BC2D6C0DA8F11B67"   depth: 5
```

Risale fino a `PMP-2000`. È l'inverso della distinta, e la domanda che si fa
prima di toccare qualcosa.

### 5. Quale documentazione va aggiornata

```
aras_get_documents   partId: "EFF354DBADF84DD0BC2D6C0DA8F11B67"
```

`DRW-2110` e `CAD-2110`. Due relazioni distinte in Aras, una sola domanda per chi chiede.

### 6. A che punto è la modifica, e chi la blocca

```
aras_get_workflow   itemId: "09A25FA7FEC74926B5C3908B3FEFC13B"
```

Processo `Active`, 13 attività, `Submit ECR` in carico a `Innovator Admin`.
**Guarda `vie`**: sono le uscite percorribili — senza quelle non si vota.

### 7. Verifica incrociata

```
aras_get_inbasket   identityId: "DBA5D86402BF43D5976854B8B48FCDD1"
```

Un solo compito aperto: `Submit ECR`. Due tool che percorrono strade diverse nel
data model convergono. *Da dire:* è questo che rende il risultato credibile.

---

## Atto II — Il prodotto

### 8. Da cosa è composto

```
aras_get_bom   partId: "6E9D0798F21C4B63BA8BB2D4E2CC28BF"   depth: 4
```

Nota `HW-0010` in **due rami**, con quantità cumulate 8 e 4. La matematica
multilivello, con rilevamento cicli per ramo.

### 9. Fornitori omologati

```
aras_get_aml   partId: "229EC928CC40475C9D1A1017B85223A4"
```

`BN-6912-A2 — Bossard Italia`.

### 10. Le righe di una relazione, con quantità

```
aras_get_relationships   relationshipType: "Part BOM"   sourceId: "106BA71E80674E5C85CCF90179774050"
```

Ogni riga dice `verso` e `quantity`.

### 11. Storico delle revisioni

```
aras_get_revisions   itemType: "Part"   id: "75ED1B58330044B096680AB96CEC64A1"
```

Due generazioni: la 1 in `Preliminary`, la 2 `Released`. *Da dire:* OData è cieco
alle generazioni passate — questo passa da AML.

### 12. Chi ha fatto cosa

```
aras_get_history   itemType: "ECR"   id: "09A25FA7FEC74926B5C3908B3FEFC13B"
```

### 13. Era valida a una certa data

```
aras_check_effectivity   partIds: ["6E9D0798F21C4B63BA8BB2D4E2CC28BF"]   data: "2026-01-15"
```

---

## Atto III — Le protezioni

Il pezzo che racconta la qualità del lavoro meglio di qualunque elenco.

### 14. Cosa succederebbe se cancellassi

```
aras_plan_delete   itemType: "Part"   id: "229EC928CC40475C9D1A1017B85223A4"   modo: "delete"
```

Si **rifiuta**: la vite è referenziata in `Part BOM` e `Part AML`. E dichiara `-1`
sulle relazioni che **non ha potuto verificare**, invece di fingere che siano vuote.

*Da dire:* questa è la differenza fra un controllo onesto e uno che rassicura a vuoto.

### 15. Perché non riesco a creare un fornitore

```
aras_get_type_permissions   itemType: "Manufacturer"
```

Serve `Component Engineering`, che `admin` non ha. *Da dire:* Aras restituisce i
dinieghi di permesso come errore **500 generico**, non 403.

### 16. Decifrare un errore Aras

```
aras_lookup_error   testo: "no default permission"
```

`UserMessage` è il catalogo di tutti i messaggi del server.

### 17. Un'operazione massiva mostra prima cosa farà

```
aras_replace_component   vecchio: "HW-0010"   nuovo: "HW-0020"   dryRun: true
```

Trova le 2 righe in `PMP-2100` e `PMP-2200`. **`dryRun` è attivo per default** su
tutte le operazioni massive.

```
aras_bulk_update   itemType: "Part"   filtro: "startswith(item_number,'PMP-')"   valori: {"description":"x"}   dryRun: true
```

---

## Atto IV — Il ciclo di vita

### 18. Il grafo, con i ruoli

```
aras_get_lifecycle_map   nomeMappa: "Part"
```

Ogni transizione ha un **ruolo richiesto**.

### 19. Cosa posso fare io, e cosa mi blocca

```
aras_get_lifecycle_state   itemType: "Part"   id: "EFF354DBADF84DD0BC2D6C0DA8F11B67"
```

*Da dire:* se non hai il ruolo, `getItemNextStates` torna **vuoto** e `promoteItem`
fallisce con un messaggio che sembra dire *"transizione inesistente"* mentre è un
problema di autorizzazione. È costato un'ora scoprirlo.

### 20. Il piano di rilascio

```
aras_release_item   itemType: "Part"   id: "EFF354DBADF84DD0BC2D6C0DA8F11B67"   dryRun: true
```

### 21. L'assieme è pronto?

```
aras_check_release_readiness   partId: "6E9D0798F21C4B63BA8BB2D4E2CC28BF"
```

Elenca i componenti non ancora rilasciati.

---

## Atto V — Configurazione e diagnostica

### 22. Schema di un tipo

```
aras_describe_item_type   itemType: "Part"
```

41 proprietà tipizzate, obbligatorietà reale, relazioni uscenti.

### 23. Valori ammessi dalle liste

```
aras_get_list_values   itemType: "Part"
```

`make_buy = Make|Buy`. *Da dire:* scrivere `"make"` minuscolo supera la validazione
dello schema — il nome della proprietà esiste — e viene rifiutato da Aras.

### 24. Cruscotti e metriche già configurati

```
aras_list_dashboards
aras_list_metrics   filtro: "ECR"
```

### 25. Effettività

```
aras_get_effectivity_config
```

Scope, variabili `Model`/`Unit`/`Date`, modelli `CP-40` e `CP-60`.

### 26. Log del server

```
aras_get_logs   righe: 20   filtro: "OData"
```

*Da dire:* il logging era spento (`MinimumLevel: Fatal`). Attivandolo si è
scoperto perché i workflow non avanzavano — il messaggio pubblico era generico,
nel log c'era `Complete value not found`.

### 27. Altre viste

```
aras_list_item_types   search: "change"
aras_list_reports
aras_list_queries
aras_list_sequences
aras_list_methods   cerca: "effs"
aras_get_identity_members   identityId: "AB39BA0265814FABAD53F6886219FB7E"
aras_get_permission_detail   nomePermesso: "New Part"
aras_export_aml   itemType: "Part"   filtro: "[Part].item_number like 'PMP-21%'"
```

---

## Atto VI — Scrittura (opzionale, richiede `ARAS_READONLY=false`)

> In sola lettura ogni scrittura risponde `"Server in sola lettura"`. È di per sé
> una buona dimostrazione: mostra un `aras_create_part` che rifiuta.

Se vuoi mostrare le scritture, usa **solo prefissi `ZZ-`** e ripulisci alla fine.

> **Da sapere:** le Part hanno ora un workflow predefinito, `ZZ Rilascio
> Semplice`. Ogni `aras_create_part` fa partire da sé l'approvazione, assegnata
> ad `ACME Engineering`. Si vede con `aras_get_workflow` sull'id restituito, e si
> chiude con `aras_advance_change ... via: "Approva"` seguito da
> `aras_promote_item ... toState: "Released"`.
> Per togliere il predefinito: `node tools/rilascio-parti-demo.mjs --pulisci`.

```
aras_create_part          item_number: "ZZ-DEMO-1"  name: "Prova"  make_buy: "Make"
aras_create_part          item_number: "ZZ-DEMO-2"  make_buy: "Buy"  sottoAssieme: "ZZ-DEMO-1"  quantita: 4
aras_manage_bom_line      azione: "aggiorna"  assieme: "ZZ-DEMO-1"  componente: "ZZ-DEMO-2"  quantita: 6
aras_create_document      tipo: "Document"  item_number: "ZZ-DEMO-D"  drawing_size: "A"  perPart: "ZZ-DEMO-1"
aras_copy_part            origine: "ZZ-DEMO-1"  nuovo: "ZZ-DEMO-3"
aras_create_change        tipo: "ECR"  title: "ZZ demo"  impattati: [{"itemType":"Part","itemNumber":"ZZ-DEMO-1"}]
aras_create_group         nome: "ZZ Reparto"
aras_create_user          login: "zzdemo"  nome: "Zz"  cognome: "Demo"  gruppi: ["ZZ Reparto"]
```

**Il pezzo forte**, se il tempo lo consente: creare un ItemType su misura con le
sue istanze — quello che sembrava impossibile.

```
aras_create_item_type   nome: "ZZ_Progetto"   etichetta: "Progetto"
                        permissionName: "New Part"   canAddIdentity: "Aras PLM"
                        proprieta: [{"nome":"codice","tipo":"string","lunghezza":32},
                                    {"nome":"titolo","tipo":"string","lunghezza":128}]
aras_create_item        itemType: "ZZ_Progetto"   properties: {"codice":"PRJ-001","titolo":"Nuova linea"}
aras_query_items        itemType: "ZZ_Progetto"   select: ["codice","titolo"]
```

**Pulizia** — l'ordine conta: prima le modifiche, poi gli assiemi, poi i componenti.

```
aras_plan_delete    itemType: "Part"  id: "<id di ZZ-DEMO-1>"  modo: "delete"
aras_delete_item    itemType: "Part"  id: "<id>"  modo: "delete"  conferma: true  ignoraAvvertenze: true
```

Oppure, più semplice, da terminale:

```
node test-writepath.mjs
```

che crea, verifica e rimuove tutto da sé, e chiude controllando che i dati ACME
siano intatti.

---

## Cosa NON mostrare

Quattro cose non funzionano da un client esterno, e **non per una svista**. Se
qualcuno chiede, la risposta onesta è più forte di una scusa.

| | Perché |
|---|---|
| Caricamento file nel vault | Sei tentativi verificati: `File Item cannot be added`, `Can't bind model` |
| Espressioni di effettività | `definition` è un XML non documentato |
| `aras_run_query` | Nessuna action AML esegue una query salvata da fuori |
| Report JavaScript | `Method type not supported: JavaScript` — è codice di client |

Ognuno dei quattro tool **dichiara il limite e indica un'alternativa** invece di
fallire in modo opaco. Volendo, è una dimostrazione in sé:

```
aras_run_report   nome: "BOM Costing Report"   contestoId: "6E9D0798F21C4B63BA8BB2D4E2CC28BF"
```

---

## Se qualcosa va storto

| Sintomo | Rimedio |
|---|---|
| `aras_ping` non risponde | `iisreset` da prompt amministratore |
| Un tool nuovo non compare | Riavvia Claude Code: la connessione MCP è precedente |
| Una scrittura viene rifiutata | `aras_get_type_permissions` sull'ItemType |
| Un errore Aras incomprensibile | `aras_lookup_error` col testo ricevuto, oppure `aras_get_logs` con `filtro: "Exception"` |
| Un id non esiste più | Una promozione crea una nuova generazione: ritrova l'id con `aras_query_items` per `item_number` |

Oltre ai dati ACME, l'istanza contiene la famiglia **`AD-3001…3015`** —
quindici Part intestate a **Davide Romano**, tutte `Released` passando dal
workflow di approvazione — e i **dieci utenti della società `ARAS DEMO`**
distribuiti nei reparti ACME. Le utenze non hanno password: servono come
assegnatari e proprietari, non per il login.

Gli id in questo file sono quelli attuali dei dati ACME. Se un rilascio li cambia,
`aras_search` con il codice li ritrova in un colpo.
