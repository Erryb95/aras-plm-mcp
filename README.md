# aras-plm-mcp

An MCP server for **Aras Innovator PLM** that knows the schema instead of guessing it.

71 tools over OData **and** AML. Tested against a live Aras Innovator 2025 (14.35.0)
instance: **260 assertions across ten suites, plus a 39-step demo script executed
end to end. Every one of the 71 tools is exercised by at least one suite, and
every write tool is exercised performing a real write.**

---

## The problem

Aras Innovator's OData API is *dynamic*. The service document answers
`501 Not Implemented`, and a stock instance exposes **484 ItemTypes** whose names
and properties depend on how the administrator configured the data model. There is
no static catalogue to read.

A thin HTTP wrapper — `get_items(itemtype, filter)` — pushes that problem onto the
model. It has to guess that the type is `Part` and not `Parts`, that the bill of
materials is `Part BOM` and not `BOM`, that the quantity field is `quantity` and not
`qty`. Every wrong guess is a round trip and an opaque error.

This server introspects the schema and hands it back.

```
aras_describe_item_type  itemType: "Part"
  → 41 typed properties, real mandatory flags, outgoing relationships
```

## What OData alone cannot see

Three things in Aras are invisible to OData, and each one is a question people
actually ask. This server reaches them through AML:

| Question | Why OData fails | How it's answered |
|---|---|---|
| *"Show me the previous revisions."* | OData returns only the current generation — `is_current eq '0'` yields zero rows | `getItemAllVersions` |
| *"Release this part."* | Lifecycle transitions are not exposed as data | `promoteItem`, with the required role resolved first |
| *"Advance this change order."* | — | `EvaluateActivity`, including the undocumented `<Complete>1</Complete>` |

That last one took a server log to find. Aras answers `An internal error has occured`;
the log says `Workflow: EvaluateActivity: Complete value not found`.

---

## Tools

<details>
<summary><b>Discovery and schema</b> — 6</summary>

| Tool | What it does |
|---|---|
| `aras_ping` | Connection, database, user, ItemType count |
| `aras_list_item_types` | List/search ItemTypes, tolerant of typos |
| `aras_describe_item_type` | Typed properties, mandatory flags, outgoing relationships |
| `aras_search` | **Cross-type search** over several ItemTypes at once |
| `aras_get_list_values` | Allowed values for list-backed properties |
| `aras_how_to` | **Consult before attempting**: what works from outside, and why an error means what it means |

</details>

<details>
<summary><b>Reading and navigation</b> — 14</summary>

`aras_query_items`, `aras_get_item`, `aras_get_relationships`, `aras_get_bom`,
`aras_where_used`, `aras_get_documents`, `aras_get_aml`, `aras_get_files`,
`aras_read_file`, `aras_get_history`, `aras_get_revisions`, `aras_get_my_identities`,
`aras_get_identity_members`, `aras_export_aml`

</details>

<details>
<summary><b>Product and BOM</b> — 7</summary>

`aras_get_bom` (recursive explosion with cumulative quantities and per-branch cycle
detection), `aras_manage_bom_line`, `aras_replace_component`, `aras_copy_part`,
`aras_add_manufacturer_part`, `aras_check_release_readiness`, `aras_check_effectivity`

</details>

<details>
<summary><b>Change and workflow</b> — 7</summary>

`aras_create_change`, `aras_add_affected_item`, `aras_get_change_impact`,
`aras_get_workflow`, `aras_advance_change`, `aras_vote_activity`,
`aras_delegate_activity`

</details>

<details>
<summary><b>Lifecycle, org, schema, analytics, diagnostics</b> — 37</summary>

Lifecycle maps and states with the role each transition requires; users, groups,
memberships and permissions; **creating ItemTypes with working instances**;
dashboards, metrics, reports, saved queries, sequences, methods; server logs from
both the Serilog files and the `SystemEventLog` ItemType.

</details>

Run `aras_ping` first — it tells you what you're connected to.

---

## Consult before attempting

`aras_how_to` answers *"how do I do X from an external client"* and *"why this
error"* before the model starts guessing.

It deliberately does **not** index Aras's official documentation. That corpus
describes client-side JavaScript and server-side C# — precisely the routes that
do not work from outside — so it would confidently point at dead ends. The
Programmer's Guide's answer to attaching a file is `aras.vault.selectFile`,
which only exists inside the Aras client.

It draws on two sources that are actually reliable:

1. **Knowledge verified against a live instance**, with the exact message Aras
   returns. `<Complete>1</Complete>`, `<ApplyItem>` applying only the first
   element of a batch, dependent ItemTypes having to be created inside the
   relationship — none of this is in any manual.
2. **The instance itself** — its `UserMessage` catalogue and installed
   `Method`s. That is the truth of *that* installation rather than a generic one.

And it says so when it does not know, instead of returning the nearest match.
A tool that answers everything is as useless as one that answers nothing.

## Design decisions worth knowing

**Read-only by default.** Writes to a PLM are versioned and audited, so they are
enabled on purpose: `ARAS_READONLY=false`. Every one of the 21 write tools refuses
politely while it is `true`.

**`dryRun` defaults to *on* for bulk operations.** `aras_replace_component` and
`aras_bulk_update` show you the affected rows and change nothing until you ask.

**Writes are read back.** `aras_create_item`, `aras_update_item` and
`aras_create_part` re-read the item after writing and return
`proprietaNonApplicate` for anything that did not land. Aras accepts and silently
ignores some properties — `cost` on a `Part` is computed by the rollup, so
setting it returns no error and has no effect. Without reading back, the caller
believes it wrote something that is not there.

**Deletion is planned before it is done.** `aras_plan_delete` reports what
references the item and refuses when something does. Where it could not verify a
relationship it returns `-1` rather than pretending the relationship is empty — an
honest check beats one that reassures you for free.

**Permission denials are decoded.** Aras returns a generic **HTTP 500** for a denied
permission, not a 403. `aras_get_type_permissions` tells you which identity is
missing; `aras_lookup_error` looks up the message in the `UserMessage` catalogue.

**Item references only arrive as annotations, and only with `$select`.** Querying
`Part BOM` *with* `$select` yields `related_id@aras.id` and `related_id@aras.keyed_name`;
*without* it, nothing comes back at all and the rows look like opaque metadata. This
is encoded once in `readItemRef()` (`src/aras/odata.ts`) so no caller has to remember
it. It is also the single easiest way to build a BOM explorer that silently returns
an empty tree.

---

## Install

```bash
npm install
npm run build
```

Copy `.env.example` to `.env` and fill it in. For Claude Code, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "aras-plm": {
      "command": "node",
      "args": ["/path/to/aras-plm-mcp/dist/index.js"],
      "env": {
        "ARAS_URL": "http://localhost/InnovatorServer",
        "ARAS_DATABASE": "InnovatorSolutions",
        "ARAS_USER": "admin",
        "ARAS_PASSWORD": "…",
        "ARAS_CLIENT_ID": "IOMApp",
        "ARAS_READONLY": "true"
      }
    }
  }
}
```

Authentication is OAuth 2.0 Resource Owner Password Credentials against the
`IOMApp` client, scope `Innovator`.

Requires Node 20+ and an Aras Innovator instance you are allowed to talk to.

---

## Testing

Every suite runs against a live instance, writes only to items prefixed `ZZ-`, and
removes them afterwards. The last flow asserts that production data was untouched.

```bash
node test-flussi.mjs      # ten whole business flows, request to conclusion
node test-demo.mjs        # the 39 blocks of the demo script, one by one
node test-full.mjs        # connection, discovery, reading, navigation
node test-product.mjs     # BOM, where-used, AML, documents, revisions
node test-lifecycle.mjs   # lifecycle, transitions, roles
node test-schema.mjs      # custom ItemTypes and properties
node test-admin.mjs       # identities and permissions
node test-analytics.mjs   # dashboards, metrics, effectivity
node test-reports.mjs     # reports, saved queries, sequences, methods
node test-write.mjs       # read-only refusals
node test-writepath.mjs   # real writes, created and removed
```

`test-flussi.mjs` is the interesting one. It doesn't test tools — it tests
**questions**, the way someone in a company would ask them:

> *"A designer has joined: create their account and put them in the right department."*
> *"Code a new component, take it through approval, and release it."*
> *"Replace a component everywhere, but first tell me where it would land."*
> *"Try to delete a component that's used in a BOM: it must refuse."*

---

## What does not work, and why

Five things are unreachable from an external client. **This is not an oversight**,
and each affected tool says so and points at the alternative instead of failing
opaquely.

| | Evidence |
|---|---|
| Uploading files to the vault | Six distinct attempts, all rejected: `File Item cannot be added`, `Can't bind model`. The Programmer's Guide documents only client-side JavaScript (`aras.vault.selectFile`) and server-side C# (`setFileProperty`, with a path local to the *server*) |
| Effectivity expressions on a BOM | `definition` is an undocumented XML dialect; Aras replies `'named-constant' or 'constant' node must be presented` |
| Executing Query Builder queries | No AML action runs a saved `qry_QueryDefinition` from outside |
| JavaScript-based reports | `Method type not supported: JavaScript` — it is client code |
| Node coordinates on a workflow map | `x`/`y` are not declared properties of `Workflow Map Activity`; writing them returns 200 and changes nothing |

Reading, on the other hand, works and is verified. `aras_read_file` downloads
the content through the OData media resource (`File('<id>')/$value`), falling
back to the vault endpoint, and hands back something readable: text for text
formats, extracted text for PDFs that contain any, and the image itself for
PNG/JPEG/GIF/WebP so it can actually be looked at. A scanned drawing says it
would need OCR rather than returning an empty string.

[`docs/field-notes.md`](docs/field-notes.md) is the field log: every defect the live
testing surfaced, and the exact error that proves each limit.

---

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | From nothing to your first answer out of Aras |
| [Architecture](docs/architecture.md) | How it is put together, and the trap that shapes all of it |
| [Walkthrough](docs/walkthrough.md) | Ten complete business flows, as questions |
| [Testing](docs/testing.md) | The suites, and how to run them without hurting anything |
| [Field notes](docs/field-notes.md) | What live testing surfaced: defects found, and four things that do not work |

[`docs/it/`](docs/it) holds the original Italian material: a 39-block demo script
and the raw testing log.

## Contributing

Instances that are not ours are what this needs most — different versions,
different templates, different data models. See [CONTRIBUTING.md](CONTRIBUTING.md).

Security issues: [SECURITY.md](SECURITY.md), privately.

## Licence

MIT — see [LICENSE](LICENSE).
