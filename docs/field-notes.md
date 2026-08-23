# Field notes

What live testing against a real Aras Innovator 2025 instance actually surfaced:
the defects it found in this server, the behaviours of Aras that cost hours, one
limit that turned out not to be one, and four that genuinely are.

This file exists because a project that only publishes what works is not telling
you enough to trust it.

---

## Defects this found in the server

**`aras_get_relationships` returned rows with no references.** It queried
without `$select`, and in that case Aras does not emit the `related_id@aras.*`
annotations at all: the result was opaque metadata that never said what it
pointed at. This is the same trap documented in the README — the tool had fallen
into it. Fixed: every row now carries the target, its id, and the relationship's
own properties.

**The property filter cut the ones that mattered.** It took the first ten
properties alphabetically, and `quantity` sorts after `new_version` and
`not_lockable`: the output showed noise and omitted the useful field. Exclusion
is now by name, not by position.

**`aras_list_dashboards` always returned `contenuti: []`.** A generic
`<Item action="get"/>` inside `<Relationships>` returns nothing; the
RelationshipTypes of the type have to be enumerated and queried one at a time.

**`aras_run_query` propagated an unintelligible fault.** Six AML actions were
tried; none executes a saved `qry_QueryDefinition` from outside. The tool now
declares the limit, returns the query's structure, and points at the equivalent
tools.

**`aras_check_effectivity` lied in its own description**, claiming the
Effectivity module was not installed. That was a wrong conclusion left in the
text. The module is there, prefixed `effs_`.

**Workflows would not advance.** `aras_advance_change`, `aras_vote_activity`
and `aras_delegate_activity` all failed with `An internal error has occured` — a
message that tells you nothing. Two distinct causes, found one at a time:

1. Aras wants the **id** of the exit path, not its name. Paths are
   `Workflow Process Path` rows starting at the activity, and no tool exposed
   them, so callers were guessing. `aras_get_workflow` now returns them.
2. The `EvaluateActivity` needs a **`<Complete>1</Complete>`** element. This one
   only turned up in the server log, after enabling it: the public message stays
   generic, but the log says
   `Workflow: EvaluateActivity: Complete value not found`.

**Revoking a permission left orphan rows.** Zeroing the flags on an `Access` row
left it present but inert, cluttering the Permission. Zeroing them all now
removes the row.

**A refused delegation did not explain itself.** Aras checks that the delegator
belongs to the assignee identity and answers `User is not from allowed identity`
— a legitimate refusal, not a fault. The tool now says who the activity is
assigned to and how to fix it.

**`aras_create_document` reported success without linking.** If a Document or
CAD with that number already existed, it returned early with the id and ignored
`perPart`: no relationship, and no way for the caller to notice. The failure was
intermittent, because it only appeared after an interrupted run had left the
document behind. The document is now reused *and* linked, without duplicating
the row, and the link is **verified** rather than announced.

---

## Building a workflow map from outside

Aras ships no release workflow for Parts. Building one through AML surfaced
three behaviours that produce no error, which is why they cost hours.

**`<ApplyItem>` applies exactly one `<Item>`.** An `<AML>` batch with several
elements is accepted, answers without a fault, and executes **only the first**.
The map came back reported as created while being an empty shell — no
activities, no paths. Every element needs its own call.

**`Activity Template` is a dependent ItemType.** Created on its own it answers
`Dependent Activity Template cannot be create: source item not found`. It has to
be created **inside** the `related_id` of the `Workflow Map Activity` row that
binds it to the map — the same rule as `Affected Item`.

**`where="[Type].name='...'"` does not survive ItemType names with spaces.**
Aras rejects the table reference and returns **zero rows with no error**, so the
calling code concludes the item does not exist and creates a duplicate. Matching
by property works:
`<Item type="Workflow Map" action="get"><name>…</name></Item>`.

**Automatic process start.** Aras instantiates the workflow when an item is
created if its ItemType has an `Allowed Workflow` row with `is_default=1`.
Writing the row is not enough: ItemType metadata is cached, and until it is
invalidated the row has no effect. An `edit` on the ItemType — even to an
unchanged value — invalidates it without restarting IIS.

The `instantiateWorkflow` AML action, meanwhile, is not usable from an external
client. With the `id` attribute it answers `idlist cannot be empty`; without it,
`"" is not a valid id`, thrown from `GetInstanitationProcessItemInfoHandler`.
Seven encodings were tried. The workable route is the default workflow.

**Two denials that look like faults.** Voting an activity without belonging to
the assignee identity gives `User is not from allowed identity`. Promoting
without the role the transition requires gives
`failed to get the transition to promote`. The second one reads as though the
transition does not exist; it is a permission.

## Reading file content: solved

The README used to claim that downloading vault files worked. It did not — the
server handed back a URL and nothing fetched it — and the claim had never been
tested, because the instance held zero File items. Upload is blocked from
outside, so there had never been a file to download.

Resolved by uploading one through the Aras interface and then measuring. **Two
routes both return the bytes**, with the same OAuth token the rest of the server
uses:

| Route | Result |
|---|---|
| `GET {baseUrl}/Server/OData/File('<id>')/$value` | 200, correct `Content-Type`, exact bytes |
| `GET {baseUrl}/vault/vaultserver.aspx?dbName=..&fileId=..` | 200, identical |

The OData media resource is the one used, because it goes through the same
client and token as everything else; the vault endpoint stays as a fallback,
since on installations with a remote vault it is the only one that answers.

`aras_read_file` builds on that: text for text formats, extracted text for PDFs,
and the image itself for PNG/JPEG/GIF/WebP so a model can look at it. PDF text
extraction is dependency-free — `zlib` inflates the `FlateDecode` content
streams and the `Tj`/`TJ` operators are read out of them. A scanned drawing has
no text operators, and the tool says it would need OCR rather than returning an
empty string and letting the caller assume the page was blank.

---

## Verified limits

Five things cannot be done from an external client. Each affected tool declares
the limit and points at an alternative instead of failing opaquely.

| Limit | Evidence |
|---|---|
| **Uploading** files to the vault | Six distinct attempts, all rejected: `File Item cannot be added`, `Can't bind model`. The Programmer's Guide documents only client-side JavaScript (`aras.vault.selectFile`) and server-side C# (`setFileProperty`, taking a path local to the **server**). Reading is a different story — see below |
| Effectivity expressions on a BOM | `definition` is an undocumented XML dialect; Aras answers `'named-constant' or 'constant' node must be presented` |
| Executing Query Builder queries | No AML action runs a saved query definition from outside |
| JavaScript-based reports | `Method type not supported: JavaScript` — it is client code |
| Node coordinates on a workflow map | `x` and `y` are **not declared properties** of `Workflow Map Activity` — `describe_item_type` lists 27 and neither is among them. Aras stores and returns them anyway (a stock row reads `x=244, y=95`), but writing them from outside returns 200, bumps `modified_on`, and leaves the default `10,10`. The designer writes them by a private path |

Only **uploading** is blocked. Reading file content works and is verified — see
the section above.

The last row is the inverse of the annotation trap. There, data existed under a
name you had to know; here it exists under a plain name the schema denies. A
workflow map built from outside therefore always renders with its nodes stacked
at the origin — the process runs correctly, but someone has to drag the boxes
apart once in the designer. Found by opening the map in Aras's own editor, which
is the sort of thing a self-check cannot see.

---

## Coverage

| Area | Tools | Status |
|---|---|---|
| Connection and discovery | 5 | verified |
| Reading and navigation | 14 | verified (including file content) |
| Product and BOM | 7 | verified |
| Change and workflow | 7 | verified |
| Revisions and deletion | 4 | verified |
| Organisation and permissions | 7 | verified |
| Lifecycle | 4 | verified |
| Custom schema | 2 | verified |
| Analytics and reports | 9 | verified (2 with a declared limit) |
| Bulk operations and AML | 7 | verified |
| Logs and diagnostics | 4 | verified |

All 21 write operations refuse correctly when `ARAS_READONLY=true`, and work on
throwaway items when it is `false`.
