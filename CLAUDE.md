# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Bun-based VSCode extension, scaffolded from the `lalunamel/bun-vscode-extension` template. Runtime is Bun; the extension itself is bundled to CommonJS by esbuild for VSCode's loader.

## Commands

- `bun run build` — bundle `src/extension.ts` to `dist/extension.cjs` via esbuild.
- `bun run watch` — same as build, in continuous watch mode.
- `bun test` — run all tests with Bun's built-in test runner.
- `bun test -t "<name>"` — run a single test by name pattern.
- `bun run package` — build, then produce a `.vsix` via `@vscode/vsce` (`bun run vsce package`).
- `bun run clean` — `rm -r ./dist`.

To run the extension locally, open the folder in VSCode and press `F5` (or `Run and Debug > Run Extension`). This triggers the default build task in `.vscode/tasks.json`, then launches an Extension Development Host with the build output on its `outFiles` path.

## Architecture

`src/extension.ts` exports `activate(context)` and `deactivate()`. Commands are registered via `vscode.commands.registerCommand(...)` and pushed onto `context.subscriptions` so VSCode disposes them on deactivation. The current implementation is a placeholder "Hello World" command (`bun-vscode-extension.helloworld`), declared in `package.json` under `contributes.commands`.

### VSCode mock + build quirks (non-obvious)

The `vscode` npm package only ships TypeScript types — there is no runtime implementation in `node_modules`. VSCode itself injects the real API when it loads the extension. This forces three coordinated workarounds:

1. **Build**: `scripts/esbuild.config.ts` marks `vscode` as `external` so esbuild does not try to bundle it. Output is forced to `.cjs` via `outExtension` because VSCode's loader requires CommonJS, even though `package.json` declares `"type": "module"`.
2. **Tests**: `tsconfig.json`'s `paths.vscode` redirects `import * as vscode from "vscode"` to `./mocks/vscode.ts`. The mock is a hand-rolled surface of the VSCode API that tests can `spyOn`.
3. **Adding new API usage**: whenever you introduce a new `vscode.*` call in `src/`, you must add a corresponding stub in `mocks/vscode.ts`, or test resolution will fail. See `src/extension.test.ts` for the spy/mock pattern (`spyOn(vscode.commands, "registerCommand")`, etc.).

The mocks are only active for tests — not for builds — because the esbuild config marks `vscode` external regardless of the tsconfig alias.

## Design folder

`DoStuffDesign/` is a prototype sandbox (HTML mockup, JSX components, plus a parallel `ext/vscode-extension/` scaffold with its own `package.json`/`tsconfig.json`). It is not wired into the build pipeline and changes there do not affect `dist/`. Treat it as exploratory design, not as production source.
