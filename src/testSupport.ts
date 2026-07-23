// Shared test fixtures. Not shipped: imported only by *.test.* files.
//
// `makeIssueFactory` is the one home for the full Issue field list — a schema
// addition is one edit here instead of a lockstep edit across every suite's
// private copy (the tax that motivated this module: adding guid/updatedAt/
// pendingClose meant touching seven near-identical factories).

import { formatIssueId } from "./syncMerge";
import type { Issue, IssueType, Priority, Status } from "./types";

/**
 * Returns a fresh counter-backed `makeIssue`. Each suite creates its own so
 * default numbers/timestamps start from 1 per file regardless of how many
 * suites share the process. Defaults mirror the historical per-file factories
 * exactly: counter-derived number/id/createdAt, a seeded statusHistory entry,
 * and `guid-<id>` sync identity.
 *
 * (gitSync.test.ts keeps its own fixture on purpose — fixed deterministic
 * timestamps, required guid, no history seed.)
 */
export interface IssueFactory {
  (overrides?: Partial<Issue>): Issue;
  /** Restart default numbering — suites that assert counter-derived ids call this in beforeEach. */
  reset(): void;
}

export function makeIssueFactory(): IssueFactory {
  let counter = 0;
  const makeIssue = function makeIssue(overrides: Partial<Issue> = {}): Issue {
    counter += 1;
    const number = overrides.number ?? counter;
    const id = overrides.id ?? formatIssueId(number);
    const at = overrides.createdAt ?? new Date(2025, 0, 1, 0, 0, number).toISOString();
    return {
      id,
      number,
      title: overrides.title ?? `Issue ${number}`,
      type: overrides.type ?? ("Feature" as IssueType),
      priority: overrides.priority ?? ("Regular" as Priority),
      status: overrides.status ?? ("Planned" as Status),
      description: overrides.description ?? "",
      tasks: overrides.tasks ?? [],
      tags: overrides.tags ?? [],
      verifyCriteria: overrides.verifyCriteria ?? "",
      createdAt: at,
      resolvedAt: overrides.resolvedAt ?? null,
      statusHistory:
        overrides.statusHistory ?? [{ status: overrides.status ?? "Planned", at, by: "user" }],
      record: overrides.record ?? [],
      attachments: overrides.attachments ?? [],
      links: overrides.links ?? [],
      pendingClose: overrides.pendingClose ?? null,
      guid: overrides.guid ?? `guid-${id}`,
      updatedAt: overrides.updatedAt ?? at,
      commits: overrides.commits ?? [],
    };
  } as IssueFactory;
  makeIssue.reset = () => {
    counter = 0;
  };
  return makeIssue;
}
