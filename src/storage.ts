// VSCode host adapter for the storage core (`storageCore.ts`).
//
// All storage behavior — SQLite via sql.js, the `normalize()` migration
// chokepoint, mutator/tombstone chokepoints, attachment IO, the export
// queue — lives in the vscode-free `IssueStoreCore`. This module binds it to
// the extension host: workspace-folder + `dostuff.storagePath` resolution,
// the `globalState` KV fallback for no-workspace windows, a
// `vscode.workspace.fs`-backed StorageFs (so remote workspaces keep their
// historical IO semantics), the "DoStuff Storage" output channel, and
// `vscode.Uri`-typed convenience wrappers for the webview providers.

import * as nodePath from "node:path";
import * as vscode from "vscode";
import { outputChannelLogger } from "./mcpHostVscode";
import {
  IssueStoreCore,
  type StorageFs,
} from "./storageCore";

// The core owns these; re-exported so existing importers stay unchanged.
export {
  GITIGNORE_CONTENT,
  normalize,
  type ElementTombstoneRow,
  type SyncTombstones,
  type TicketTombstoneRow,
} from "./storageCore";

const STATE_KEY_FALLBACK = "dostuff.issues.v1";

export interface IssueStoreOptions {
  /**
   * Pre-loaded sql.js WASM bytes. When omitted the store reads them from
   * `<extensionUri>/dist/sql-wasm.wasm` via the VSCode FS at init time.
   * Tests pass real bytes from `node_modules/sql.js/dist/sql-wasm.wasm`.
   */
  wasmBinary?: Uint8Array;
}

/**
 * StorageFs on top of `vscode.workspace.fs`. Dereferences `vscode.workspace.fs`
 * inside every call (not at construction) so the storage test suite's
 * per-test virtual-FS patch is honored.
 */
const vsCodeStorageFs: StorageFs = {
  readFile: (p) => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(p))),
  writeFile: (p, content) => Promise.resolve(vscode.workspace.fs.writeFile(vscode.Uri.file(p), content)),
  createDirectory: (p) => Promise.resolve(vscode.workspace.fs.createDirectory(vscode.Uri.file(p))),
  delete: (p, opts) =>
    Promise.resolve(
      vscode.workspace.fs.delete(vscode.Uri.file(p), {
        recursive: opts?.recursive ?? false,
        useTrash: false,
      }),
    ),
  exists: async (p) => {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(p));
      return true;
    } catch {
      return false;
    }
  },
  readDirectory: async (p) => {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(p));
    return entries.map(([name, kind]) => [
      name,
      kind === vscode.FileType.File
        ? "file"
        : kind === vscode.FileType.Directory
          ? "directory"
          : "other",
    ]);
  },
  rename: (from, to) =>
    Promise.resolve(
      vscode.workspace.fs.rename(vscode.Uri.file(from), vscode.Uri.file(to), { overwrite: true }),
    ),
};

export class IssueStore extends IssueStoreCore {
  constructor(ctx: vscode.ExtensionContext, opts: IssueStoreOptions = {}) {
    super({
      storageDir: () => {
        const root = vscode.workspace.workspaceFolders?.[0];
        if (!root) return null;
        const storagePath = vscode.workspace
          .getConfiguration("dostuff")
          .get<string>("storagePath", ".vscode/dostuff");
        return nodePath.join(root.uri.fsPath, storagePath);
      },
      wasmBinary: async () => {
        if (opts.wasmBinary) return opts.wasmBinary;
        const wasmUri = vscode.Uri.joinPath(ctx.extensionUri, "dist", "sql-wasm.wasm");
        return vscode.workspace.fs.readFile(wasmUri);
      },
      writeStorageGitignore: () =>
        vscode.workspace.getConfiguration("dostuff").get<boolean>("writeStorageGitignore", true),
      logger: outputChannelLogger("DoStuff Storage"),
      kv: {
        get: () => ctx.globalState.get(STATE_KEY_FALLBACK, []),
        update: (value) => Promise.resolve(ctx.globalState.update(STATE_KEY_FALLBACK, value)),
      },
      fs: vsCodeStorageFs,
    });
  }

  /** Root of all attachment binaries as a `vscode.Uri` (webview providers). */
  attachmentsDir(): vscode.Uri | null {
    const p = this.attachmentsPath();
    return p ? vscode.Uri.file(p) : null;
  }

  /** `findAttachmentPath` as a `vscode.Uri` (host commands / providers). */
  async findAttachmentUri(issueId: string, attachmentId: string): Promise<vscode.Uri | null> {
    const p = await this.findAttachmentPath(issueId, attachmentId);
    return p ? vscode.Uri.file(p) : null;
  }
}
