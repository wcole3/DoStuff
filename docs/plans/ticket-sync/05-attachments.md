# Ticket Sync — Plan 05: Attachments in the Ref Tree (Phase 5)

> Series: [00-overview](00-overview.md) · [01-schema-groundwork](01-schema-groundwork.md) · [02-merge-spec](02-merge-spec.md) · [03-git-plumbing](03-git-plumbing.md) · [04-controller-wiring](04-controller-wiring.md) · **05** · [06-testing-and-docs](06-testing-and-docs.md)

Phase 5 syncs attachment **bytes** through the same ref. Attachment *metadata* already syncs in phase 2/4 (it lives on the ticket); this phase makes the binary payloads follow. Optional enhancement — the system is fully functional without it (missing bytes show the existing "attachment file is missing" UX, `src/extension.ts:462`).

## 1. Layout

```
attachments/<ticketGuid>/<attachmentId>      raw bytes, no extension
```

- Keyed by **guid**, not `DS-NNN` — immune to renumbering.
- No extension in the blob path: display name, mime type, and extension live in the ticket's attachment metadata. On restore, the extension is derived from the metadata name (matches `store.writeAttachment`'s signature expectations).

## 2. Serialization (outbound, inside `commitLocal`)

For each ticket, for each attachment in metadata:

1. Skip entirely if `dostuff.sync.syncAttachments` is false.
2. Skip bytes if `sizeBytes > dostuff.sync.maxAttachmentSyncBytes` (default 5 MiB) — metadata still syncs; the other side shows missing-file UX. Log the skip (no silent caps).
3. **OID reuse**: if the previous tip's tree already has `attachments/<guid>/<attId>`, reuse that blob OID without reading the file — attachments are immutable per id (append/delete only), so a present path never needs rehashing. This keeps `commitLocal` O(changed bytes), not O(total attachment bytes).
4. Otherwise read bytes from disk (`store.readAttachment` / the attachment dir under `<storagePath>/attachments/<issueId>/`) and `hash-object -w --stdin`.
5. Local file missing (user deleted it manually): log and skip — never fail the commit.

## 3. Restore (inbound, inside apply)

Order matters — after the renumber dir-renames from [04-controller-wiring §2](04-controller-wiring.md), before firing notifications:

For each merged ticket's attachment metadata:

1. If the local file exists (`store.findAttachmentUri` non-null) → nothing to do.
2. Else if the merged tree has `attachments/<guid>/<attId>` → stream `git cat-file blob <oid>` stdout directly to the destination file (`catBlobToFile`, avoids `maxBuffer`), writing via the attachment-dir convention `<storagePath>/attachments/<issueId>/<attId><ext>`.
3. Else → leave missing; existing missing-file UX covers it.

Deletion side: when a tombstoned ticket is removed, `applySync` deletes its attachment dir (see [01-schema-groundwork §8](01-schema-groundwork.md)); the blobs age out of the ref tree at the next `commitLocal` because the ticket entry is gone (git objects persist in history — acceptable, same story as any committed-then-deleted file).

## 4. Tests (extend `src/gitSync.test.ts`)

- Small attachment added in clone A → bytes present in clone B after sync; content identical.
- Attachment above the size cap → metadata syncs, bytes don't; log entry records the skip; B shows metadata with missing file.
- OID reuse: second commit after an unrelated ticket edit does not re-read the attachment file (spy/instrument the read path, or assert timing-free via a hash-object call counter on a mocked GitRepo).
- Renumbered ticket with attachments: dir renamed first, then restore fills only genuinely-missing files — no duplicate dirs under the old id.
- `syncAttachments: false` → tree contains no `attachments/` entries.
