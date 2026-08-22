# Testing

There is no mock. Every suite runs against a real Aras Innovator instance,
because the things that break in this domain — annotation rules, permission
denials disguised as HTTP 500, workflows that need an undocumented element — are
exactly the things a mock would get wrong.

## Safety rules the suites follow

1. **They only write to items prefixed `ZZ-`, `ZZW-` or `ZZF-`.**
2. **They remove what they created**, in the right order: assemblies before
   components, because Aras refuses to delete a part a BOM line still references.
3. **They clean up before they start**, not only afterwards, so an interrupted
   run cannot poison the next one.
4. **The last flow asserts that production data was untouched** — counts of the
   sample product family and its change orders.

Point them at a scratch instance the first time anyway.

## Running them

```bash
npm run build

node test-full.mjs        # connection, discovery, reading, navigation
node test-product.mjs     # BOM, where-used, AML, documents, revisions
node test-lifecycle.mjs   # lifecycle states, transitions, roles
node test-schema.mjs      # custom ItemTypes and properties
node test-admin.mjs       # identities, memberships, permissions
node test-analytics.mjs   # dashboards, metrics, effectivity
node test-reports.mjs     # reports, saved queries, sequences, methods
node test-write.mjs       # every write tool refuses while read-only
node test-writepath.mjs   # the same tools actually writing, then cleaning up
node test-flussi.mjs      # ten whole business flows
node test-demo.mjs        # a runnable example per capability
```

Write suites need `ARAS_READONLY=false` in the environment, and an account with
the permissions to do what they do. Some ItemTypes — `Manufacturer`, `ECN` —
grant Add only to specific identities, and a plain admin account is not one of
them.

## The one worth reading

`test-flussi.mjs` does not test tools. It tests **questions**, in the shape
someone in a company would ask them:

> *"A designer has joined: create their account and put them in the right department."*
>
> *"Code a new component, take it through approval, and release it."*
>
> *"Build an assembly with three components and tell me how many pieces I need."*
>
> *"Replace a component across every BOM — but first tell me where it would land."*
>
> *"Try to delete a component that a BOM still uses: it must refuse."*

Each flow is several calls in sequence with an assertion at every step, so when
something breaks you can see *where* in the flow it broke, not just that a tool
returned the wrong shape.

That distinction has already paid for itself. A defect where
`aras_create_document` reported success without creating the relationship was
invisible to a per-tool test — the tool returned an id, and an id looks like
success. Only asserting the *outcome of the flow* caught it.

## Writing a new assertion

```js
passo("the description is found by whoever searches",
  (r.documenti ?? []).length >= 1,
  r);   // third argument is printed only on failure
```

Assert on the **effect**, not on the call returning something. `!!r.id` is not
evidence that anything happened.

## What CI covers

[`.github/workflows/build.yml`](../.github/workflows/build.yml) runs on Node 20
and 22: type check, build, a check that the server answers a real MCP
`initialize` handshake, and a syntax check over every suite.

It does **not** run the eleven suites — there is no Aras instance in CI, and
pretending otherwise would be a green badge that means nothing. Run them against
your own instance.
