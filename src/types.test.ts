// Tests for pure helpers in src/types.ts.

import { describe, expect, test } from "bun:test";
import {
  toRow,
  INVERSE_LINK_KIND,
  LINK_KINDS,
  coerceAttachments,
  coerceCommits,
  coerceLinks,
  coercePendingClose,
  compareCommits,
  isLinkKind,
  type Attachment,
} from "./types";

function valid(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att1",
    name: "hero.png",
    mimeType: "image/png",
    sizeBytes: 1234,
    addedAt: "2026-05-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("coerceAttachments", () => {
  test("accepts well-formed entries unchanged", () => {
    const input = [valid(), valid({ id: "att2", name: "spec.pdf", mimeType: "application/pdf" })];
    expect(coerceAttachments(input)).toEqual(input);
  });

  test("returns [] for non-array input", () => {
    expect(coerceAttachments(undefined)).toEqual([]);
    expect(coerceAttachments(null)).toEqual([]);
    expect(coerceAttachments("not an array")).toEqual([]);
    expect(coerceAttachments({ id: "att1" })).toEqual([]);
  });

  test("drops entries missing required fields", () => {
    const input = [
      valid(),
      { id: "att2", name: "missing-mime.png" }, // no mimeType/sizeBytes/addedAt
      { name: "no-id.png", mimeType: "image/png", sizeBytes: 1, addedAt: "2026-05-18T00:00:00.000Z" },
      { id: "att3", name: "neg.png", mimeType: "image/png", sizeBytes: -5, addedAt: "2026-05-18T00:00:00.000Z" },
      { id: "att4", name: "bad-date.png", mimeType: "image/png", sizeBytes: 1, addedAt: "yesterday" },
      { id: "", name: "empty-id.png", mimeType: "image/png", sizeBytes: 1, addedAt: "2026-05-18T00:00:00.000Z" },
    ];
    const out = coerceAttachments(input);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("att1");
  });

  test("drops entries with non-string id or name", () => {
    const input = [
      valid(),
      { id: 42, name: "n.png", mimeType: "image/png", sizeBytes: 1, addedAt: "2026-05-18T00:00:00.000Z" },
      { id: "att2", name: 99, mimeType: "image/png", sizeBytes: 1, addedAt: "2026-05-18T00:00:00.000Z" },
    ];
    const out = coerceAttachments(input);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("att1");
  });

  test("deduplicates by id, last write wins", () => {
    const out = coerceAttachments([
      valid({ id: "dup", name: "first.png" }),
      valid({ id: "other", name: "other.png" }),
      valid({ id: "dup", name: "second.png" }),
    ]);
    expect(out).toHaveLength(2);
    const dup = out.find((a) => a.id === "dup");
    expect(dup?.name).toBe("second.png");
  });

  test("sizeBytes = 0 is allowed", () => {
    const out = coerceAttachments([valid({ sizeBytes: 0 })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.sizeBytes).toBe(0);
  });

  test("ignores nulls and primitives mixed in", () => {
    const out = coerceAttachments([valid(), null, "string", 42, true]);
    expect(out).toHaveLength(1);
  });
});

describe("coerceLinks", () => {
  test("returns [] for non-array input", () => {
    expect(coerceLinks(undefined)).toEqual([]);
    expect(coerceLinks(null)).toEqual([]);
    expect(coerceLinks("nope")).toEqual([]);
    expect(coerceLinks(42)).toEqual([]);
    expect(coerceLinks({ targetId: "DS-001", kind: "blocks" })).toEqual([]);
  });

  test("happy path: well-formed entries pass through verbatim", () => {
    expect(
      coerceLinks([
        { targetId: "DS-001", kind: "blocks" },
        { targetId: "DS-042", kind: "relates-to" },
      ]),
    ).toEqual([
      { targetId: "DS-001", kind: "blocks" },
      { targetId: "DS-042", kind: "relates-to" },
    ]);
  });

  test("uppercases lower-cased target ids so equality is stable", () => {
    expect(coerceLinks([{ targetId: "ds-007", kind: "blocks" }])).toEqual([
      { targetId: "DS-007", kind: "blocks" },
    ]);
  });

  test("drops entries with malformed target ids", () => {
    expect(
      coerceLinks([
        { targetId: "not-a-ticket", kind: "blocks" },
        { targetId: "", kind: "blocks" },
        { targetId: "DS-", kind: "blocks" },
        { targetId: "DS-001", kind: "blocks" },
      ]),
    ).toEqual([{ targetId: "DS-001", kind: "blocks" }]);
  });

  test("drops entries with unknown kinds", () => {
    expect(
      coerceLinks([
        { targetId: "DS-001", kind: "blocks" },
        { targetId: "DS-002", kind: "duplicates" },
        { targetId: "DS-003", kind: "" },
        { targetId: "DS-004", kind: 7 },
      ]),
    ).toEqual([{ targetId: "DS-001", kind: "blocks" }]);
  });

  test("dedupes by (targetId, kind) pair, keeping first occurrence", () => {
    const out = coerceLinks([
      { targetId: "DS-001", kind: "blocks" },
      { targetId: "DS-001", kind: "blocks" },
      { targetId: "DS-001", kind: "relates-to" },
      { targetId: "DS-002", kind: "blocks" },
    ]);
    expect(out).toEqual([
      { targetId: "DS-001", kind: "blocks" },
      { targetId: "DS-001", kind: "relates-to" },
      { targetId: "DS-002", kind: "blocks" },
    ]);
  });

  test("drops self-links when currentIssueId supplied", () => {
    expect(
      coerceLinks(
        [
          { targetId: "DS-001", kind: "blocks" },
          { targetId: "DS-002", kind: "blocks" },
        ],
        "DS-001",
      ),
    ).toEqual([{ targetId: "DS-002", kind: "blocks" }]);
  });

  test("drops self-links even when current id arrives lower-cased on the entry", () => {
    expect(
      coerceLinks(
        [
          { targetId: "ds-001", kind: "blocks" },
          { targetId: "DS-002", kind: "blocks" },
        ],
        "DS-001",
      ),
    ).toEqual([{ targetId: "DS-002", kind: "blocks" }]);
  });

  test("drops malformed entry shapes", () => {
    expect(
      coerceLinks([
        null,
        undefined,
        "not-an-object",
        { kind: "blocks" },
        { targetId: "DS-001" },
        { targetId: "DS-002", kind: "blocks" },
      ]),
    ).toEqual([{ targetId: "DS-002", kind: "blocks" }]);
  });
});

describe("INVERSE_LINK_KIND", () => {
  test("covers every LinkKind in LINK_KINDS", () => {
    for (const kind of LINK_KINDS) {
      expect(INVERSE_LINK_KIND[kind]).toBeDefined();
    }
  });
  test("relates-to is symmetric", () => {
    expect(INVERSE_LINK_KIND["relates-to"]).toBe("relates-to");
  });
  test("blocks inverts to blocked-by", () => {
    expect(INVERSE_LINK_KIND["blocks"]).toBe("blocked-by");
  });
  test("child-of inverts to parent-of", () => {
    expect(INVERSE_LINK_KIND["child-of"]).toBe("parent-of");
  });
});

describe("isLinkKind", () => {
  test("accepts every kind in LINK_KINDS", () => {
    for (const k of LINK_KINDS) expect(isLinkKind(k)).toBe(true);
  });
  test("rejects unknown strings and non-strings", () => {
    expect(isLinkKind("duplicates")).toBe(false);
    expect(isLinkKind("")).toBe(false);
    expect(isLinkKind(undefined)).toBe(false);
    expect(isLinkKind(null)).toBe(false);
    expect(isLinkKind(42)).toBe(false);
  });
});

describe("coercePendingClose", () => {
  const ISO = "2026-05-18T00:00:00.000Z";

  test("accepts a well-formed request with a note", () => {
    expect(coercePendingClose({ by: "agent", at: ISO, note: "ship it" })).toEqual({
      by: "agent",
      at: ISO,
      note: "ship it",
    });
  });

  test("accepts a request without a note (note omitted, not null)", () => {
    const out = coercePendingClose({ by: "agent", at: ISO });
    expect(out).toEqual({ by: "agent", at: ISO });
    expect(out && "note" in out).toBe(false);
  });

  test("returns null for null / undefined / non-object input", () => {
    expect(coercePendingClose(null)).toBeNull();
    expect(coercePendingClose(undefined)).toBeNull();
    expect(coercePendingClose("nope")).toBeNull();
    expect(coercePendingClose(42)).toBeNull();
  });

  test('returns null when `by` is not "agent"', () => {
    expect(coercePendingClose({ by: "user", at: ISO })).toBeNull();
  });

  test("returns null when `at` is missing or not ISO 8601", () => {
    expect(coercePendingClose({ by: "agent" })).toBeNull();
    expect(coercePendingClose({ by: "agent", at: "yesterday" })).toBeNull();
    expect(coercePendingClose({ by: "agent", at: 123 })).toBeNull();
  });

  test("drops a non-string note but keeps the request", () => {
    expect(coercePendingClose({ by: "agent", at: ISO, note: 5 })).toEqual({ by: "agent", at: ISO });
  });

  test("keeps a valid target (both flavors)", () => {
    expect(coercePendingClose({ by: "agent", at: ISO, target: "Closed" })).toEqual({
      by: "agent",
      at: ISO,
      target: "Closed",
    });
    expect(coercePendingClose({ by: "agent", at: ISO, target: "Complete" })).toEqual({
      by: "agent",
      at: ISO,
      target: "Complete",
    });
  });

  test("drops an invalid target but keeps the request (degrades to legacy Closed meaning)", () => {
    const out = coercePendingClose({ by: "agent", at: ISO, target: "Banana" });
    expect(out).toEqual({ by: "agent", at: ISO });
    expect(out && "target" in out).toBe(false);
  });

  test("ignores extra keys", () => {
    expect(coercePendingClose({ by: "agent", at: ISO, extra: "x" })).toEqual({ by: "agent", at: ISO });
  });
});

describe("coerceCommits", () => {
  const AT = "2026-07-01T00:00:00.000Z";
  const AT2 = "2026-07-02T00:00:00.000Z";
  const SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";

  test("accepts well-formed entries", () => {
    expect(coerceCommits([{ sha: SHA, at: AT }])).toEqual([{ sha: SHA, at: AT }]);
    expect(coerceCommits([{ sha: "a1b2c3d", at: AT }])).toEqual([{ sha: "a1b2c3d", at: AT }]);
  });

  test("returns [] for non-array input", () => {
    expect(coerceCommits(undefined)).toEqual([]);
    expect(coerceCommits(null)).toEqual([]);
    expect(coerceCommits("deadbeef")).toEqual([]);
    expect(coerceCommits({ sha: SHA, at: AT })).toEqual([]);
  });

  test("drops malformed shas: too short, too long, non-hex, option-shaped", () => {
    expect(
      coerceCommits([
        { sha: "abc123", at: AT }, // 6 chars
        { sha: SHA + "0", at: AT }, // 41 chars
        { sha: "zzzzzzz", at: AT }, // non-hex
        { sha: "--format", at: AT }, // option injection shape
        { sha: 42, at: AT },
        null,
        "deadbeef",
      ]),
    ).toEqual([]);
  });

  test("drops entries with missing or non-ISO at", () => {
    expect(
      coerceCommits([
        { sha: SHA },
        { sha: SHA, at: "yesterday" },
        { sha: SHA, at: 12345 },
      ]),
    ).toEqual([]);
  });

  test("lowercases uppercase shas", () => {
    expect(coerceCommits([{ sha: SHA.toUpperCase(), at: AT }])).toEqual([{ sha: SHA, at: AT }]);
  });

  test("dedupes by sha keeping the earliest at, regardless of input order", () => {
    const expected = [{ sha: SHA, at: AT }];
    expect(coerceCommits([{ sha: SHA, at: AT }, { sha: SHA, at: AT2 }])).toEqual(expected);
    expect(coerceCommits([{ sha: SHA, at: AT2 }, { sha: SHA, at: AT }])).toEqual(expected);
    // Mixed-case duplicates collapse too.
    expect(coerceCommits([{ sha: SHA.toUpperCase(), at: AT2 }, { sha: SHA, at: AT }])).toEqual(expected);
  });

  test("sorts output by (at, sha)", () => {
    const a = { sha: "bbbbbbb", at: AT };
    const b = { sha: "aaaaaaa", at: AT2 };
    const c = { sha: "aaaaaab", at: AT };
    expect(coerceCommits([b, a, c])).toEqual([c, a, b]);
  });

  test("compareCommits is a total order on (at, sha)", () => {
    const x = { sha: "aaaaaaa", at: AT };
    const y = { sha: "bbbbbbb", at: AT };
    const z = { sha: "aaaaaaa", at: AT2 };
    expect(compareCommits(x, y)).toBeLessThan(0);
    expect(compareCommits(y, x)).toBeGreaterThan(0);
    expect(compareCommits(x, z)).toBeLessThan(0);
    expect(compareCommits(x, { ...x })).toBe(0);
  });
});

describe("toRow", () => {
  test("drops exactly record/statusHistory/commits and adds nothing (an omitted key must stay undefined)", () => {
    const issue = {
      id: "DS-001", number: 1, title: "t", type: "Bug", priority: "Regular", status: "Thinking",
      description: "d", tasks: [], verifyCriteria: "", createdAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: null, statusHistory: [{ status: "Thinking", at: "2026-01-01T00:00:00.000Z" }],
      record: [{ at: "2026-01-01T00:00:00.000Z", author: "user", text: "x" }], tags: [], attachments: [],
      links: [], pendingClose: null, guid: "g", updatedAt: "2026-01-01T00:00:00.000Z",
      commits: [{ sha: "a".repeat(40), at: "2026-01-01T00:00:00.000Z" }],
    } as const;
    const row = toRow(issue as unknown as Parameters<typeof toRow>[0]);
    const expected = Object.keys(issue).filter((k) => !["record", "statusHistory", "commits"].includes(k));
    expect(Object.keys(row).sort()).toEqual(expected.sort());
    expect("record" in row).toBe(false);
    expect("statusHistory" in row).toBe(false);
    expect("commits" in row).toBe(false);
  });
});
