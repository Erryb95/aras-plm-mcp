# Changelog

Notable changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-08-22

First public release. Verified against a live Aras Innovator 2025 (14.35.0)
instance with the Innovator Solutions template.

### Added

- 71 tools over OData and AML, covering discovery, reading, product and BOM,
  change and workflow, lifecycle, organisation and permissions, custom schema,
  analytics, bulk operations and diagnostics.
- Schema introspection: property names, types and real mandatory flags read from
  the instance rather than assumed.
- Cross-type search, building per-type filters over only the text fields each
  type actually has.
- Recursive BOM explosion with cumulative quantities and per-branch cycle
  detection.
- Revision history through `getItemAllVersions`, which OData cannot see.
- Lifecycle promotion and workflow advancement through AML, including the
  undocumented `<Complete>1</Complete>` element that `EvaluateActivity` requires.
- Read-only by default; `dryRun` on by default for bulk operations.
- Deletion planning that reports what blocks it, and `-1` for relationships it
  could not verify.
- Eleven test suites against a live instance: 260 assertions plus a 39-step
  demo script. Every tool is exercised by at least one suite, and every write
  tool performs a real write rather than only refusing while read-only.
- CI on Node 20 and 22: type check, build, and a real MCP `initialize` handshake.

### Known limits

Four capabilities are unreachable from an external client. Each affected tool
declares the limit and points at an alternative rather than failing opaquely:

- uploading files to the vault (**reading** their content works, through the
  OData media resource `File('<id>')/$value`)
- effectivity expressions on a BOM
- executing Query Builder queries
- JavaScript-based reports

Evidence for each is in [docs/field-notes.md](docs/field-notes.md).

[Unreleased]: https://github.com/Erryb95/aras-plm-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Erryb95/aras-plm-mcp/releases/tag/v0.1.0
