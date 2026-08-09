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

import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { Emitter, type Disposable } from "./events";
import { normalize } from "./storageCore";
import type { IssueStoreCore } from "./storageCore";
import { findRepoRoot, GitError, GitRepo, type GitRepoOptions, type TreeEntry } from "./gitPlumbing";
import {
  canonicalJson,
  coerceTombstone,
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
import type { ElementTombstoneRow, SyncTombstones } from "./storageCore";
import { ACTIVE_LANES, type Issue, type Status } from "./types";

/**
 * Clamp `dostuff.sync.intervalMinutes` to sane bounds: `<= 0` (or garbage)
 * means manual-only network sync; anything positive lands in [1, 120].
 * package.json's declared min/max only constrain the settings UI. Lives here
 * (not extension.ts) so the headless host applies the same clamp.
 */
export function clampSyncInterval(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 5;
  if (n <= 0) return 0;
  return Math.min(120, Math.max(1, n));
}

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
}

/** What one apply pass changed — the slice of SyncResult applyState can know. */
interface ApplyResult {
  applied: number;
  renames: Array<{ oldId: string; newId: string }>;
}

/**
 * The slice of the store the controller needs. Narrow on purpose so tests
 * can drive two controllers against lightweight in-memory stores while the
 * real `IssueStoreCore` (and its extension subclass) satisfies it
 * structurally.
 */
export type SyncStoreLike = Pick<
  IssueStoreCore,
  | "list"
  | "get"
  | "getSyncTombstones"
  | "applySync"
  | "onChange"
  | "appendLog"
  | "attachmentsPath"
  | "readAttachment"
  | "findAttachmentPath"
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
  /** Notification sink — the extension passes vscode toasts; defaults to the
   *  store log so the controller stays host-agnostic. */
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

export class GitSyncController {
  private repo: GitRepo | null = null;
  private opChain: Promise<void> = Promise.resolve();
  private disposables: Disposable[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pushFollowUpTimer: ReturnType<typeof setTimeout> | null = null;
  private applyingRemote = 0; // echo suppression counter
  private lastSeenTip: string | null = null;
  private warnedOverflow = false;
  private started = false;

  private _status: SyncStatus = { state: "disabled" };
  private readonly statusEmitter = new Emitter<SyncStatus>();
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
    this.store.appendLog(`Sync ${kind}: ${message}`);
  }

  // ─── state building / reading ───────────────────────────────────────────

  /** Group element-tombstone rows by owning ticket guid. */
  private static bucketElementTombstones(
    rows: ElementTombstoneRow[],
  ): Map<string, { tasks: ElementTombstone[]; attachments: ElementTombstone[] }> {
    const byGuid = new Map<string, { tasks: ElementTombstone[]; attachments: ElementTombstone[] }>();
    for (const e of rows) {
      let bucket = byGuid.get(e.ticketGuid);
      if (!bucket) {
        bucket = { tasks: [], attachments: [] };
        byGuid.set(e.ticketGuid, bucket);
      }
      bucket[e.scope === "task" ? "tasks" : "attachments"].push({
        id: e.elementId,
        deletedAt: e.deletedAt,
      });
    }
    return byGuid;
  }

  /** `tombs` is accepted so callers that already fetched the witnesses (one
   *  SELECT) can share them instead of re-querying per use. */
  private buildLocalState(tombs: SyncTombstones = this.store.getSyncTombstones()): SyncState {
    const issues = this.store.list();
    const idToGuid = new Map(issues.map((i) => [i.id, i.guid]));
    const elementsByGuid = GitSyncController.bucketElementTombstones(tombs.elements);
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

  /**
   * Tree listing of an immutable tip, memoized — `readState` and
   * `attachmentOidsAt` are routinely called on the same tip within one cycle,
   * and each listing is a full `git ls-tree -r` spawn. Git objects never
   * change under an oid, so entries can be cached indefinitely; the small cap
   * just bounds memory.
   */
  private readonly treeCache = new Map<string, TreeEntry[]>();
  private async entriesAt(tip: string): Promise<TreeEntry[]> {
    const hit = this.treeCache.get(tip);
    if (hit) return hit;
    const entries = await this.repo!.readTree(tip);
    this.treeCache.set(tip, entries);
    if (this.treeCache.size > 4) {
      const oldest = this.treeCache.keys().next().value;
      if (oldest !== undefined) this.treeCache.delete(oldest);
    }
    return entries;
  }

  private async readState(tip: string): Promise<SyncState> {
    const repo = this.repo!;
    const entries = await this.entriesAt(tip);
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
          const tomb = coerceTombstone(JSON.parse(body.toString("utf8")));
          if (tomb) tombstones.set(tomb.guid, tomb);
          else this.store.appendLog(`Sync: skipped malformed tombstone blob at ${e.path}`);
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
    for (const e of await this.entriesAt(tip)) {
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
    sortedTickets: Array<[string, WireTicket]>,
    prevOids: Map<string, string>,
  ): Promise<TreeEntry[]> {
    if (this.opts.syncAttachments === false) return [];
    const repo = this.repo!;
    const cap = this.opts.maxAttachmentSyncBytes ?? 5 * 1024 * 1024;
    const perGuid: TreeEntry[] = [];
    for (const [guid, t] of sortedTickets) {
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
    const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : 1);
    const sortedTickets = [...state.tickets.entries()].sort(byKey);
    const sortedTombs = [...state.tombstones.entries()].sort(byKey);

    // Every blob hash is independent — run them (and the attachment-subtree
    // build) concurrently instead of one spawn-await per object. Loose-object
    // writes are atomic, so concurrent `hash-object -w` is safe.
    const blobEntry = (guid: string, oid: string): TreeEntry => ({
      mode: "100644",
      type: "blob",
      oid,
      path: `${guid}.json`,
    });
    const [metaOid, ticketOids, tombOids, attEntries] = await Promise.all([
      repo.hashObjectStdin(Buffer.from(canonicalJson({ formatVersion: FORMAT_VERSION }), "utf8")),
      Promise.all(
        sortedTickets.map(([, t]) => repo.hashObjectStdin(Buffer.from(canonicalJson(t), "utf8"))),
      ),
      Promise.all(
        sortedTombs.map(([, t]) => repo.hashObjectStdin(Buffer.from(canonicalJson(t), "utf8"))),
      ),
      this.buildAttachmentEntries(sortedTickets, prevAttachmentOids ?? new Map()),
    ]);

    const rootEntries: TreeEntry[] = [
      { mode: "100644", type: "blob", oid: metaOid, path: "meta.json" },
    ];
    if (sortedTickets.length) {
      const tree = await repo.mkTree(sortedTickets.map(([guid], i) => blobEntry(guid, ticketOids[i]!)));
      rootEntries.push({ mode: "040000", type: "tree", oid: tree, path: "tickets" });
    }
    if (sortedTombs.length) {
      const tree = await repo.mkTree(sortedTombs.map(([guid], i) => blobEntry(guid, tombOids[i]!)));
      rootEntries.push({ mode: "040000", type: "tree", oid: tree, path: "tombstones" });
    }
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

  /**
   * The shared two-tip merge-commit protocol (used by the syncNow divergence
   * branch and the non-fast-forward push retry): read both states,
   * state-merge, renumber, write the tree reusing attachment OIDs from both
   * parents, commit with both tips as parents, CAS the local ref, apply.
   * `localTip: null` = unborn local ref (first sync against an existing
   * remote) — the remote tip becomes the sole parent.
   */
  private async mergeTips(
    localTip: string | null,
    remoteTip: string,
  ): Promise<{ commit: string; applied: ApplyResult }> {
    const repo = this.repo!;
    const localState = localTip ? await this.readState(localTip) : this.buildLocalState();
    const merged = mergeStates(localState, await this.readState(remoteTip));
    const { state: settled } = renumber(merged);
    const prevOids = new Map([
      ...(await this.attachmentOidsAt(localTip)),
      ...(await this.attachmentOidsAt(remoteTip)),
    ]);
    const rootTree = await this.writeState(settled, prevOids);
    const commit = await repo.commitTree(
      rootTree,
      localTip ? [localTip, remoteTip] : [remoteTip],
      "dostuff: merge",
    );
    await repo.updateRefCas(this.opts.ref, commit, localTip);
    this.lastSeenTip = commit;
    const applied = await this.applyState(settled, commit);
    return { commit, applied };
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
    const result: SyncResult = { applied: 0, pushed: false, renames: [] };
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
            localTip = remoteTip;
          } else {
            // True divergence (or unborn local): merge-commit with both parents.
            const { commit, applied } = await this.mergeTips(localTip, remoteTip);
            result.applied += applied.applied;
            result.renames.push(...applied.renames);
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
            await this.mergeTips(localTip, remoteTip);
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

  /** One guarded restore pass; shared by the changed and no-change apply paths. */
  private async tryRestoreAttachments(state: SyncState, tip: string | null | undefined): Promise<void> {
    const attRoot = this.store.attachmentsPath();
    if (!tip || !attRoot || this.opts.syncAttachments === false) return;
    try {
      await this.restoreAttachments(state, tip, attRoot);
    } catch (e) {
      this.store.appendLog(
        `Sync: attachment restore failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Apply a merged state to the store: fold the live cache, renumber,
   * attachment-dir renames first, then one `applySync`, then notifications
   * (04-controller-wiring §2). Self-guarding: when the folded state already
   * matches the store, no write and no notification happens.
   */
  private async applyState(rawState: SyncState, tip?: string | null): Promise<ApplyResult> {
    // Fold the LIVE cache in: store mutations may have landed after the
    // snapshot `rawState` was computed from (the fetch window is seconds
    // long). Merge idempotence makes this free when nothing changed, and it
    // guarantees a cache ticket absent from the folded state was beaten by a
    // tombstone — a sync cycle racing a local create/edit can no longer
    // delete the new ticket or clobber the fresh edit.
    const tombs = this.store.getSyncTombstones();
    const folded = mergeStates(rawState, this.buildLocalState(tombs));
    const { state } = renumber(folded);

    const cache = this.store.list();
    const idToGuid = new Map(cache.map((i) => [i.id, i.guid]));
    const cacheByGuid = new Map(cache.map((i) => [i.guid, i]));
    const guidToId = new Map([...state.tickets.values()].map((t) => [t.guid, t.id]));
    const tombsByGuid = GitSyncController.bucketElementTombstones(tombs.elements);

    const upserts: Issue[] = [];
    let applied = 0;
    for (const wire of state.tickets.values()) {
      const prior = cacheByGuid.get(wire.guid);
      if (prior) {
        const projected = toWire(prior, idToGuid, tombsByGuid.get(wire.guid));
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
      await this.tryRestoreAttachments(state, tip);
      return { applied: 0, renames: [] };
    }

    // Attachment dir renames before any restore (and before removal of old
    // rows). Node fs, not vscode fs — attachment bytes always live on the
    // extension host's disk (same posture as gitPlumbing's blob streaming).
    const attRoot = this.store.attachmentsPath();
    if (attRoot) {
      for (const r of renames) {
        const from = nodePath.join(attRoot, r.oldId);
        const to = nodePath.join(attRoot, r.newId);
        if (!insideRoot(attRoot, from) || !insideRoot(attRoot, to)) {
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
    await this.tryRestoreAttachments(state, tip);

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
      renames: renames.map((r) => ({ oldId: r.oldId, newId: r.newId })),
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
        if (await this.store.findAttachmentPath(wire.id, att.id)) continue; // already present
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
