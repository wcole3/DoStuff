# DoStuff: Issue Board

A lightweight issue tracker that lives inside VS Code. Sidebar list with search, full-tab Kanban board with drag-and-drop, JSON import/export.

## Features

- **Activity bar panel** — search-filterable list of all issues, sorted by creation date
- **Inline detail view** — click an issue to expand title, status, priority, tasks, verify criteria, dates, and state history
- **Kanban board** — drag cards between Planned / Working / Testing lanes; Thinking and Complete drawers on either side
- **Status history** — every status change is logged automatically
- **JSON import / export** — round-trip issues between workspaces
- **Storage choice** — JSON files in the workspace (git-friendly) or a SQLite database in extension storage

## Issue schema

```jsonc
{
  "id": "DS-001",
  "title": "OAuth callback fails on Safari iOS 17",
  "type": "Bug",                           // Bug | Feature | Refactor | Chore | Spike
  "priority": "Critical",                  // Critical | High | Regular | Low
  "status": "Working",                     // Thinking | Planned | Working | Testing | Complete
  "description": "...",
  "tasks": [{ "id": "t1", "text": "...", "done": true }],
  "verifyCriteria": "...",
  "createdAt": "2026-05-04T10:00:00.000Z",
  "resolvedAt": null,
  "statusHistory": [
    { "status": "Thinking", "at": "2026-05-04T10:00:00.000Z" },
    { "status": "Planned",  "at": "2026-05-05T10:00:00.000Z" },
    { "status": "Working",  "at": "2026-05-08T10:00:00.000Z" }
  ]
}
```

## Build & install (development)

```sh
cd vscode-extension
npm install
npm run compile
```

Then press **F5** in VS Code with this folder open to launch an Extension Development Host.

## Build & install (packaged)

```sh
npm install -g @vscode/vsce
vsce package
code --install-extension dostuff-1.0.0.vsix
```

## Commands

| Command | Default keybinding |
|---|---|
| DoStuff: New Issue | `Ctrl/Cmd+Shift+I` |
| DoStuff: Open Board | (palette) |
| DoStuff: Focus Search | `Ctrl/Cmd+Shift+F` (when sidebar focused) |
| DoStuff: Import Issues (JSON) | (palette) |
| DoStuff: Export Issues (JSON) | (palette) |

## Settings

- `dostuff.storageMode` — `json-files` (default) or `sqlite`
- `dostuff.storagePath` — relative path inside workspace for JSON files. Default `.vscode/dostuff`
- `dostuff.autoSave` — persist edits as you type (default: `true`)
