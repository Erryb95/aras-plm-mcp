# Contributing

## What this project needs most

**Instances that are not ours.** Everything here was verified against one Aras
Innovator 2025 (14.35.0) install with the Innovator Solutions template. If a
tool behaves differently on your version, your template, or your customised data
model, that is the most valuable thing you can report — attach the AML or OData
request and the exact error.

**The four declared limits.** Vault upload, effectivity expressions, Query
Builder execution and JavaScript reports are documented in
[docs/field-notes.md](docs/field-notes.md) with the evidence for each. If you
know a route from an external client that we missed, that is a headline
contribution.

## Before you open a pull request

```bash
npm install
npm run build
npx tsc --noEmit
```

Then run the suites that cover what you touched, against your own instance. See
[docs/testing.md](docs/testing.md). Say in the PR which ones you ran and what
they said — "tests pass" without naming them is not evidence.

## Conventions the code follows

**Tools answer questions, not endpoints.** A tool that wraps one HTTP call and
renames it does not earn its place. `aras_get_documents` exists because
"what documentation covers this part" is one question, even though Aras stores
the answer in two different relationships.

**The description is the interface.** It is the only thing a model reads before
choosing a tool. Say what question it answers, name the trap if there is one,
and keep it short enough to be read.

**Validate locally before the round trip.** Property names against the ItemType
schema, values against the list definitions. A rejected write that could have
been caught locally is a wasted round trip and a worse error message.

**Never report success you have not verified.** If a relationship was created,
read it back. If a count could not be checked, return `-1`, not `0` — `0` reads
as "nothing there".

**Guard writes.** Anything that mutates must check `cfg.readOnly` and return a
refusal object rather than throwing, so the caller gets a usable answer.

**Never reach into `related_id` directly.** Use `readItemRef()`. Item references
arrive as OData annotations and only when the property is in `$select`; the rule
lives in one place on purpose.

## Style

TypeScript, strict. Two-space indent. Comments explain *why*, especially where
Aras behaves surprisingly — those comments are the most valuable lines in the
file. Match the density and idiom of the code around you.

Commit messages: a short subject line, then what changed and why it needed
changing. If a fix was hard to find, say what made it hard — the next person
will hit the same thing.

## Reporting a bug

Include:

- Aras Innovator version and template
- The tool called and its arguments
- What came back, verbatim
- If Aras returned a generic error, the matching lines from the server log —
  they usually say far more than the response does. `aras_get_logs` fetches
  them, if logging is enabled on your instance.

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
