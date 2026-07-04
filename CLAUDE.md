# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Core tenet: storage backward compatibility

**Every change must load ticket data written by any prior version of the extension without error or data loss.** Users upgrade in place. Three persistence surfaces are all part of the contract: the SQLite DB at `<storagePath>/dostuff.db` (sql.js), the `globalState` fallback when no workspace is open, and the legacy `<id>.json` ticket files the one-shot migration still reads. The loader — not the writer — is the compatibility boundary. Concretely:

- **Schema changes are additive only.** Add new optional fields and new tables; never rename, retype, or repurpose an existing column/field. If a field's meaning must change, introduce a new one and migrate. (Precedent: `tags`, `links` (+ the `issue_links` table), and `attachments` were *added*; an older DB or JSON without them loads with empty defaults.)
- **New SQL tables/columns use `CREATE TABLE IF NOT EXISTS` and are read with `?? []`.** `db.exec(SCHEMA_DDL)` runs on every open, so a `main`-era DB gains the new (empty) table on first load by this build; `hydrateFromDb` must default a missing relation to `[]` (e.g. `linksBySource.get(row.id) ?? []`). Adding a table need not bump `SCHEMA_VERSION`; only bump it when an upgrade requires a data backfill, and keep the "DB newer than this build → warn and continue" path intact so a downgrade never crashes.
- **`storage.ts`'s `normalize()` is the single migration chokepoint for object-shaped input** (legacy JSON + `globalState`). Every new field must be defaulted there for raw objects that lack it (`coerceTags(raw.tags)` / `coerceLinks(raw.links)` / `Array.isArray(...) ? ... : []`). Never read a new field off a loaded ticket without a default.
- **Coercers accept `unknown` and return a safe empty value on bad/missing input** (`coerceTags` / `coerceLinks` / `coerceAttachments` in `types.ts` all guard `if (!Array.isArray(input)) return []`). They must never throw on legacy data.
- **New `Status`/`Priority`/`type` enum values must degrade gracefully.** `normalize()` coerces unrecognized enum values to a safe default (`Thinking` / `Regular` / `Chore`) rather than crashing, so a ticket written by a newer build still loads on an older one.
- **When you touch the schema, prove it.** Add a `storage`/`types` test that feeds a minimal legacy object (only the old required fields) through `normalize()` — and, for a new table, hydrates a DB created without it — and asserts the new fields default correctly. This is non-negotiable for any schema PR.

## Project

DoStuff is a VSCode extension built with Bun + esbuild. Two bundles ship from one source tree: `dist/extension.cjs` for the extension host (CommonJS, required by VSCode's loader) and `media/index.js` + `media/styles.css` for the webview UI (browser IIFE). The webview is React 18 with `react-window` v1.8.x for list virtualization. The extension also runs a loopback-only HTTP MCP server exposing the active ticket queue to coding agents — the port is OS-assigned by default (`dostuff.mcp.port`, default `0`); agents discover it via the registry at `~/.config/dostuff/instances.json` (see README "Multi-workspace agent discovery").

## Commands

- `bun run build` — bundle both extension and webview via esbuild.
- `bun run watch` — same in continuous watch mode.
- `bun test` — run all tests with Bun's built-in test runner.
- `bun test -t "<name>"` — run a single test by name pattern.
- `bun run package` — build, then produce a `.vsix` via `@vscode/vsce`.
- `bun run clean` — remove `dist/` and the webview output files in `media/`.

Press `F5` in VSCode (or `Run and Debug > Run Extension`) to launch an Extension Development Host with the current build.

## Architecture

DoStuff has three parts: an **extension host** (`src/*.ts`) that owns activation, the `IssueStore` (SQLite via `sql.js`, with a `globalState` fallback and one-shot legacy-JSON migration), the sidebar/board/graph providers, and the loopback HTTP MCP server (ephemeral port + `instances.json` registry); a **webview bundle** (`src/webview/*.tsx`, React 18) that renders the sidebar, board, and graph modes and talks to the host over the typed `HostToWebview` / `WebviewToHost` message protocol; and a two-config **esbuild pipeline** (CommonJS extension + browser-IIFE webview). `src/types.ts` is the canonical schema.

See [docs/architecture.md](docs/architecture.md) for the full breakdown — per-module responsibilities, cross-webview drag, list virtualization, and the `vscode` mock aliasing used in tests.

**Known constraint — single-writer storage.** The `IssueStore` assumes one extension-host process owns the DB: sql.js is in-memory, every mutation rewrites `dostuff.db` wholesale, and nothing detects external changes to the file. Two VSCode windows on the same workspace silently clobber each other (last flush wins), and `DS-NNN` ids are minted from the local `max+1` so independent writers mint colliding ids. A git-native sync design that fixes both (hidden ref `refs/dostuff/state`, LWW merge, new `guid`/`updatedAt` fields) is fully planned but **not implemented** — see [docs/plans/ticket-sync/00-overview.md](docs/plans/ticket-sync/00-overview.md). If you touch `IssueStore` mutators, id minting, or persistence, read that plan first so the change doesn't fight it.

### Agent write boundaries (MCP) — non-negotiable

These status-gating rules are the safety contract for MCP-connected agents: they constrain *which states an agent may edit and how*. Keep them front-of-mind; the code enforces each in multiple layers by design.

- **New tickets always land in `Thinking`.** Both the UI new-issue modal and the MCP `create_ticket` tool start them there. Triage into an active lane is a human action — agents cannot promote out of `Thinking`.
- **`update_ticket_status` (MCP) is doubly gated.** Both the current and target status must be in `AGENT_WRITABLE_STATUSES` = {Planned, Working, Verification}. Agents can't promote out of Thinking, send tickets back to Thinking, or touch Complete/Closed in either direction. The host's `applyIssueUpdate` chokepoint enforces the same rules for UI moves.
- **`update_ticket_progress` (MCP) only mutates `tasks[].done` and appends one `record` entry.** Title, description, priority, type, and verifyCriteria are immutable through MCP — this is what stops agents from silently rewriting scope. Gate is `AGENT_VISIBLE_STATUSES` = {Thinking, Planned, Working, Verification}; Complete and Closed are rejected.
- **`update_ticket_draft` (MCP) reshapes a draft's `tags`, `links`, and `tasks` — `Thinking`-only.** Once a human triages a ticket to an active lane its scope (tags/links/tasks) is frozen over MCP; agents fall back to `update_ticket_progress` for done-toggles + records.
- **Active lanes (Planned, Working, Verification) are each capped at 6 open tickets.** Enforced independently in three places: the board UI drop handler, the host's `applyIssueUpdate` (the authority), and the MCP `update_ticket_status` tool.
- **`Closed` is a sidebar-only "won't do" status.** Agents cannot set status to `Closed` or re-open a Closed ticket via MCP (same rejection shape as `Complete`); the board never renders Closed tickets.

The remaining UI/implementation rules — Thinking-drawer click vs. Shift+Click, attachment storage internals, tag chip rendering, description auto-linkification, the single-source ticket-link model, and the graph webview mode — live in [docs/workflow-rules.md](docs/workflow-rules.md).

## Important files when extending

- **Adding a new MCP tool** → edit `src/mcpServer.ts`: register the tool inside `registerTools`, and extract its handler to a standalone exported function (mirror the existing `runGetTicket` / `runCreateTicket` / etc. pattern) so it can be tested directly. Add tests in `src/mcpServer.test.ts`.
- **Adding a new webview message** → add the new variant to the `HostToWebview` or `WebviewToHost` discriminated union in `src/types.ts`, then handle it on both sides: in `src/webview/messaging.ts` (webview-side dispatch) and in the relevant provider (`sidebarProvider.ts` or `boardProvider.ts` on the host side).
- **Changing the schema** → update `src/types.ts`, then update the normalizer in `src/storage.ts` so legacy tickets without the new field still load correctly (see the storage backward-compatibility tenet above).

## Testing the webview manually

There is no headless test harness for the React UI. `bun test` and `bunx tsc --noEmit` only catch host-side, MCP, and schema regressions — they do not exercise the webview. After any non-trivial webview change, walk through `SMOKE-TEST.md` in an Extension Development Host (F5), covering the sidebar, board drag-and-drop, lane cap enforcement, import/export, and the MCP HTTP endpoint end-to-end. (Note: `SMOKE-TEST.md` does not exist yet — creating it is tracked in [docs/plans/ticket-sync/06-testing-and-docs.md](docs/plans/ticket-sync/06-testing-and-docs.md); until then, cover those areas manually.)
