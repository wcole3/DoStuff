// Tests for pure helpers in src/types.ts.

import { describe, expect, test } from "bun:test";
import {
  INVERSE_LINK_KIND,
  LINK_KINDS,
  coerceAttachments,
  coerceLinks,
  coercePendingClose,
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

  test("ignores extra keys", () => {
    expect(coercePendingClose({ by: "agent", at: ISO, extra: "x" })).toEqual({ by: "agent", at: ISO });
  });
});
