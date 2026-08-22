# Walkthrough

Ten complete business flows, phrased the way someone in a company would ask.
Not tool calls — questions, each carried from the request to its conclusion.

All ten are executed by [`test-flussi.mjs`](../test-flussi.mjs): 43 assertions,
run against a live instance, writing only to `ZZF-` items and removing them
afterwards.

---

### 1. *"A designer has joined: create their account and put them in the right department."*

`aras_create_group` → `aras_create_user` → `aras_get_identity_members` → `aras_manage_membership`

A user in Aras is **three objects**: the `User`, the alias `Identity` that Aras
generates from it, and the `Member` rows pointing at groups. Creating a second
alias fails with *"cannot be greater than 1"*. The tool hides all three steps.

### 2. *"Code a new component, take it through approval, and release it."*

`aras_create_part` → `aras_get_workflow` → `aras_advance_change` → `aras_promote_item`

The part is born `Preliminary` **with its approval already open**, assigned to a
department. Nobody started the workflow by hand: the ItemType has a default
workflow and Aras instantiates it on creation. After the vote it becomes
`Released` and the process closes.

This is the flow that covers most of an engineering department's day.

### 3. *"Build an assembly with three components and tell me how many pieces I need."*

`aras_create_part` ×4 → `aras_get_bom` → `aras_where_used` → `aras_manage_bom_line` → `aras_check_release_readiness`

`where_used` is the question people ask *before* touching anything.
`check_release_readiness` answers *"can I release this assembly?"* by listing
the components that are not ready.

### 4. *"Attach a drawing and a CAD model, and check that whoever searches will find them."*

`aras_create_document` (Document) → `aras_create_document` (CAD) → `aras_get_documents`

Two different relationships in Aras, **one question** for whoever is asking.

Try `drawing_size: "A3"`. It is **rejected** — the list allows only A–E.
Validation against list values happens before the call, not as a cryptic error
coming back from the server.

### 5. *"Approve a manufacturer for this component and tell me their part number."*

`aras_add_manufacturer_part` → `aras_get_aml`

The approved manufacturer list is what purchasing needs to evaluate a second
source.

### 6. *"Open a change request on the component, advance it, and tell me what it affects."*

`aras_create_change` → `aras_get_change_impact` → `aras_get_workflow` → `aras_advance_change`

The change does not point at the Part directly but at an intermediate
`Affected Item`. A naive query returns an opaque id. The workflow starts on its
own, says **who is blocking it**, and `dryRun` shows what advancing would do
before doing it.

### 7. *"Replace a component across every BOM — but first tell me where it would land."*

`aras_replace_component` with `dryRun: true`, then `false` → `aras_get_bom`

`dryRun` is **on by default** for every bulk operation. To actually write, you
have to ask.

### 8. *"The released component needs revising: create the next revision."*

`aras_new_revision` → `aras_get_revisions`

OData is **blind** to past generations. This goes through AML, with the
`lock → version → unlock` sequence Aras insists on.

### 9. *"Try to delete a component that a BOM still uses: it must refuse."*

`aras_plan_delete` → `aras_get_type_permissions` → `aras_lookup_error`

A reasoned refusal naming the relationship that blocks it. `plan_delete` also
reports `-1` for relationships it **could not verify**, rather than pretending
they are empty — an honest check beats one that reassures you for free.

### 10. *"Clean everything up and prove production data was not touched."*

Deletions from assembly down to components, then verification counts.

Order matters. Deleting the component before the assembly **fails**: Aras
refuses while a BOM line still references it.

---

## Running all ten

```bash
node test-flussi.mjs
```

Roughly two minutes. It creates, verifies and removes everything itself, and
ends by checking that the sample product family and its change orders are
untouched.
