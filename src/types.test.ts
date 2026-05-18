// Tests for pure helpers in src/types.ts.

import { describe, expect, test } from "bun:test";
import { coerceAttachments, type Attachment } from "./types";

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
