// Tests for the pure merge module (docs/plans/ticket-sync/02-merge-spec.md).
// Property-style, hand-rolled cases — no new deps. Determinism is the whole
// game: every rule is asserted under both argument orders.

import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  coerceWireTicket,
  deriveGuid,
  fromWire,
  mergeStates,
  renumber,
  toWire,
  TOMBSTONE_TTL_MS,
  type SyncState,
  type Tombstone,
  type WireTicket,
} from "./syncMerge";
import type { Issue } from "./types";

// ----- helpers ---------------------------------------------------------------

let counter = 0;
function makeWire(overrides: Partial<WireTicket> = {}): WireTicket {
  counter += 1;
  const number = overrides.number ?? counter;
  const id = overrides.id ?? `DS-${String(number).padStart(3, "0")}`;
  const at = overrides.createdAt ?? "2025-01-01T00:00:00.000Z";
  return {
    guid: overrides.guid ?? `guid-${id}`,
    id,
    number,
    title: overrides.title ?? `Ticket ${number}`,
    description: overrides.description ?? "",
    verifyCriteria: overrides.verifyCriteria ?? "",
    type: overrides.type ?? "Feature",
    priority: overrides.priority ?? "Regular",
    status: overrides.status ?? "Planned",
    createdAt: at,
    updatedAt: overrides.updatedAt ?? at,
    resolvedAt: overrides.resolvedAt ?? null,
    tags: overrides.tags ?? [],
    tasks: overrides.tasks ?? [],
    attachments: overrides.attachments ?? [],
    links: overrides.links ?? [],
    statusHistory: overrides.statusHistory ?? [],
    record: overrides.record ?? [],
    pendingClose: overrides.pendingClose ?? null,
    deletedTasks: overrides.deletedTasks ?? [],
    deletedAttachments: overrides.deletedAttachments ?? [],
  };
}

function state(tickets: WireTicket[] = [], tombstones: Tombstone[] = []): SyncState {
  return {
    tickets: new Map(tickets.map((t) => [t.guid, t])),
    tombstones: new Map(tombstones.map((t) => [t.guid, t])),
  };
}

/** Canonical serialization of a whole state for byte-identity comparison. */
function stateJson(s: SyncState): string {
  return canonicalJson({
    tickets: Object.fromEntries([...s.tickets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    tombstones: Object.fromEntries([...s.tombstones.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
  });
}

const T = (h: number) => `2025-06-01T${String(h).padStart(2, "0")}:00:00.000Z`;

// ----- canonicalJson / deriveGuid -------------------------------------------

describe("canonicalJson", () => {
  test("key order independence + stable output + trailing newline", () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } });
    const b = canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
  });

  test("drops undefined-valued keys (not representable in JSON)", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

// ----- merge: ticket-level LWW ----------------------------------------------

describe("mergeStates: ticket LWW", () => {
  test("newer updatedAt wins wholesale; merged updatedAt = max, createdAt = min", () => {
    const older = makeWire({
      guid: "g1",
      title: "old title",
      createdAt: T(1),
      updatedAt: T(2),
      tags: ["old"],
    });
    const newer = makeWire({
      guid: "g1",
      title: "new title",
      createdAt: T(3), // later createdAt but newer edit
      updatedAt: T(5),
      tags: ["new"],
    });
    for (const [x, y] of [
      [state([older]), state([newer])],
      [state([newer]), state([older])],
    ] as const) {
      const m = mergeStates(x, y);
      const t = m.tickets.get("g1")!;
      expect(t.title).toBe("new title");
      expect(t.tags).toEqual(["new"]);
      expect(t.updatedAt).toBe(T(5));
      expect(t.createdAt).toBe(T(1));
    }
  });

  test("exact-timestamp tie broken by content hash — same winner both orders", () => {
    const a = makeWire({ guid: "g1", title: "aaa", updatedAt: T(4) });
    const b = makeWire({ guid: "g1", title: "bbb", updatedAt: T(4) });
    const m1 = mergeStates(state([a]), state([b]));
    const m2 = mergeStates(state([b]), state([a]));
    expect(stateJson(m1)).toBe(stateJson(m2));
  });

  test("one-sided presence with no tombstone anywhere = created there → kept", () => {
    const only = makeWire({ guid: "g1" });
    const m = mergeStates(state([only]), state([]));
    expect(m.tickets.get("g1")).toBeDefined();
  });
});

// ----- merge: ticket tombstones ---------------------------------------------

describe("mergeStates: ticket tombstones", () => {
  const ticket = (updatedAt: string) => makeWire({ guid: "g1", updatedAt });
  const tomb = (deletedAt: string): Tombstone => ({ guid: "g1", deletedAt, lastId: "DS-001" });

  test("tombstone newer than ticket → tombstone wins (both orders)", () => {
    const m1 = mergeStates(state([ticket(T(2))]), state([], [tomb(T(3))]));
    const m2 = mergeStates(state([], [tomb(T(3))]), state([ticket(T(2))]));
    for (const m of [m1, m2]) {
      expect(m.tickets.has("g1")).toBe(false);
      expect(m.tombstones.get("g1")?.deletedAt).toBe(T(3));
    }
  });

  test("ticket newer than tombstone → ticket survives AND tombstone dropped", () => {
    const m = mergeStates(state([ticket(T(4))]), state([], [tomb(T(3))]));
    expect(m.tickets.has("g1")).toBe(true);
    expect(m.tombstones.has("g1")).toBe(false);
    // Re-merging the dead tombstone later can't re-kill.
    const again = mergeStates(m, state([], [tomb(T(3))]));
    expect(again.tickets.has("g1")).toBe(true);
  });

  test("tie → ticket survives (prefer not losing data)", () => {
    const m = mergeStates(state([ticket(T(3))]), state([], [tomb(T(3))]));
    expect(m.tickets.has("g1")).toBe(true);
  });

  test("tombstone vs tombstone → max deletedAt", () => {
    const m = mergeStates(state([], [tomb(T(2))]), state([], [tomb(T(5))]));
    expect(m.tombstones.get("g1")?.deletedAt).toBe(T(5));
  });
});

// ----- merge: per-element tasks ---------------------------------------------

describe("mergeStates: per-element task merge", () => {
  const task = (id: string, text: string, done: boolean, updatedAt: string) => ({
    id,
    text,
    done,
    updatedAt,
  });

  test("delete at t2 vs edit at t3 → edit survives, tombstone dropped (both orders)", () => {
    const deleter = makeWire({
      guid: "g1",
      updatedAt: T(2),
      tasks: [],
      deletedTasks: [{ id: "tX", deletedAt: T(2) }],
    });
    const editor = makeWire({
      guid: "g1",
      updatedAt: T(3),
      tasks: [task("tX", "edited", true, T(3))],
    });
    for (const [x, y] of [
      [state([deleter]), state([editor])],
      [state([editor]), state([deleter])],
    ] as const) {
      const t = mergeStates(x, y).tickets.get("g1")!;
      expect(t.tasks).toEqual([task("tX", "edited", true, T(3))]);
      expect(t.deletedTasks).toEqual([]);
    }
  });

  test("edit at t1 vs delete at t2 → task gone, tombstone retained (both orders)", () => {
    const editor = makeWire({
      guid: "g1",
      updatedAt: T(1),
      tasks: [task("tX", "edited", false, T(1))],
    });
    const deleter = makeWire({
      guid: "g1",
      updatedAt: T(2),
      tasks: [],
      deletedTasks: [{ id: "tX", deletedAt: T(2) }],
    });
    for (const [x, y] of [
      [state([deleter]), state([editor])],
      [state([editor]), state([deleter])],
    ] as const) {
      const t = mergeStates(x, y).tickets.get("g1")!;
      expect(t.tasks).toEqual([]);
      expect(t.deletedTasks).toEqual([{ id: "tX", deletedAt: T(2) }]);
    }
  });

  test("exact tie → element survives, tombstone dropped", () => {
    const editor = makeWire({ guid: "g1", updatedAt: T(2), tasks: [task("tX", "kept", false, T(2))] });
    const deleter = makeWire({
      guid: "g1",
      updatedAt: T(2),
      tasks: [],
      deletedTasks: [{ id: "tX", deletedAt: T(2) }],
    });
    const t = mergeStates(state([editor]), state([deleter])).tickets.get("g1")!;
    expect(t.tasks.map((k) => k.id)).toEqual(["tX"]);
    expect(t.deletedTasks).toEqual([]);
  });

  test("per-element LWW beats the ticket winner for a both-sides task", () => {
    const winner = makeWire({
      guid: "g1",
      title: "winner",
      updatedAt: T(5),
      tasks: [task("tX", "stale copy", false, T(1))],
    });
    const loser = makeWire({
      guid: "g1",
      title: "loser",
      updatedAt: T(4),
      tasks: [task("tX", "fresh copy", true, T(4))],
    });
    const t = mergeStates(state([winner]), state([loser])).tickets.get("g1")!;
    expect(t.title).toBe("winner");
    expect(t.tasks).toEqual([task("tX", "fresh copy", true, T(4))]);
  });

  test("order: winner's order first, loser-only survivors appended in relative order", () => {
    const w = makeWire({
      guid: "g1",
      updatedAt: T(5),
      tasks: [task("a", "a", false, T(1)), task("b", "b", false, T(1))],
    });
    const l = makeWire({
      guid: "g1",
      updatedAt: T(4),
      tasks: [task("c", "c", false, T(1)), task("a", "a", false, T(1)), task("d", "d", false, T(1))],
    });
    const t = mergeStates(state([w]), state([l])).tickets.get("g1")!;
    expect(t.tasks.map((k) => k.id)).toEqual(["a", "b", "c", "d"]);
  });

  test("draft-reshape (all-new ids + tombstones) vs concurrent done-toggle: newest stamp decides", () => {
    // Side A reshaped via update_ticket_draft at T3: old task tX deleted,
    // fresh task tY added. Side B toggled tX done at T4 (> T3).
    const reshaped = makeWire({
      guid: "g1",
      updatedAt: T(3),
      tasks: [task("tY", "fresh scope", false, T(3))],
      deletedTasks: [{ id: "tX", deletedAt: T(3) }],
    });
    const toggled = makeWire({
      guid: "g1",
      updatedAt: T(4),
      tasks: [task("tX", "old task", true, T(4))],
    });
    const m1 = mergeStates(state([reshaped]), state([toggled]));
    const m2 = mergeStates(state([toggled]), state([reshaped]));
    expect(stateJson(m1)).toBe(stateJson(m2));
    const t = m1.tickets.get("g1")!;
    // Toggle (T4) beats the reshape's tombstone (T3): tX survives; tY too.
    expect(t.tasks.map((k) => k.id).sort()).toEqual(["tX", "tY"]);
    expect(t.deletedTasks).toEqual([]);

    // Flip the clock: toggle at T2 < reshape at T3 → tX stays dead.
    const toggledEarlier = makeWire({
      guid: "g1",
      updatedAt: T(2),
      tasks: [task("tX", "old task", true, T(2))],
    });
    const t2 = mergeStates(state([reshaped]), state([toggledEarlier])).tickets.get("g1")!;
    expect(t2.tasks.map((k) => k.id)).toEqual(["tY"]);
    expect(t2.deletedTasks).toEqual([{ id: "tX", deletedAt: T(3) }]);
  });
});

// ----- merge: attachments / links / pendingClose ----------------------------

describe("mergeStates: attachments, links, pendingClose", () => {
  test("attachment tombstone always beats its own addedAt", () => {
    const att = { id: "a1", name: "x.png", mimeType: "image/png", sizeBytes: 1, addedAt: T(1) };
    const holder = makeWire({ guid: "g1", updatedAt: T(2), attachments: [att] });
    const deleter = makeWire({
      guid: "g1",
      updatedAt: T(3),
      attachments: [],
      deletedAttachments: [{ id: "a1", deletedAt: T(3) }],
    });
    const t = mergeStates(state([holder]), state([deleter])).tickets.get("g1")!;
    expect(t.attachments).toEqual([]);
    expect(t.deletedAttachments).toEqual([{ id: "a1", deletedAt: T(3) }]);
  });

  test("links come from the winner wholesale: removal sticks, loser-only add is lost", () => {
    const winner = makeWire({
      guid: "g1",
      updatedAt: T(5),
      links: [{ targetGuid: "g2", kind: "blocks" }],
    });
    const loser = makeWire({
      guid: "g1",
      updatedAt: T(4),
      links: [
        { targetGuid: "g2", kind: "blocks" },
        { targetGuid: "g3", kind: "relates-to" }, // concurrently added on the losing side
      ],
    });
    const t = mergeStates(state([winner]), state([loser])).tickets.get("g1")!;
    // Documented trade: the loser's concurrent add is lost (trivially re-added);
    // a resurrected deleted link would be silently wrong.
    expect(t.links).toEqual([{ targetGuid: "g2", kind: "blocks" }]);
  });

  test("pendingClose rides the winner: request survives when winner has it", () => {
    const withReq = makeWire({
      guid: "g1",
      updatedAt: T(5),
      pendingClose: { by: "agent", at: T(5), note: "done" },
    });
    const without = makeWire({ guid: "g1", updatedAt: T(4), pendingClose: null });
    const t = mergeStates(state([withReq]), state([without])).tickets.get("g1")!;
    expect(t.pendingClose).toEqual({ by: "agent", at: T(5), note: "done" });
  });

  test("pendingClose documented drop: newer plain edit wins over a concurrent request", () => {
    const withReq = makeWire({
      guid: "g1",
      updatedAt: T(4),
      pendingClose: { by: "agent", at: T(4) },
    });
    const newerEdit = makeWire({ guid: "g1", updatedAt: T(5), pendingClose: null });
    const m1 = mergeStates(state([withReq]), state([newerEdit]));
    const m2 = mergeStates(state([newerEdit]), state([withReq]));
    expect(stateJson(m1)).toBe(stateJson(m2));
    // Accepted risk (00-overview §risks): the request drops; the tool is
    // idempotent and the agent re-requests.
    expect(m1.tickets.get("g1")!.pendingClose).toBeNull();
  });

  test("record and statusHistory union by composite key, sorted ascending", () => {
    const a = makeWire({
      guid: "g1",
      updatedAt: T(2),
      statusHistory: [{ status: "Thinking", at: T(1), by: "user" }],
      record: [{ at: T(1), author: "user", text: "created" }],
    });
    const b = makeWire({
      guid: "g1",
      updatedAt: T(3),
      statusHistory: [
        { status: "Thinking", at: T(1), by: "user" }, // duplicate
        { status: "Planned", at: T(2), by: "agent" },
      ],
      record: [
        { at: T(1), author: "user", text: "created" }, // duplicate
        { at: T(2), author: "agent", text: "picked up" },
      ],
    });
    const t = mergeStates(state([a]), state([b])).tickets.get("g1")!;
    expect(t.statusHistory).toEqual([
      { status: "Thinking", at: T(1), by: "user" },
      { status: "Planned", at: T(2), by: "agent" },
    ]);
    expect(t.record).toEqual([
      { at: T(1), author: "user", text: "created" },
      { at: T(2), author: "agent", text: "picked up" },
    ]);
  });

  test("lane-overflow passthrough: the module never mutates statuses", () => {
    const tickets = Array.from({ length: 8 }, (_, i) =>
      makeWire({ guid: `g${i}`, number: i + 1, id: `DS-00${i + 1}`, status: "Working" }),
    );
    const m = mergeStates(state(tickets.slice(0, 4)), state(tickets.slice(4)));
    expect([...m.tickets.values()].every((t) => t.status === "Working")).toBe(true);
    expect(m.tickets.size).toBe(8);
  });
});

// ----- semilattice properties ------------------------------------------------

describe("mergeStates: semilattice properties", () => {
  function richPair(): [SyncState, SyncState] {
    const a = state(
      [
        makeWire({
          guid: "g1",
          updatedAt: T(3),
          tasks: [{ id: "t1", text: "one", done: false, updatedAt: T(3) }],
          deletedTasks: [{ id: "t9", deletedAt: T(2) }],
          pendingClose: { by: "agent", at: T(3) },
        }),
        makeWire({ guid: "g2", number: 50, id: "DS-050", updatedAt: T(1) }),
      ],
      [{ guid: "g3", deletedAt: T(2), lastId: "DS-003" }],
    );
    const b = state(
      [
        makeWire({
          guid: "g1",
          updatedAt: T(4),
          tasks: [{ id: "t9", text: "nine", done: true, updatedAt: T(4) }],
          tags: ["fresh"],
        }),
        makeWire({ guid: "g4", number: 51, id: "DS-051", updatedAt: T(2) }),
      ],
      [{ guid: "g2", deletedAt: T(5), lastId: "DS-050" }],
    );
    return [a, b];
  }

  test("commutativity: merge(a,b) ≡ merge(b,a)", () => {
    const [a, b] = richPair();
    expect(stateJson(mergeStates(a, b))).toBe(stateJson(mergeStates(b, a)));
  });

  test("idempotence: merge(m, a) ≡ m and merge(m, m) ≡ m", () => {
    const [a, b] = richPair();
    const m = mergeStates(a, b);
    expect(stateJson(mergeStates(m, a))).toBe(stateJson(m));
    expect(stateJson(mergeStates(m, m))).toBe(stateJson(m));
  });

  test("associativity spot-check: (a⋈b)⋈c ≡ a⋈(b⋈c)", () => {
    const [a, b] = richPair();
    const c = state(
      [makeWire({ guid: "g1", updatedAt: T(5), title: "freshest" })],
      [{ guid: "g4", deletedAt: T(1), lastId: "DS-051" }],
    );
    expect(stateJson(mergeStates(mergeStates(a, b), c))).toBe(
      stateJson(mergeStates(a, mergeStates(b, c))),
    );
  });
});

// ----- GC --------------------------------------------------------------------

describe("mergeStates: deterministic tombstone GC", () => {
  test("tombstone older than maxTs − TTL pruned identically for both orders", () => {
    const newest = "2026-01-01T00:00:00.000Z";
    const ancient = new Date(Date.parse(newest) - TOMBSTONE_TTL_MS - 1000).toISOString();
    const fresh = new Date(Date.parse(newest) - 1000).toISOString();
    const a = state(
      [makeWire({ guid: "g1", updatedAt: newest, deletedTasks: [{ id: "tOld", deletedAt: ancient }] })],
      [{ guid: "gOld", deletedAt: ancient, lastId: "DS-009" }],
    );
    const b = state([], [{ guid: "gFresh", deletedAt: fresh, lastId: "DS-010" }]);
    const m1 = mergeStates(a, b);
    const m2 = mergeStates(b, a);
    expect(stateJson(m1)).toBe(stateJson(m2));
    expect(m1.tombstones.has("gOld")).toBe(false);
    expect(m1.tombstones.has("gFresh")).toBe(true);
    expect(m1.tickets.get("g1")!.deletedTasks).toEqual([]);
  });
});

// ----- renumber --------------------------------------------------------------

describe("renumber", () => {
  test("oldest createdAt keeps the number; losers sequential past max; deterministic", () => {
    const keeper = makeWire({ guid: "aaa", number: 1, id: "DS-001", createdAt: T(1) });
    const loser1 = makeWire({ guid: "bbb", number: 1, id: "DS-001", createdAt: T(2) });
    const other = makeWire({ guid: "ccc", number: 7, id: "DS-007", createdAt: T(1) });
    const { state: out, renames } = renumber(state([keeper, loser1, other]));
    expect(out.tickets.get("aaa")!.number).toBe(1);
    expect(out.tickets.get("bbb")!.number).toBe(8); // past max(7)
    expect(out.tickets.get("bbb")!.id).toBe("DS-008");
    expect(renames).toEqual([{ guid: "bbb", oldId: "DS-001", newId: "DS-008" }]);
    // No collisions → no renames.
    expect(renumber(out).renames).toEqual([]);
  });

  test("createdAt tie broken by lexicographically smaller guid", () => {
    const x = makeWire({ guid: "aaa", number: 3, id: "DS-003", createdAt: T(1) });
    const y = makeWire({ guid: "zzz", number: 3, id: "DS-003", createdAt: T(1) });
    const { state: out } = renumber(state([x, y]));
    expect(out.tickets.get("aaa")!.number).toBe(3);
    expect(out.tickets.get("zzz")!.number).toBe(4);
  });

  test("link integrity: targetGuid re-projection survives renumbering", () => {
    const target = makeWire({ guid: "g-target", number: 1, id: "DS-001", createdAt: T(2) });
    const keeper = makeWire({ guid: "g-keeper", number: 1, id: "DS-001", createdAt: T(1) });
    const source = makeWire({
      guid: "g-source",
      number: 5,
      id: "DS-005",
      links: [{ targetGuid: "g-target", kind: "blocks" }],
    });
    const { state: out } = renumber(state([target, keeper, source]));
    // Target was renumbered; guid → id map reflects the new number.
    const guidToId = new Map([...out.tickets.values()].map((t) => [t.guid, t.id]));
    const issue = fromWire(out.tickets.get("g-source")!, guidToId);
    expect(issue.links).toEqual([{ targetId: out.tickets.get("g-target")!.id, kind: "blocks" }]);
    expect(out.tickets.get("g-target")!.id).toBe("DS-006"); // past max(5)
  });
});

// ----- converters ------------------------------------------------------------

describe("toWire / fromWire", () => {
  const baseIssue: Issue = {
    id: "DS-001",
    number: 1,
    title: "round trip",
    type: "Bug",
    priority: "High",
    status: "Working",
    description: "d",
    verifyCriteria: "v",
    createdAt: T(1),
    resolvedAt: null,
    tasks: [
      { id: "t1", text: "stamped", done: false, updatedAt: T(2) },
      { id: "t2", text: "legacy", done: true }, // no stamp
    ],
    tags: ["x"],
    attachments: [],
    links: [
      { targetId: "DS-002", kind: "blocks" },
      { targetId: "DS-404", kind: "relates-to" }, // unknown target
    ],
    statusHistory: [],
    record: [],
    pendingClose: { by: "agent", at: T(3) },
    guid: "g1",
    updatedAt: T(3),
  };

  test("toWire projects links to guids (dropping unknowns) and defaults legacy task stamps", () => {
    const wire = toWire(baseIssue, new Map([["DS-002", "g2"]]), {
      tasks: [{ id: "tDead", deletedAt: T(2) }],
      attachments: [],
    });
    expect(wire.links).toEqual([{ targetGuid: "g2", kind: "blocks" }]);
    expect(wire.tasks[1]).toEqual({ id: "t2", text: "legacy", done: true, updatedAt: T(1) });
    expect(wire.deletedTasks).toEqual([{ id: "tDead", deletedAt: T(2) }]);
    expect(wire.pendingClose).toEqual({ by: "agent", at: T(3) });
  });

  test("fromWire re-projects guids to ids, dropping tombstoned/unknown targets", () => {
    const wire = toWire(baseIssue, new Map([["DS-002", "g2"]]));
    const issue = fromWire(wire, new Map([["g2", "DS-017"]])); // renumbered target
    expect(issue.links).toEqual([{ targetId: "DS-017", kind: "blocks" }]);
    expect(issue.guid).toBe("g1");
    expect(issue.updatedAt).toBe(T(3));
    expect(issue.pendingClose).toEqual({ by: "agent", at: T(3) });
    // Unknown guid → link dropped.
    const scrubbed = fromWire(wire, new Map());
    expect(scrubbed.links).toEqual([]);
  });
});

// ----- coerceWireTicket ------------------------------------------------------

describe("coerceWireTicket", () => {
  test("garbage in → null; never throws", () => {
    for (const junk of [null, undefined, 42, "str", [], {}, { guid: "" }, { guid: "g", id: "x" }]) {
      expect(() => coerceWireTicket(junk)).not.toThrow();
      expect(coerceWireTicket(junk)).toBeNull();
    }
  });

  test("partial garbage → coerced defaults (enums, stamps, pendingClose, tombstones)", () => {
    const out = coerceWireTicket({
      guid: "g1",
      id: "DS-001",
      title: "t",
      createdAt: T(1),
      type: "NotAType",
      priority: "NotAPriority",
      status: "NotAStatus",
      updatedAt: "garbage",
      tasks: [
        { id: "t1", text: "ok", done: "yes", updatedAt: "bad" },
        { id: 42, text: "dropped" },
      ],
      links: [
        { targetGuid: "g2", kind: "blocks" },
        { targetGuid: "", kind: "blocks" },
        { targetGuid: "g3", kind: "not-a-kind" },
      ],
      pendingClose: { by: "user", at: "bad" },
      deletedTasks: [
        { id: "tD", deletedAt: T(2) },
        { id: "", deletedAt: T(2) },
        { id: "tE", deletedAt: "bad" },
      ],
      record: "not-an-array",
    });
    expect(out).not.toBeNull();
    expect(out!.type).toBe("Chore");
    expect(out!.priority).toBe("Regular");
    expect(out!.status).toBe("Thinking");
    expect(out!.updatedAt).toBe(T(1)); // falls back to createdAt
    expect(out!.tasks).toEqual([{ id: "t1", text: "ok", done: false, updatedAt: T(1) }]);
    expect(out!.links).toEqual([{ targetGuid: "g2", kind: "blocks" }]);
    expect(out!.pendingClose).toBeNull();
    expect(out!.deletedTasks).toEqual([{ id: "tD", deletedAt: T(2) }]);
    expect(out!.record).toEqual([]);
  });

  test("accepts terminal statuses — remote humans may legitimately Complete/Close", () => {
    const out = coerceWireTicket({
      guid: "g1",
      id: "DS-001",
      title: "done",
      createdAt: T(1),
      status: "Complete",
    });
    expect(out!.status).toBe("Complete");
  });
});

// ----- deriveGuid (module-local duplicate of the storage-side proof) ---------

describe("deriveGuid", () => {
  test("stable and uuid-shaped", () => {
    const g = deriveGuid("DS-001", T(1));
    expect(deriveGuid("DS-001", T(1))).toBe(g);
    expect(g).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
