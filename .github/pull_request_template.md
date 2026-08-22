## What changed, and why it needed changing

## Suites run

Against which Aras instance, and what they said. Naming them matters — see
[docs/testing.md](../docs/testing.md).

- [ ] `npx tsc --noEmit` clean
- [ ] Suites covering the touched area run against a live instance

## If this adds a tool

- [ ] Its description says what *question* it answers
- [ ] Property names validated against the schema, values against the lists
- [ ] Writes guarded by `cfg.readOnly`, returning a refusal rather than throwing
- [ ] An assertion added to the relevant suite
