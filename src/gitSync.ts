// Git-native ticket sync controller
// (docs/plans/ticket-sync/04-controller-wiring.md).
//
// Owns the sync lifecycle: outbound commits of local store state to the
// hidden ref (debounced), inbound application of merged remote state, the
// same-machine tip poll that fixes two-window clobbering, and the
// fetch → merge → apply → push network cycle. All git work goes through
// `GitRepo` (03-git-plumbing); all merge logic through the pure `syncMerge`
// module (02-merge-spec); all store writes through `applySync` /
// `preserveTimestamps` semantics (01-schema-groundwork).

import * as vscode from "vscode";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { normalize } from "./storage";
import type { IssueStore } from "./storage";
import { findRepoRoot, GitError, GitRepo, type GitRepoOptions, type TreeEntry } from "./gitPlumbing";
import {
  canonicalJson,
  coerceWireTicket,
  fromWire,
  mergeStates,
  renumber,
  sanitizeExt,
  toWire,
  type ElementTombstone,
  type SyncState,
  type Tombstone,
  type WireTicket,
} from "./syncMerge";
import { ACTIVE_LANES, type Issue, type Status } from "./types";

export const FORMAT_VERSION = 1;

export type SyncStateName =
  | "disabled"
  | "noRepo"
  | "noRemote"
  | "idle"
  | "syncing"
  | "pendingPush"
  | "error";

export interface SyncStatus {
  state: SyncStateName;
  detail?: string;
  lastSyncAt?: string;
}

export interface SyncResult {
  applied: number;
  pushed: boolean;
  renames: Array<{ oldId: string; newId: string }>;
  laneOverflow: string[]; // lanes left over cap by the merge, for the warn-once toast
}

/**
 * The slice of `IssueStore` the controller needs. Narrow on purpose so tests
 * can drive two controllers against lightweight in-memory stores while the
 * real `IssueStore` satisfies it structurally.
 */
export type SyncStoreLike = Pick<
  IssueStore,
  | "list"
  | "get"
  | "getSyncTombstones"
  | "applySync"
  | "onChange"
  | "appendLog"
  | "attachmentsDir"
  | "readAttachment"
  | "findAttachmentUri"
>;

export interface GitSyncOptions {
  remote: string; // e.g. "origin"
  ref: string; // e.g. "refs/dostuff/state"; validated ^refs/
  intervalMinutes: number; // 0 = manual network sync only
  activeLaneCap: number;
  /** Sync attachment bytes through the ref tree (default true; metadata
   *  always syncs). See docs/plans/ticket-sync/05-attachments.md. */
  syncAttachments?: boolean;
  /** Per-file byte cap for attachment sync (default 5 MiB); larger files
   *  sync metadata only, logged — no silent caps. */
  maxAttachmentSyncBytes?: number;
  debounceMs?: number; // outbound debounce (default 2000)
  pushFollowUpMs?: number; // one coalesced push after a local commit (default 30000)
  tipPollMs?: number; // same-machine tip poll (default 15000)
  git?: GitRepoOptions; // timeout overrides for tests
  /** Notification sink — defaults to vscode.window toasts; tests inject. */
  notify?: (kind: "info" | "warn", message: string) => void;
  /** Run a network sync on start() (default true). Tests disable to drive
   *  every cycle deterministically via syncNow. */
  startupSync?: boolean;
}

const TRACKING_REF = "refs/dostuff/remote";
const CAS_RETRIES = 5;
const PUSH_RETRIES = 3;

/**
 * Is `target` strictly inside `rootPath`? Belt-and-braces behind the
 * safe-segment validation in `coerceWireTicket`: no filesystem operation
 * driven by wire data may escape the attachments root, even if a hostile id
 * somehow reached the cache (e.g. via a pre-hardening DB).
 */
function insideRoot(rootPath: string, target: string): boolean {
  const rel = nodePath.relative(rootPath, target);
  return (
    rel !== "" && rel !== ".." && !rel.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(rel)
  );
}

export class GitSyncController implements vscode.Disposable {
  private repo: GitRepo | null = null;
  private opChain: Promise<void> = Promise.resolve();
  private disposables: vscode.Disposable[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pushFollowUpTimer: ReturnType<typeof setTimeout> | null = null;
  private applyingRemote = 0; // echo suppression counter
  private lastSeenTip: string | null = null;
  private warnedOverflow = false;
  private started = false;

  private _status: SyncStatus = { state: "disabled" };
  private readonly statusEmitter = new vscode.EventEmitter<SyncStatus>();
  readonly onStatusChange = this.statusEmitter.event;

  constructor(
    private readonly store: SyncStoreLike,
    private readonly getRoot: () => string | null,
    private readonly opts: GitSyncOptions,
  ) {}

  get status(): SyncStatus {
    return this._status;
  }

  private setStatus(state: SyncStateName, detail?: string): void {
    this._status = {
      state,
      ...(detail ? { detail } : {}),
      ...(this._status.lastSyncAt ? { lastSyncAt: this._status.lastSyncAt } : {}),
    };
    this.statusEmitter.fire(this._status);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.chain(async () => {
      const root = this.getRoot();
      const repoRoot = root ? await findRepoRoot(root) : null;
      if (!repoRoot) {
        this.setStatus("noRepo", "Not a git repository (or git not installed)");
        return;
      }
      if (!/^refs\//.test(this.opts.ref)) {
        this.setStatus("error", `Invalid sync ref "${this.opts.ref}" — must start with refs/`);
        return;
      }
      this.repo = new GitRepo(repoRoot, this.opts.git);
      this.setStatus("idle");

      // Outbound: store change → trailing debounce → local ref commit.
      this.disposables.push(
        this.store.onChange(() => {
          if (this.applyingRemote > 0) return; // echo suppression
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.chain(() => this.commitLocalOp());
          }, this.opts.debounceMs ?? 2000);
        }),
      );

      // Same-machine race detection: cheap tip poll.
      const pollMs = this.opts.tipPollMs ?? 15000;
      const poll = setInterval(() => {
        void this.chain(async () => {
          if (!this.repo) return;
          const tip = await this.repo.revParse(this.opts.ref);
          if (tip && tip !== this.lastSeenTip) {
            await this.applyTipOp(tip);
          }
        });
      }, pollMs);
      this.timers.push(poll);

      // Full network sync on start + interval.
      if (this.opts.intervalMinutes > 0) {
        const interval = setInterval(
          () => void this.syncNow("interval").catch(() => {}),
          this.opts.intervalMinutes * 60_000,
        );
        this.timers.push(interval);
      }
      if (this.opts.startupSync !== false) void this.syncNow("startup").catch(() => {});
    });
  }

  stop(): void {
    this.started = false;
    for (const t of this.timers) clearInterval(t as ReturnType<typeof setInterval>);
    this.timers = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.pushFollowUpTimer) clearTimeout(this.pushFollowUpTimer);
    this.pushFollowUpTimer = null;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.setStatus("disabled");
  }

  dispose(): void {
    this.stop();
    this.statusEmitter.dispose();
  }

  /**
   * Single-flight op chain — the `reconcilePromise` pattern. Ops fired from
   * the debounce/poll paths are `void`-ed by their callers, so a rejection
   * here would surface as an unhandled promise rejection and never reach the
   * status bar — catch, log, and mark the error instead. (`syncNow` carries
   * its own try/catch and never rejects.)
   */
  private chain(op: () => Promise<void>): Promise<void> {
    const run = () =>
      op().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.store.appendLog(`Sync operation failed: ${msg}`);
        this.setStatus("error", msg);
      });
    this.opChain = this.opChain.then(run, run);
    return this.opChain;
  }

  private notify(kind: "info" | "warn", message: string): void {
    if (this.opts.notify) {
      this.opts.notify(kind, message);
      return;
    }
    if (kind === "warn") void vscode.window.showWarningMessage(message);
    else void vscode.window.showInformationMessage(message);
  }

  // ─── state building / reading ───────────────────────────────────────────

  private buildLocalState(): SyncState {
    const issues = this.store.list();
    const idToGuid = new Map(issues.map((i) => [i.id, i.guid]));
    const tombs = this.store.getSyncTombstones();
    const elementsByGuid = new Map<string, { tasks: ElementTombstone[]; attachments: ElementTombstone[] }>();
    for (const e of tombs.elements) {
      let bucket = elementsByGuid.get(e.ticketGuid);
      if (!bucket) {
        bucket = { tasks: [], attachments: [] };
        elementsByGuid.set(e.ticketGuid, bucket);
      }
      bucket[e.scope === "task" ? "tasks" : "attachments"].push({
        id: e.elementId,
        deletedAt: e.deletedAt,
      });
    }
    const tickets = new Map<string, WireTicket>();
    for (const i of issues) {
      tickets.set(i.guid, toWire(i, idToGuid, elementsByGuid.get(i.guid)));
    }
    const tombstones = new Map<string, Tombstone>();
    for (const t of tombs.tickets) {
      tombstones.set(t.guid, { guid: t.guid, deletedAt: t.deletedAt, lastId: t.lastId });
    }
    return { tickets, tombstones };
  }

  private async readState(tip: string): Promise<SyncState> {
    const repo = this.repo!;
    const entries = await repo.readTree(tip);
    const meta = entries.find((e) => e.path === "meta.json");
    const wanted = entries.filter(
      (e) =>
        e.type === "blob" &&
        (e.path === "meta.json" ||
          e.path.startsWith("tickets/") ||
          e.path.startsWith("tombstones/")),
    );
    const blobs = await repo.catFileBatch(wanted.map((e) => e.oid));

    if (meta) {
      try {
        const parsed = JSON.parse(blobs.get(meta.oid)?.toString("utf8") ?? "{}") as {
          formatVersion?: number;
        };
        if (typeof parsed.formatVersion === "number" && parsed.formatVersion > FORMAT_VERSION) {
          // Newer wire format than this build understands: never corrupt.
          throw new GitError(
            "GitFailed",
            `Sync state formatVersion ${parsed.formatVersion} is newer than this build (v${FORMAT_VERSION}); refusing to merge.`,
          );
        }
      } catch (e) {
        if (e instanceof GitError) throw e;
        // Unparsable meta — treat as v1 and let per-ticket coercion cope.
      }
    }

    const tickets = new Map<string, WireTicket>();
    const tombstones = new Map<string, Tombstone>();
    for (const e of wanted) {
      const body = blobs.get(e.oid);
      if (!body) continue;
      if (e.path.startsWith("tickets/")) {
        try {
          const wire = coerceWireTicket(JSON.parse(body.toString("utf8")));
          if (wire) tickets.set(wire.guid, wire);
          else this.store.appendLog(`Sync: skipped malformed ticket blob at ${e.path}`);
        } catch {
          this.store.appendLog(`Sync: skipped unparsable ticket blob at ${e.path}`);
        }
      } else if (e.path.startsWith("tombstones/")) {
        try {
          const raw = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
          if (
            typeof raw.guid === "string" &&
            raw.guid &&
            typeof raw.deletedAt === "string" &&
            !Number.isNaN(Date.parse(raw.deletedAt))
          ) {
            tombstones.set(raw.guid, {
              guid: raw.guid,
              deletedAt: raw.deletedAt,
              lastId: typeof raw.lastId === "string" ? raw.lastId : "",
            });
          }
        } catch {
          this.store.appendLog(`Sync: skipped unparsable tombstone blob at ${e.path}`);
        }
      }
    }
    return { tickets, tombstones };
  }

  /** path (`attachments/<guid>/<attId>`) → blob oid map at a tip. */
  private async attachmentOidsAt(tip: string | null): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!tip || !this.repo) return out;
    for (const e of await this.repo.readTree(tip)) {
      if (e.type === "blob" && e.path.startsWith("attachments/")) out.set(e.path, e.oid);
    }
    return out;
  }

  /**
   * Attachment-bytes tree entries (05-attachments §2): skip entirely when
   * disabled; over-cap files sync metadata only (logged — no silent caps);
   * previously-committed blobs reuse their OID without touching the file
   * (attachments are immutable per id), keeping commits O(changed bytes);
   * a missing local file never fails the commit.
   */
  private async buildAttachmentEntries(
    state: SyncState,
    prevOids: Map<string, string>,
  ): Promise<TreeEntry[]> {
    if (this.opts.syncAttachments === false) return [];
    const repo = this.repo!;
    const cap = this.opts.maxAttachmentSyncBytes ?? 5 * 1024 * 1024;
    const perGuid: TreeEntry[] = [];
    for (const [guid, t] of [...state.tickets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const files: TreeEntry[] = [];
      for (const att of t.attachments) {
        if (att.sizeBytes > cap) {
          this.store.appendLog(
            `Sync: attachment ${t.id}/${att.name} (${att.sizeBytes} bytes) exceeds dostuff.sync.maxAttachmentSyncBytes — metadata only.`,
          );
          continue;
        }
        const treePath = `attachments/${guid}/${att.id}`;
        const reused = prevOids.get(treePath);
        if (reused) {
          files.push({ mode: "100644", type: "blob", oid: reused, path: att.id });
          continue;
        }
        try {
          const bytes = await this.store.readAttachment(t.id, att.id);
          files.push({
            mode: "100644",
            type: "blob",
            oid: await repo.hashObjectStdin(Buffer.from(bytes)),
            path: att.id,
          });
        } catch {
          this.store.appendLog(
            `Sync: attachment file missing for ${t.id}/${att.id} — metadata only.`,
          );
        }
      }
      if (files.length) {
        perGuid.push({ mode: "040000", type: "tree", oid: await repo.mkTree(files), path: guid });
      }
    }
    return perGuid;
  }

  private async writeState(state: SyncState, prevAttachmentOids?: Map<string, string>): Promise<string> {
    const repo = this.repo!;
    const ticketEntries: TreeEntry[] = [];
    for (const [guid, t] of [...state.tickets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      ticketEntries.push({
        mode: "100644",
        type: "blob",
        oid: await repo.hashObjectStdin(Buffer.from(canonicalJson(t), "utf8")),
        path: `${guid}.json`,
      });
    }
    const tombEntries: TreeEntry[] = [];
    for (const [guid, t] of [...state.tombstones.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      tombEntries.push({
        mode: "100644",
        type: "blob",
        oid: await repo.hashObjectStdin(Buffer.from(canonicalJson(t), "utf8")),
        path: `${guid}.json`,
      });
    }
    const rootEntries: TreeEntry[] = [
      {
        mode: "100644",
        type: "blob",
        oid: await repo.hashObjectStdin(
          Buffer.from(canonicalJson({ formatVersion: FORMAT_VERSION }), "utf8"),
        ),
        path: "meta.json",
      },
    ];
    if (ticketEntries.length) {
      rootEntries.push({
        mode: "040000",
        type: "tree",
        oid: await repo.mkTree(ticketEntries),
        path: "tickets",
      });
    }
    if (tombEntries.length) {
      rootEntries.push({
        mode: "040000",
        type: "tree",
        oid: await repo.mkTree(tombEntries),
        path: "tombstones",
      });
    }
    const attEntries = await this.buildAttachmentEntries(state, prevAttachmentOids ?? new Map());
    if (attEntries.length) {
      rootEntries.push({
        mode: "040000",
        type: "tree",
        oid: await repo.mkTree(attEntries),
        path: "attachments",
      });
    }
    return repo.mkTree(rootEntries);
  }

  // ─── core ops (always run on the chain) ─────────────────────────────────

  /**
   * Commit the current local state onto the local ref with CAS + re-merge
   * retries. Works offline; never pushes. Applies back any state the tip had
   * that we didn't (renumbers, other-window edits).
   */
  private async commitLocalOp(): Promise<void> {
    const repo = this.repo;
    if (!repo) return;
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      const oldTip = await repo.revParse(this.opts.ref);
      const local = this.buildLocalState();
      let outbound = local;
      if (oldTip) {
        outbound = mergeStates(await this.readState(oldTip), local);
      }
      const { state: settled } = renumber(outbound);
      const rootTree = await this.writeState(settled, await this.attachmentOidsAt(oldTip));

      if (oldTip) {
        // No-op detection: unchanged root tree → nothing to commit.
        const oldTree = await repo.revParse(`${oldTip}^{tree}`);
        if (oldTree === rootTree) {
          this.lastSeenTip = oldTip;
          // The tip may still carry state we haven't applied (applyState
          // self-guards and no-ops when the store already matches).
          await this.applyState(settled, oldTip);
          return;
        }
      }
      const commit = await repo.commitTree(
        rootTree,
        oldTip ? [oldTip] : [],
        `dostuff: ${settled.tickets.size} tickets, ${settled.tombstones.size} tombstones`,
      );
      try {
        await repo.updateRefCas(this.opts.ref, commit, oldTip);
      } catch (e) {
        if (e instanceof GitError && e.code === "CasFailed") continue; // re-read, re-merge, retry
        throw e;
      }
      this.lastSeenTip = commit;
      // The commit may have folded in tip-side state we hadn't applied.
      await this.applyState(settled, commit);
      this.schedulePushFollowUp();
      return;
    }
    this.setStatus("error", "Local ref CAS kept failing — will retry on next change/sync");
  }

  /** Another window moved the local ref — apply its tip. */
  private async applyTipOp(tip: string): Promise<void> {
    const repo = this.repo;
    if (!repo) return;
    const result = await this.applyState(await this.readState(tip), tip);
    // Only mark the tip seen after a successful apply — a throw above leaves
    // it unset so the next poll retries instead of silently skipping it.
    this.lastSeenTip = tip;
    if (result.applied > 0) {
      // Our cache may have had state the tip lacked — fold it back in.
      await this.commitLocalOp();
    }
  }

  /** Full network cycle: commit local → fetch → merge → apply → push. */
  async syncNow(reason: "manual" | "interval" | "startup" | "push-follow-up"): Promise<SyncResult> {
    const result: SyncResult = { applied: 0, pushed: false, renames: [], laneOverflow: [] };
    await this.chain(async () => {
      const repo = this.repo;
      if (!repo) return;
      this.setStatus("syncing", `sync (${reason})`);
      try {
        await this.commitLocalOp();

        const remoteUrl = await repo.remoteUrl(this.opts.remote);
        if (!remoteUrl) {
          this.setStatus("noRemote", `Remote "${this.opts.remote}" is not configured — local-only mode`);
          return;
        }

        const remoteOid = await repo.lsRemote(this.opts.remote, this.opts.ref);
        let localTip = await repo.revParse(this.opts.ref);

        if (remoteOid && remoteOid !== localTip) {
          await repo.fetchStateRef(this.opts.remote, this.opts.ref, TRACKING_REF);
          const remoteTip = (await repo.revParse(TRACKING_REF))!;

          if (localTip && (await repo.isAncestor(remoteTip, localTip))) {
            // Remote is behind — nothing to apply; push below.
          } else if (localTip && (await repo.isAncestor(localTip, remoteTip))) {
            // Fast-forward: adopt the remote tip, no new commit.
            await repo.updateRefCas(this.opts.ref, remoteTip, localTip);
            this.lastSeenTip = remoteTip;
            const applied = await this.applyState(await this.readState(remoteTip), remoteTip);
            result.applied += applied.applied;
            result.renames.push(...applied.renames);
            result.laneOverflow = applied.laneOverflow;
            localTip = remoteTip;
          } else {
            // True divergence (or unborn local): state-merge with both parents.
            const localState = localTip ? await this.readState(localTip) : this.buildLocalState();
            const merged = mergeStates(localState, await this.readState(remoteTip));
            const { state: settled } = renumber(merged);
            // Blob OIDs reusable from either parent tip.
            const prevOids = new Map([
              ...(await this.attachmentOidsAt(localTip)),
              ...(await this.attachmentOidsAt(remoteTip)),
            ]);
            const rootTree = await this.writeState(settled, prevOids);
            const parents = localTip ? [localTip, remoteTip] : [remoteTip];
            const commit = await repo.commitTree(rootTree, parents, "dostuff: merge");
            await repo.updateRefCas(this.opts.ref, commit, localTip);
            this.lastSeenTip = commit;
            const applied = await this.applyState(settled, commit);
            result.applied += applied.applied;
            result.renames.push(...applied.renames);
            result.laneOverflow = applied.laneOverflow;
            localTip = commit;
          }
        }

        // Push when we're ahead (or the remote ref doesn't exist yet).
        localTip = localTip ?? (await repo.revParse(this.opts.ref));
        if (localTip && localTip !== remoteOid) {
          result.pushed = await this.pushWithRetry();
          if (!result.pushed) return; // status already pendingPush
        }
        this._status = { ...this._status, lastSyncAt: new Date().toISOString() };
        this.setStatus("idle");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof GitError && e.code === "AuthFailed") {
          this.setStatus(
            "error",
            "Git auth failed — run `git fetch` in a terminal once to prime credentials",
          );
        } else {
          this.setStatus("error", msg);
        }
        this.store.appendLog(`Sync failed (${reason}): ${msg}`);
      }
    });
    return result;
  }

  private async pushWithRetry(): Promise<boolean> {
    const repo = this.repo!;
    for (let attempt = 0; attempt < PUSH_RETRIES; attempt++) {
      try {
        await repo.pushStateRef(this.opts.remote, this.opts.ref);
        return true;
      } catch (e) {
        if (e instanceof GitError && e.code === "NonFastForward") {
          // Someone pushed since our fetch: fetch → merge → try again.
          await repo.fetchStateRef(this.opts.remote, this.opts.ref, TRACKING_REF);
          const remoteTip = await repo.revParse(TRACKING_REF);
          const localTip = await repo.revParse(this.opts.ref);
          if (remoteTip && localTip && !(await repo.isAncestor(remoteTip, localTip))) {
            const merged = mergeStates(
              await this.readState(localTip),
              await this.readState(remoteTip),
            );
            const { state: settled } = renumber(merged);
            const prevOids = new Map([
              ...(await this.attachmentOidsAt(localTip)),
              ...(await this.attachmentOidsAt(remoteTip)),
            ]);
            const rootTree = await this.writeState(settled, prevOids);
            const commit = await repo.commitTree(rootTree, [localTip, remoteTip], "dostuff: merge");
            await repo.updateRefCas(this.opts.ref, commit, localTip);
            this.lastSeenTip = commit;
            await this.applyState(settled, commit);
          }
          continue;
        }
        this.setStatus("pendingPush", e instanceof Error ? e.message : String(e));
        return false;
      }
    }
    this.setStatus("pendingPush", "Push kept losing the race — will retry on next sync");
    return false;
  }

  private schedulePushFollowUp(): void {
    if (this.pushFollowUpTimer) return; // one coalesced follow-up
    this.pushFollowUpTimer = setTimeout(() => {
      this.pushFollowUpTimer = null;
      void this.syncNow("push-follow-up").catch(() => {});
    }, this.opts.pushFollowUpMs ?? 30_000);
  }

  // ─── inbound application ────────────────────────────────────────────────

  /**
   * Witness fields (`deletedTasks`/`deletedAttachments`) are sourced
   * differently on the two sides of a cache-vs-wire comparison — the local
   * `sync_tombstones` table never learns remote-origin tombstones (applySync
   * records nothing) and its wall-clock prune diverges from the merge GC —
   * so they can disagree forever on logically-identical tickets. Strip them
   * before comparing; convergence of the witnesses themselves is guaranteed
   * by the outbound `mergeStates` union, not by store writes.
   */
  private static stripWitnesses(w: WireTicket): WireTicket {
    return { ...w, deletedTasks: [], deletedAttachments: [] };
  }

  private elementTombstonesFor(guid: string): {
    tasks: ElementTombstone[];
    attachments: ElementTombstone[];
  } {
    const tombs = this.store.getSyncTombstones();
    const out = { tasks: [] as ElementTombstone[], attachments: [] as ElementTombstone[] };
    for (const e of tombs.elements) {
      if (e.ticketGuid !== guid) continue;
      out[e.scope === "task" ? "tasks" : "attachments"].push({
        id: e.elementId,
        deletedAt: e.deletedAt,
      });
    }
    return out;
  }

  /**
   * Apply a merged state to the store: fold the live cache, renumber,
   * attachment-dir renames first, then one `applySync`, then notifications
   * (04-controller-wiring §2). Self-guarding: when the folded state already
   * matches the store, no write and no notification happens.
   */
  private async applyState(rawState: SyncState, tip?: string | null): Promise<SyncResult> {
    // Fold the LIVE cache in: store mutations may have landed after the
    // snapshot `rawState` was computed from (the fetch window is seconds
    // long). Merge idempotence makes this free when nothing changed, and it
    // guarantees a cache ticket absent from the folded state was beaten by a
    // tombstone — a sync cycle racing a local create/edit can no longer
    // delete the new ticket or clobber the fresh edit.
    const folded = mergeStates(rawState, this.buildLocalState());
    const { state } = renumber(folded);

    const cache = this.store.list();
    const idToGuid = new Map(cache.map((i) => [i.id, i.guid]));
    const cacheByGuid = new Map(cache.map((i) => [i.guid, i]));
    const guidToId = new Map([...state.tickets.values()].map((t) => [t.guid, t.id]));

    const upserts: Issue[] = [];
    let applied = 0;
    for (const wire of state.tickets.values()) {
      const prior = cacheByGuid.get(wire.guid);
      if (prior) {
        const projected = toWire(prior, idToGuid, this.elementTombstonesFor(wire.guid));
        if (
          canonicalJson(GitSyncController.stripWitnesses(projected)) ===
          canonicalJson(GitSyncController.stripWitnesses(wire))
        ) {
          continue; // unchanged — keep the cache copy untouched
        }
      }
      const { issue, coerced } = normalize(fromWire(wire, guidToId));
      if (coerced.length) {
        this.store.appendLog(`Sync: coerced fields on ${issue.id}: ${coerced.join(", ")}`);
      }
      upserts.push(issue);
      applied += 1;
    }

    // Removals and renames both come from the cache-vs-state diff, not from
    // renumber()'s rename list — the caller may have pre-renumbered its
    // state, in which case renumber() here sees no collision but the cache
    // still holds rows under the old ids. A vanished guid necessarily lost
    // to a ticket tombstone after the live-cache fold (one-sided presence is
    // otherwise kept by the merge) — the `has` check is an invariant belt.
    const renames: Array<{ guid: string; oldId: string; newId: string }> = [];
    const removals: string[] = [];
    const tombstoned: string[] = [];
    for (const i of cache) {
      const wire = state.tickets.get(i.guid);
      if (!wire) {
        if (state.tombstones.has(i.guid)) {
          removals.push(i.id);
          tombstoned.push(i.id);
        }
      } else if (wire.id !== i.id) {
        renames.push({ guid: i.guid, oldId: i.id, newId: wire.id });
        removals.push(i.id);
      }
    }

    if (upserts.length === 0 && removals.length === 0) {
      // Nothing to write; still fill any missing attachment bytes (a prior
      // restore may have failed) and skip every notification.
      const attRootIdle = this.store.attachmentsDir();
      if (tip && attRootIdle && this.opts.syncAttachments !== false) {
        try {
          await this.restoreAttachments(state, tip, attRootIdle.fsPath);
        } catch (e) {
          this.store.appendLog(
            `Sync: attachment restore failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return { applied: 0, pushed: false, renames: [], laneOverflow: [] };
    }

    // Attachment dir renames before any restore (and before removal of old
    // rows). Node fs, not vscode fs — attachment bytes always live on the
    // extension host's disk (same posture as gitPlumbing's blob streaming).
    const attRoot = this.store.attachmentsDir();
    if (attRoot) {
      for (const r of renames) {
        const from = nodePath.join(attRoot.fsPath, r.oldId);
        const to = nodePath.join(attRoot.fsPath, r.newId);
        if (!insideRoot(attRoot.fsPath, from) || !insideRoot(attRoot.fsPath, to)) {
          this.store.appendLog(`Sync: refused attachment dir rename for unsafe id ${r.oldId}`);
          continue;
        }
        try {
          await fsp.rename(from, to);
        } catch {
          // Dir may simply not exist — the common case.
        }
      }
    }

    applied += removals.length;
    this.applyingRemote += 1;
    try {
      await this.store.applySync({ upserts, removals, tombstoned });
    } finally {
      this.applyingRemote -= 1;
    }

    // Restore genuinely-missing attachment bytes from the ref tree — after
    // the renumber dir-renames, before notifications (05-attachments §3).
    if (tip && attRoot && this.opts.syncAttachments !== false) {
      try {
        await this.restoreAttachments(state, tip, attRoot.fsPath);
      } catch (e) {
        this.store.appendLog(
          `Sync: attachment restore failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Notifications.
    if (renames.length) {
      this.notify(
        "info",
        `DoStuff sync renumbered ${renames.length} ticket(s): ${renames
          .map((r) => `${r.oldId} → ${r.newId}`)
          .join(", ")}`,
      );
    }
    const laneOverflow = this.computeLaneOverflow();
    if (laneOverflow.length && !this.warnedOverflow) {
      this.warnedOverflow = true;
      this.notify(
        "warn",
        `DoStuff sync left ${laneOverflow.join(", ")} over the lane cap — the lane rejects new moves until drained.`,
      );
    } else if (!laneOverflow.length) {
      this.warnedOverflow = false; // re-arm once the overflow drains
    }

    return {
      applied,
      pushed: false,
      renames: renames.map((r) => ({ oldId: r.oldId, newId: r.newId })),
      laneOverflow,
    };
  }

  /**
   * Fill only genuinely-missing attachment files from the tree at `tip`
   * (05-attachments §3): existing local files are left alone; ids listed in
   * a ticket's `deletedAttachments` are skipped (belt-and-braces — they are
   * already absent from metadata); anything else stays missing and falls
   * back to the existing missing-file UX.
   */
  private async restoreAttachments(state: SyncState, tip: string, attRootPath: string): Promise<void> {
    const repo = this.repo;
    if (!repo) return;
    const oids = await this.attachmentOidsAt(tip);
    if (oids.size === 0) return;
    for (const wire of state.tickets.values()) {
      if (wire.attachments.length === 0) continue;
      const deleted = new Set(wire.deletedAttachments.map((d) => d.id));
      for (const att of wire.attachments) {
        if (deleted.has(att.id)) continue;
        const oid = oids.get(`attachments/${wire.guid}/${att.id}`);
        if (!oid) continue; // bytes were never synced (cap/skip) — leave missing
        if (await this.store.findAttachmentUri(wire.id, att.id)) continue; // already present
        // `att.name` is remote-controlled — the extension must never smuggle
        // a separator into the destination path.
        const dir = nodePath.join(attRootPath, wire.id);
        const dest = nodePath.join(dir, `${att.id}${sanitizeExt(att.name)}`);
        if (!insideRoot(attRootPath, dir) || !insideRoot(dir, dest)) {
          this.store.appendLog(`Sync: refused attachment restore for unsafe path ${wire.id}/${att.id}`);
          continue;
        }
        await fsp.mkdir(dir, { recursive: true });
        await repo.catBlobToFile(oid, dest);
      }
    }
  }

  private computeLaneOverflow(): string[] {
    const counts = new Map<Status, number>();
    for (const i of this.store.list()) {
      counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
    }
    return ACTIVE_LANES.filter((lane) => (counts.get(lane) ?? 0) > this.opts.activeLaneCap);
  }
}
