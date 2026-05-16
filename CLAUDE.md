# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

DoStuff is a VSCode extension built with Bun + esbuild. Two bundles ship from one source tree: `dist/extension.cjs` for the extension host (CommonJS, required by VSCode's loader) and `media/index.js` + `media/styles.css` for the webview UI (browser IIFE). The webview is React 18 with `react-window` v1.8.x for list virtualization. The extension also runs an HTTP MCP server on `127.0.0.1:3947` exposing the active ticket queue to coding agents.

## Commands

- `bun run build` — bundle both extension and webview via esbuild.
- `bun run watch` — same in continuous watch mode.
- `bun test` — run all tests with Bun's built-in test runner.
- `bun test -t "<name>"` — run a single test by name pattern.
- `bun run package` — build, then produce a `.vsix` via `@vscode/vsce`.
- `bun run clean` — remove `dist/` and the webview output files in `media/`.

Press `F5` in VSCode (or `Run and Debug > Run Extension`) to launch an Extension Development Host with the current build.

## Architecture

**Extension host** (`src/*.ts`, excluding `src/webview/`). `extension.ts` is the activation entry point — it registers all seven commands, wires up the sidebar and board providers, and starts/stops the MCP server. `storage.ts` exposes `IssueStore`, which reads/writes one `<id>.json` file per ticket under `<workspace>/.vscode/dostuff/` (falling back to `globalState` when no workspace is open). `sidebarProvider.ts` is a `WebviewViewProvider` for the activity-bar sidebar; `boardProvider.ts` is a singleton `WebviewPanel` for the full-tab board. `mcpServer.ts` runs an HTTP MCP server on `127.0.0.1:3947` with four tools, three resources, and one prompt. `types.ts` is the canonical schema — it defines `Issue`, `Status`, `Priority`, the `HostToWebview` / `WebviewToHost` discriminated unions, `ACTIVE_LANE_CAP = 6`, and the `canMoveToActiveLane` helper. `webviewHtml.ts` builds the CSP-nonced HTML shell. `sampleData.ts` seeds the store on first activation.

**Webview bundle** (`src/webview/*.tsx`). The React 18 entry `index.tsx` reads `window.__DOSTUFF_MODE__` (set by the host shell) and renders either `<Sidebar/>` or `<Board/>`. A shared `<IssueDetail/>` component handles the inline edit panel. `messaging.ts` wraps `acquireVsCodeApi()` and the host-to-webview message stream as a `useSyncExternalStore` hook so React components subscribe without leaking listeners. The sidebar list and the Thinking/Complete drawers in the board use `react-window`'s `FixedSizeList` for virtualization; active board lanes are not virtualized (cap = 6). Drag-and-drop on the board uses the HTML5 native API — no third-party DnD library. **Cross-webview drag** (sidebar→board) is a pseudo-drag: native DnD doesn't reliably cross VSCode's webview iframe boundary, so the sidebar's `dragstart` posts an `externalDragStart` message; the host opens the board if needed and forwards the signal, and the board renders a click-absorbing "Move to *lane*" overlay (`bd-pick-overlay`) inside each lane/drawer. The actual mutation still flows through `setStatus` → `postUpdateIssue` → host `applyIssueUpdate`. Esc cancels.

**Build pipeline.** `scripts/esbuild.config.ts` exports two configs: `extensionConfig` (Node CommonJS target, `vscode` marked external) and `webviewConfig` (browser IIFE target, no externals). `scripts/build-with-esbuild.ts` runs both in parallel; `scripts/watch-with-esbuild.ts` watches both. `vscode` is external in the extension config because VSCode injects the real API at load time. The webview never imports `vscode`. For tests, `tsconfig.json`'s `paths.vscode` alias redirects `import * as vscode from "vscode"` to the hand-rolled `mocks/vscode.ts` — so `tsc` and the IDE see the mock, but the runtime esbuild bundle leaves `vscode` external. Whenever you introduce a new `vscode.*` call in `src/`, add a stub to `mocks/vscode.ts` or test resolution will fail.

### Workflow rules the code enforces

These rules are non-obvious from a fresh read of the code, so they live here:

- **New tickets always land in `Thinking`.** Both the UI new-issue modal and the MCP `create_ticket` tool start them there. Triage is a human action.
- **`update_ticket_status` (MCP) is doubly gated.** The current status must be in {Planned, Working, Verification} *and* the target status must be in {Planned, Working, Verification}. This blocks agents from promoting out of Thinking, from sending tickets back into Thinking, and from touching Complete in either direction. Humans can promote Thinking → Planned via the UI; agents cannot. The host's `applyIssueUpdate` chokepoint enforces the same rules for UI moves.
- **Active lanes (Planned, Working, Verification) are each capped at 6 open tickets.** The cap is enforced in three places by design: the board UI drop handler (visual rejection + toast for instant feedback), the host's `applyIssueUpdate` (the authority — warning + state revert), and the MCP `update_ticket_status` tool (error response, protecting against an agent racing the UI). All three exist so each layer can refuse independently.
- **`update_ticket_progress` (MCP) only mutates `tasks[].done` and appends one `record` entry.** Title, description, priority, type, and verifyCriteria are immutable through MCP — only the UI can edit those. This is what keeps agents from silently rewriting scope.
- **Thinking-drawer click is a detail view; Shift+Click is the promote action.** A plain click on a Thinking-drawer card opens the detail overlay (so humans can read the draft before triaging); Shift+Click promotes it to Planned via the same `setStatus` path used by drag. The Complete drawer has no promote shortcut — its cards only ever open the detail overlay.

## Important files when extending

- **Adding a new MCP tool** → edit `src/mcpServer.ts`: register the tool inside `registerTools`, and extract its handler to a standalone exported function (mirror the existing `runGetTicket` / `runCreateTicket` / etc. pattern) so it can be tested directly. Add tests in `src/mcpServer.test.ts`.
- **Adding a new webview message** → add the new variant to the `HostToWebview` or `WebviewToHost` discriminated union in `src/types.ts`, then handle it on both sides: in `src/webview/messaging.ts` (webview-side dispatch) and in the relevant provider (`sidebarProvider.ts` or `boardProvider.ts` on the host side).
- **Changing the schema** → update `src/types.ts`, then update the normalizer in `src/storage.ts` so legacy tickets without the new field still load correctly.

## Testing the webview manually

There is no headless test harness for the React UI. `bun test` and `bunx tsc --noEmit` only catch host-side, MCP, and schema regressions — they do not exercise the webview. After any non-trivial webview change, walk through `SMOKE-TEST.md` in an Extension Development Host (F5). The smoke test covers the sidebar, board drag-and-drop, lane cap enforcement, import/export, and the MCP HTTP endpoint end-to-end.
