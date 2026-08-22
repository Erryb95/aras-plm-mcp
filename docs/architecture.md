# Architecture

Why this server is shaped the way it is.

## The premise

Aras Innovator has no fixed API surface. The OData service document answers
`501 Not Implemented`, and the ItemTypes an instance exposes — 484 on a stock
2025 install — are configuration, not specification. Two Aras instances at two
companies do not have the same API.

So a wrapper that forwards `get_items(itemtype, filter)` is not an integration.
It relocates the problem: the model now has to guess type names, property names
and relationship names, and every wrong guess costs a round trip and returns an
error that does not say what went wrong.

The design premise here is the opposite: **read the schema, and answer questions
rather than expose endpoints.**

## Two protocols, deliberately

| | Used for |
|---|---|
| **OData** (`/Server/OData`) | Everything queryable: items, relationships, filters, paging |
| **AML** over SOAP (`/Server/InnovatorServer.aspx`) | Everything OData cannot see |

AML is not a fallback for when OData is inconvenient. There are things OData
structurally cannot do:

- **Past generations.** `$filter=is_current eq '0'` returns zero rows. Revision
  history goes through `getItemAllVersions`.
- **Lifecycle transitions.** They are behaviour, not data. Promotion goes
  through `promoteItem`, after resolving the role the transition requires.
- **Workflow evaluation.** `EvaluateActivity`, including a `<Complete>1</Complete>`
  element that appears in no documentation.

`src/aras/client.ts` speaks OData. `src/aras/aml.ts` speaks AML. Each module
above them picks whichever can actually answer.

## The trap that shapes everything

Aras exposes item references **only as OData annotations**, and **only when you
ask for the property in `$select`**.

```
GET /Part BOM?$select=id,related_id,quantity
  → related_id@aras.id, related_id@aras.keyed_name    ✓

GET /Part BOM
  → neither. The rows come back as opaque metadata.   ✗
```

Miss this and you write a BOM explorer that returns an empty tree, silently,
with no error anywhere. It is encoded once:

```ts
// src/aras/odata.ts
export function readItemRef(row, prop): ItemRef | null {
  const id = str(row[`${prop}@aras.id`]) ?? str(row[prop]) ?? str(row[prop]?.id);
  if (!id) return null;
  const keyedName = str(row[`${prop}@aras.keyed_name`]) ?? str(row[`${prop}@aras.name`]) ?? null;
  return { id, keyedName };
}
```

Every caller uses it. No module is allowed to reach into `related_id` directly.

## Layout

```
src/
  index.ts              tool registration — 69 of them, zod schemas, one guard
  aras/
    auth.ts             OAuth 2.0 password grant, token cache
    client.ts           OData: query, queryAll (follows @odata.nextLink),
                        create, update, and explain() for error messages
    aml.ts              AML over SOAP
    odata.ts            readItemRef and the annotation rules
    schema.ts           ItemType introspection and property validation
    lists.ts            list-backed property values
    bom.ts              recursive explosion, cumulative quantities,
                        per-branch cycle detection
    revisions.ts        generations via getItemAllVersions
    lifecycle.ts        maps, states, and the role each transition needs
    workflow.ts         processes, activities, assignments, exit paths
    changes.ts          ECR/ECN, affected items, advancement
    ...
```

## Design rules the code follows

**Validate before the round trip.** `aras_create_part` checks the property names
against the ItemType schema *and* the values against the list definitions before
sending anything. Writing `make_buy: "make"` passes a naive check — the property
exists — and is rejected by Aras. Here it is caught locally, with the allowed
values in the reply.

**Never report success you have not verified.** `aras_plan_delete` returns `-1`
for relationships it could not check, rather than `0`, because `0` would read as
"nothing references this". `aras_create_document` re-reads the relationship after
creating it and says so if it is not there.

**Translate Aras's error vocabulary.** A denied permission comes back as a
generic **HTTP 500**, not a 403. `client.explain()` maps status codes to
actionable messages, `aras_get_type_permissions` names the identity you are
missing, and `aras_lookup_error` looks the message up in the `UserMessage`
catalogue that ships with the instance.

**Refuse loudly, not silently.** Where something genuinely cannot be done from
an external client, the tool says so and points at the alternative. See
[field notes](field-notes.md) for the four cases and the evidence behind each.

## Adding a tool

1. Put the logic in a module under `src/aras/`, taking `ArasClient` and/or
   `AmlClient`.
2. Register it in `src/index.ts` with a zod schema and a description that says
   *what question it answers*, not what endpoint it calls.
3. If it writes, guard it with `cfg.readOnly` and return a refusal object rather
   than throwing.
4. Add an assertion to the suite that covers its area.

The tool description is the only thing the model sees before choosing. Spend
time on it.
