# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting:
**Security → Report a vulnerability** on this repository.

Include what an attacker could do, not only what looks wrong. A reproduction
against a disposable Aras instance is worth more than a description.

## What this server does with credentials

It reads them from the environment (`ARAS_USER`, `ARAS_PASSWORD`), exchanges
them once for an OAuth 2.0 access token against `{ARAS_URL}/oauthserver`, and
keeps the token in memory for the life of the process. Nothing is written to
disk, and credentials are never included in tool output.

`.env` is git-ignored. Keep it that way.

## Running it safely

**Leave `ARAS_READONLY=true` unless you need writes.** It is the default. All 21
write tools refuse while it is set, and the refusal is a normal answer rather
than an exception.

**Give it an account with the permissions it needs and no more.** The server
inherits exactly the rights of the account it authenticates as. Aras enforces
permissions server-side, so a read-only account cannot be talked into writing —
but an administrator account can be talked into anything that administrator
could do.

**Treat item content as untrusted input.** Descriptions, names and comments in a
PLM are written by people, and a model reading them is reading text it did not
author. This applies to any tool output, not only this one.

**Bulk operations preview by default.** `dryRun` is `true` unless you set it
otherwise.

## Scope

This project is an MCP server. Vulnerabilities in Aras Innovator itself belong
with Aras Corp, not here — though if this server makes one easier to reach, that
is in scope and worth reporting.
