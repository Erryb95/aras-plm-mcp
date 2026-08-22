# Getting started

From nothing to your first answer out of Aras.

## 1. What you need

- **Node 20 or newer**
- **An Aras Innovator instance you are allowed to talk to.** Aras publishes the
  platform as enterprise open source; a local install is fine and is what this
  project was built against (2025 / 14.35.0).
- **A user account on that instance.** A read-only account is enough for the
  first two thirds of the tools.

## 2. Install

```bash
git clone https://github.com/Erryb95/aras-plm-mcp.git
cd aras-plm-mcp
npm install
npm run build
```

## 3. Configure

Copy `.env.example` to `.env` and fill it in:

```ini
ARAS_URL=http://localhost/InnovatorServer
ARAS_DATABASE=InnovatorSolutions
ARAS_USER=admin
ARAS_PASSWORD=your-password
ARAS_CLIENT_ID=IOMApp
ARAS_READONLY=true
```

`ARAS_URL` is the **web alias**, not the client page. If you log in at
`http://host/InnovatorServer/Client/`, the value here is
`http://host/InnovatorServer`.

`ARAS_CLIENT_ID` is `IOMApp` on a stock install. Authentication is OAuth 2.0
Resource Owner Password Credentials against `{ARAS_URL}/oauthserver`, scope
`Innovator`.

Leave `ARAS_READONLY=true` until you have a reason not to. Writes to a PLM are
versioned and audited; they should be a deliberate act.

## 4. Connect it to a client

### Claude Code

Add to `.mcp.json` in your project, or to `~/.claude.json` globally:

```json
{
  "mcpServers": {
    "aras-plm": {
      "command": "node",
      "args": ["/absolute/path/to/aras-plm-mcp/dist/index.js"],
      "env": {
        "ARAS_URL": "http://localhost/InnovatorServer",
        "ARAS_DATABASE": "InnovatorSolutions",
        "ARAS_USER": "admin",
        "ARAS_PASSWORD": "your-password",
        "ARAS_CLIENT_ID": "IOMApp",
        "ARAS_READONLY": "true"
      }
    }
  }
}
```

Restart the client afterwards — MCP connections are established at startup, so a
newly added server (or a newly added tool) will not appear until then.

### Claude Desktop

Same block, in `claude_desktop_config.json`.

### Anything else that speaks MCP

The server talks JSON-RPC over stdio. `node dist/index.js` and write to its
stdin.

## 5. Check the connection

Ask for `aras_ping` first. It should answer something like:

```json
{
  "database": "InnovatorSolutions",
  "user": "admin",
  "itemTypes": 484,
  "url": "http://localhost/InnovatorServer",
  "readOnly": true
}
```

If it does not, nothing else will work either, and the error it returns is the
one worth reading.

| Symptom | Cause |
|---|---|
| `invalid_grant` | Wrong user or password |
| `ECONNREFUSED` | Wrong `ARAS_URL`, or the instance is not running |
| `404` on the token endpoint | `ARAS_URL` points at the client page instead of the web alias |
| Hangs, then times out | The OAuth server is up but the Innovator app pool is not — try an `iisreset` |

## 6. Your first real questions

Start broad and narrow down. The server is designed so you do not have to know
the data model in advance.

```
aras_search              term: "pump"
aras_describe_item_type  itemType: "Part"
aras_get_bom             partId: "<an id from the search>"   depth: 4
aras_where_used          partId: "<a component id>"
```

`aras_search` queries several ItemTypes in parallel and builds, for each one, a
filter over only the text fields that type actually has. It exists because Aras
has no global search and 484 ItemTypes is too many to guess at.

## 7. Enabling writes

When you are ready:

```ini
ARAS_READONLY=false
```

Two things to know before you do.

**Bulk operations preview by default.** `aras_replace_component` and
`aras_bulk_update` take `dryRun`, and it defaults to `true`. You get the list of
affected rows and nothing changes until you ask for it.

**Updating a versionable item creates a new generation.** On `Part`, `Document`
and `CAD`, Aras versions on update — even for a typo in a description. Check with
`aras_get_revisions` before and after if the revision history matters to you.

## Where to go next

- [Architecture](architecture.md) — how the server is put together, and why
- [Testing](testing.md) — the suites, and how to run them safely
- [Walkthrough](walkthrough.md) — ten complete business flows
- [Field notes](field-notes.md) — what live testing surfaced, including four
  things that genuinely do not work from outside
