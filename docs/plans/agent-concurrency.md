# Agent concurrency: what shipped, what is deferred

Status: options 1-3 shipped in 2.1.0; options 4-5 are proposals, not commitments.

## Problem

Parallel agents drive the ticket queue through the skill (`skills/dostuff-tickets/scripts/dostuff.sh`), i.e. bare `curl` against the loopback MCP server that runs *inside the extension host's single thread*. Bursts of writes used to fail intermittently with a misleading "Cannot reach DoStuff" while the host was merely stalled (the `hash-object` spawn flood, fixed in 2.1.0) or its write queue was deep.

## Shipped in 2.1.0

| # | Change | Where |
|---|--------|-------|
| 1 | Script retries timeouts / empty replies / 503 / 429 with 1s, 2s backoff, bounded by `DOSTUFF_RETRIES` (default 3); per-attempt budget `DOSTUFF_TIMEOUT` (default 15s); exit-code-specific error messages | `dostuff.sh` `post()` / `transport_die()` |
| 2 | `Idempotency-Key` header: the server caches a mutating tool's result per `(tool, key)` for 10 minutes (500 entries) and replays it on a repeat, joining an in-flight call if still running; rejections are not cached. The script sends one key per logical call across all its attempts | `mcpServer.ts` `WriteQueue.run(task, key)` |
| 3 | Backpressure: a mutating `tools/call` arriving while `MAX_PENDING_WRITES` (32) writes are queued gets `503` + `Retry-After: 1` before the transport runs. Reads never refused. The HTTP layer now parses the body itself (streamed, 1 MB cap) and passes it to the transport | `mcpServer.ts` `handleHttpRequest`, `isMutatingRpc`, `writeQueueDepth` |

Tests: `mcpServer.test.ts` "concurrency: Idempotency-Key and write backpressure"; `agentSkill.test.ts` "transport failure messages" and "retries with a stable Idempotency-Key".

## Deferred: option 4, bulk write tools

**Idea.** `create_tickets` (array of `create_ticket` inputs) and `update_tickets_status` (array of `{id, status}`), each executed as one queued write with one persist and one sync commit.

**Why it might be worth it.** For "file 40 tickets" an agent today makes 40 round trips, 40 queue entries, up to 40 persists (throttled to ~250ms windows) and 40 webview deltas. A batch makes that 1 / 1 / 1 / 1 and cuts the chance of hitting `MAX_PENDING_WRITES` at all.

**Why it is deferred.**
- Every per-ticket rule in CLAUDE.md "Agent write boundaries" must hold *inside* the batch: new tickets land in `Thinking`; lane caps apply to the batch as a whole (a batch of 7 promotions into a lane with room for 3 must be partially rejected or wholly rejected, and the choice must be documented and tested); terminal states stay untouchable.
- Partial failure semantics need a decision: all-or-nothing (simplest to reason about, wasteful for agents) vs per-item results (what agents want, but the response must name each failure and the `record` audit trail must still be per ticket).
- The skill (`SKILL.md`, `references/tools.md`, the cap table in `scripts/dostuff.sh`) and the drift guard `agentSkill.test.ts` must follow; the tool description must stay under 2 KB.
- Payload caps: a 40-ticket batch with 10 KB descriptions is 400 KB; `FIELD_LIMITS` needs a batch-size cap (suggest 25) and the 1 MB HTTP body cap already bounds the worst case.

**Trigger to revisit.** Benchmarks or field reports showing agents still hitting 503s or spending most of a task in round trips *after* 2.1.0, or a concrete agent workflow that files >20 tickets at once regularly.

**Sketch.** One tool per verb, not a generic batch envelope. Handler: validate every item first (pure), then run the whole array inside a single `storeWriteQueue` task, calling the existing `runCreateTicket` / `runUpdateTicketStatus` per item so the existing gates and record entries are reused verbatim; collect per-item results; respond `{ results: [{index, ok, id?, error?}], summary: {ok, failed} }`. Add `create_tickets`/`update_tickets_status` to `MUTATING_TOOLS`.

## Deferred: option 5, move the MCP server off the extension host thread

**Idea.** Serve HTTP from a `worker_thread` (or route agents to the existing headless `dist/server.cjs` process) so a stalled extension event loop cannot stall agent traffic.

**Why it is deferred.**
- The store is single-writer in memory (sql.js). A worker that owns the store means the extension host's UI path becomes a client of the worker (message-port RPC for every `list()` / `upsert()`), which inverts the current architecture and touches every provider.
- Routing agents to the headless server while the extension is open means two writers of one `dostuff.db`; the singleton gate (`serverMain.ts` `findLiveConflict`) exists precisely to forbid that. Git sync could reconcile the two, but only with sync enabled, and only at commit granularity.
- The stall that motivated this is gone: at 1000 tickets the worst event-loop stall in a sync cycle measured 179 ms (`bun test -t PERF`), far below any HTTP timeout. What remains is a 3.2 s stall at 10 000 tickets, which is a CPU problem in `commitLocalOp` (two merges, ~2N canonical serializations) and is cheaper to fix in place.

**Trigger to revisit.** A stall source that cannot be removed from the extension host (e.g. a future feature that must block for seconds), or boards well past 10 000 tickets where the per-cycle CPU cannot be brought under ~500 ms.

**Cheaper alternative to try first.** Cut the remaining O(N) CPU per sync cycle: reuse the `readState` parse across the merge and the apply step, skip the second `mergeStates` in `applyState` when the local commit was just written, and diff by `updatedAt` before `canonicalJson`. The PERF bench's `restMs` column is the number to watch.
