// Pure sync/merge helpers for git-native ticket sync.
//
// HARD CONSTRAINT: no `vscode` imports, no git, no I/O, no `Date.now()`
// outside explicit parameters. Everything in this module must be a
// deterministic function of its inputs so that two machines merging the same
// pair of states produce byte-identical results. `storage.ts` imports from
// here (this direction keeps the module vscode-free and avoids a cycle).
//
// Phase 1 ships only `deriveGuid` + `canonicalJson` + the tombstone TTL; the
// full wire model and `mergeStates` land in Phase 2
// (docs/plans/ticket-sync/02-merge-spec.md).

import { createHash } from "node:crypto";

/**
 * Deterministic guid for tickets that predate the `guid` field. uuid-v5-style
 * formatting of sha1("dostuff-guid:" + id + "|" + createdAt).
 *
 * Deterministic (rather than `randomUUID()` at load) so that:
 * 1. Pre-shared exports dedupe — tickets previously copied between clones via
 *    JSON export/import derive the *same* guid on both sides, so the first
 *    sync merges them instead of doubling the board.
 * 2. Downgrade-safe — an older build rewriting a row NULLs the `guid` column;
 *    re-derivation restores the identical identity, so no split-brain after
 *    an upgrade→downgrade→upgrade round trip.
 */
export function deriveGuid(id: string, createdAt: string): string {
  const h = createHash("sha1").update(`dostuff-guid:${id}|${createdAt}`).digest("hex");
  // Format as 8-4-4-4-12; stamp version nibble 5 and variant bits 10xx for a
  // well-formed uuid.
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    "5" + h.slice(13, 16),
    ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}

/**
 * Canonical JSON: recursively key-sorted objects, arrays in given order,
 * 2-space indent, trailing newline. Used for every blob written to the ref
 * tree — identical logical state → identical bytes → identical git OIDs,
 * which buys free no-op detection, cross-commit blob dedup, and a stable
 * input for the LWW tiebreak hash.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue; // undefined is not representable in JSON
      out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * How long ticket/element tombstones are retained, relative to the newest
 * timestamp in the merged state (never the wall clock — determinism). A
 * replica offline longer than this can resurrect a deleted ticket; accepted
 * trade (docs/plans/ticket-sync/00-overview.md §risks).
 */
export const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000;
