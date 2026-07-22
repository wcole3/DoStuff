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
import { normalize } from "./storage";
import type { IssueStore } from "./storage";
import { findRepoRoot, GitError, GitRepo, type GitRepoOptions, type TreeEntry } from "./gitPlumbing";
import {
  canonicalJson,
  coerceWireTicket,
  fromWire,
  mergeStates,
  renumber,
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
  "list" | "get" | "getSyncTombstones" | "applySync" | "onChange" | "appendLog" | "attachmentsDir"
>;

export interface GitSyncOptions {
  remote: string; // e.g. "origin"
  ref: string; // e.g. "refs/dostuff/state"; validated ^refs/
  intervalMinutes: number; // 0 = manual network sync only
  activeLaneCap: number;
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

  /** Single-flight op chain — the `reconcilePromise` pattern. */
  private chain(op: () => Promise<void>): Promise<void> {
    this.opChain = this.opChain.then(op, op);
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

  private async writeState(state: SyncState): Promise<string> {
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
      const { state: settled, renames } = renumber(outbound);
      const rootTree = await this.writeState(settled);

      if (oldTip) {
        // No-op detection: unchanged root tree → nothing to commit.
        const oldTree = await repo.revParse(`${oldTip}^{tree}`);
        if (oldTree === rootTree) {
          this.lastSeenTip = oldTip;
          if (renames.length || this.stateDiffersFromCache(settled)) {
            await this.applyState(settled, renames);
          }
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
      if (renames.length || this.stateDiffersFromCache(settled)) {
        await this.applyState(settled, renames);
      }
      this.schedulePushFollowUp();
      return;
    }
    this.setStatus("error", "Local ref CAS kept failing — will retry on next change/sync");
  }

  /** Another window moved the local ref — apply its tip. */
  private async applyTipOp(tip: string): Promise<void> {
    const repo = this.repo;
    if (!repo) return;
    const merged = mergeStates(await this.readState(tip), this.buildLocalState());
    const { state: settled, renames } = renumber(merged);
    this.lastSeenTip = tip;
    if (renames.length || this.stateDiffersFromCache(settled)) {
      await this.applyState(settled, renames);
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
            const { state: settled, renames } = renumber(await this.readState(remoteTip));
            const applied = await this.applyState(settled, renames);
            result.applied += applied.applied;
            result.renames.push(...applied.renames);
            result.laneOverflow = applied.laneOverflow;
            localTip = remoteTip;
          } else {
            // True divergence (or unborn local): state-merge with both parents.
            const localState = localTip ? await this.readState(localTip) : this.buildLocalState();
            const merged = mergeStates(localState, await this.readState(remoteTip));
            const { state: settled, renames } = renumber(merged);
            const rootTree = await this.writeState(settled);
            const parents = localTip ? [localTip, remoteTip] : [remoteTip];
            const commit = await repo.commitTree(rootTree, parents, "dostuff: merge");
            await repo.updateRefCas(this.opts.ref, commit, localTip);
            this.lastSeenTip = commit;
            const applied = await this.applyState(settled, renames);
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
            const { state: settled, renames } = renumber(merged);
            const rootTree = await this.writeState(settled);
            const commit = await repo.commitTree(rootTree, [localTip, remoteTip], "dostuff: merge");
            await repo.updateRefCas(this.opts.ref, commit, localTip);
            this.lastSeenTip = commit;
            await this.applyState(settled, renames);
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

  /** Cheap check: does the settled state differ from the store cache? */
  private stateDiffersFromCache(state: SyncState): boolean {
    const cache = this.store.list();
    if (cache.length !== state.tickets.size) return true;
    const idToGuid = new Map(cache.map((i) => [i.id, i.guid]));
    for (const i of cache) {
      const wire = state.tickets.get(i.guid);
      if (!wire) return true;
      const tombs = this.elementTombstonesFor(i.guid);
      if (canonicalJson(toWire(i, idToGuid, tombs)) !== canonicalJson(wire)) return true;
    }
    return false;
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
   * Apply a settled (merged + renumbered) state to the store: attachment-dir
   * renames first, then one `applySync`, then notifications
   * (04-controller-wiring §2).
   */
  private async applyState(
    state: SyncState,
    renames: Array<{ guid: string; oldId: string; newId: string }>,
  ): Promise<SyncResult> {
    const cache = this.store.list();
    const guidToId = new Map([...state.tickets.values()].map((t) => [t.guid, t.id]));

    // Attachment dir renames before any restore (and before removal of old rows).
    const attRoot = this.store.attachmentsDir();
    if (attRoot) {
      for (const r of renames) {
        try {
          await vscode.workspace.fs.rename(
            vscode.Uri.joinPath(attRoot, r.oldId),
            vscode.Uri.joinPath(attRoot, r.newId),
            { overwrite: false },
          );
        } catch {
          // Dir may simply not exist — the common case.
        }
      }
    }

    const upserts: Issue[] = [];
    for (const wire of state.tickets.values()) {
      const { issue, coerced } = normalize(fromWire(wire, guidToId));
      if (coerced.length) {
        this.store.appendLog(`Sync: coerced fields on ${issue.id}: ${coerced.join(", ")}`);
      }
      upserts.push(issue);
    }

    // Removals: cached ids whose guid vanished (tombstoned) + old ids of renames.
    const removals: string[] = [];
    const tombstoned: string[] = [];
    for (const i of cache) {
      if (!state.tickets.has(i.guid)) {
        removals.push(i.id);
        tombstoned.push(i.id);
      }
    }
    for (const r of renames) {
      if (!removals.includes(r.oldId)) removals.push(r.oldId);
    }

    this.applyingRemote += 1;
    try {
      await this.store.applySync({ upserts, removals, tombstoned });
    } finally {
      this.applyingRemote -= 1;
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
      applied: upserts.length + removals.length,
      pushed: false,
      renames: renames.map((r) => ({ oldId: r.oldId, newId: r.newId })),
      laneOverflow,
    };
  }

  private computeLaneOverflow(): string[] {
    const counts = new Map<Status, number>();
    for (const i of this.store.list()) {
      counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
    }
    return ACTIVE_LANES.filter((lane) => (counts.get(lane) ?? 0) > this.opts.activeLaneCap);
  }
}
