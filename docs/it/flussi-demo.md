# Le dieci domande della demo

Non chiamate a tool: **domande in italiano**, come le porrebbe qualcuno in azienda.
Ognuna è un flusso intero, e ognuna è collaudata da `node test-flussi.mjs`
(43 verifiche, 0 fallite).

Ogni riga *Da dire* è il commento da fare **mentre gira**, non dopo.

---

## 1. «È entrato un progettista: creagli l'utenza e mettilo nel reparto giusto.»

| | |
|---|---|
| Cosa fa | `aras_create_group` → `aras_create_user` → `aras_get_identity_members` → `aras_manage_membership` |
| Cosa aspettarsi | Utenza creata, reparto che la conta fra i membri, revoca che la toglie davvero |

*Da dire:* in Aras un utente è **tre oggetti** — lo `User`, l'`Identity` alias che
Aras genera da sé, e le righe `Member` verso i gruppi. Creare un secondo alias
fallisce con *«cannot be greater than 1»*. Il tool nasconde i tre passi.

---

## 2. «Codifica un nuovo componente, portalo in approvazione e rilascialo.»

| | |
|---|---|
| Cosa fa | `aras_create_part` → `aras_get_workflow` → `aras_advance_change` → `aras_promote_item` |
| Cosa aspettarsi | Il componente nasce `Preliminary` **con l'approvazione già in corso**, assegnata ad ACME Engineering; dopo il voto diventa `Released` e il processo si chiude |

*Da dire:* nessuno ha avviato il workflow a mano. La Part ha un **workflow
predefinito** (`ZZ Rilascio Semplice`) e Aras lo istanzia alla creazione.
È il flusso che copre il 90% delle giornate in un ufficio tecnico.

**È il pezzo forte: fallo per primo se hai poco tempo.**

---

## 3. «Costruisci un assieme con tre componenti e dimmi quanti pezzi servono.»

| | |
|---|---|
| Cosa fa | quattro `aras_create_part` → `aras_get_bom` → `aras_where_used` → `aras_manage_bom_line` → `aras_check_release_readiness` |
| Cosa aspettarsi | Distinta a tre righe con quantità 2 / 4 / 1; il componente sa dove è montato; cambiando la quantità a 6 la distinta lo riflette |

*Da dire:* `where_used` è la domanda che ci si fa **prima** di toccare qualcosa.
E `check_release_readiness` risponde a *«posso rilasciare l'assieme?»* elencando
i pezzi che non sono pronti.

---

## 4. «Allega disegno e modello CAD al componente, e verifica che li trovi chi cerca.»

| | |
|---|---|
| Cosa fa | `aras_create_document` (Document) → `aras_create_document` (CAD) → `aras_get_documents` |
| Cosa aspettarsi | Due relazioni diverse in Aras, **una sola domanda** per chi chiede |

*Da dire:* prova a scrivere `drawing_size: "A3"`. Viene **rifiutato**: la lista
ammette solo A–E. La validazione sui valori di lista è a monte della chiamata,
non un errore criptico che arriva dal server.

---

## 5. «Omologa un costruttore per questo componente e dimmi il suo codice.»

| | |
|---|---|
| Cosa fa | `aras_add_manufacturer_part` → `aras_get_aml` |
| Cosa aspettarsi | Il codice costruttore compare nell'elenco fornitori approvati |

*Da dire:* è la lista che serve agli acquisti per valutare una second source.

---

## 6. «Apri una richiesta di modifica sul componente, falla avanzare e dimmi cosa impatta.»

| | |
|---|---|
| Cosa fa | `aras_create_change` → `aras_get_change_impact` → `aras_get_workflow` → `aras_advance_change` (prima `dryRun`, poi reale) |
| Cosa aspettarsi | La ECR nasce col suo workflow attivo, dice **chi la sta bloccando**, e il dryRun mostra cosa farebbe prima di farlo |

*Da dire:* la ECR non punta alla Part ma a un oggetto intermedio, `Affected Item`.
Una query diretta restituirebbe un id opaco.

---

## 7. «Sostituisci un componente in tutte le distinte, ma prima dimmi dove finirebbe.»

| | |
|---|---|
| Cosa fa | `aras_replace_component` con `dryRun: true`, poi `dryRun: false` → `aras_get_bom` |
| Cosa aspettarsi | Il dryRun elenca le righe e **non tocca nulla**; poi la distinta monta il codice nuovo |

*Da dire:* `dryRun` è **attivo per default** su tutte le operazioni massive.
Per scrivere davvero bisogna chiederlo.

---

## 8. «Il componente rilasciato va rivisto: creane la revisione successiva.»

| | |
|---|---|
| Cosa fa | `aras_new_revision` → `aras_get_revisions` |
| Cosa aspettarsi | Due generazioni, la 1 e la 2 |

*Da dire:* OData è **cieco** alle generazioni passate. Questo passa da AML,
con la sequenza `lock → version → unlock` che Aras pretende.

---

## 9. «Prova a cancellare un componente montato in una distinta: deve rifiutare.»

| | |
|---|---|
| Cosa fa | `aras_plan_delete` → `aras_get_type_permissions` → `aras_lookup_error` |
| Cosa aspettarsi | Rifiuto motivato, con la relazione che lo blocca; i permessi di un tipo leggibili; un errore Aras decifrato |

*Da dire:* `plan_delete` dichiara anche `-1` sulle relazioni che **non ha potuto
verificare**, invece di fingere che siano vuote. È la differenza fra un controllo
onesto e uno che rassicura a vuoto.

---

## 10. «Ripulisci tutto e dimostrami che i dati di produzione non sono stati toccati.»

| | |
|---|---|
| Cosa fa | cancellazioni in ordine assieme → componenti, poi conteggi di controllo |
| Cosa aspettarsi | Zero elementi `ZZF-`, 8 Part `PMP-` intatte, 15 Part `AD-30xx` ancora `Released`, `ECR-100001` al suo posto |

*Da dire:* l'ordine conta. Cancellare prima il componente e poi l'assieme
**fallisce**: Aras rifiuta finché la riga di distinta lo referenzia.

---

# Come lanciarle

**Tutte insieme, senza toccare niente a mano** — ~2 minuti:

```
node test-flussi.mjs
```

Crea, verifica e rimuove tutto da sé, e chiude controllando che i dati di
produzione siano intatti.

**Una alla volta, a voce**, chiedendole a Claude in linguaggio naturale: è il
modo che rende l'idea. I tool li sceglie lui.

---

# Cosa c'è già dentro, prima di iniziare

| | |
|---|---|
| Utenti `ARAS DEMO` | 10, nei reparti ACME, gruppo `ARAS DEMO` |
| Part `AD-3001…3015` | intestate a **Davide Romano**, tutte `Released` |
| Mappa di workflow | `ZZ Rilascio Semplice`: Start → Approvazione Tecnica → Rilasciata \| Respinta |
| Dati ACME | pompa `PMP-2000` e figli, disegni, ECR/ECN — mai modificati |

Il `ZZ Rilascio Semplice` è **il workflow predefinito delle Part**: da ora ogni
Part creata parte con l'approvazione aperta. Per tornare indietro:

```
node tools/rilascio-parti-demo.mjs --pulisci
```

---

# Se qualcosa va storto dal vivo

| Sintomo | Rimedio |
|---|---|
| «User is not from allowed identity» | Chi vota non è nell'identità assegnataria: `aras_get_workflow` dice a chi è assegnata |
| «failed to get the transition» | Non è un difetto, è un **permesso**: manca il ruolo della transizione |
| Una Part non si cancella | È referenziata: `aras_plan_delete` dice da cosa |
| `aras_ping` non risponde | `iisreset` da prompt amministratore |
