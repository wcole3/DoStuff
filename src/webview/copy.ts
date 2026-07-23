// Shared user-facing strings for the webview components — copy that appears
// in more than one component lives here so the wording can't drift.

import { effectiveCloseTarget, type PendingClose } from "../types";

/**
 * Tooltip for the pending-request clock chip (board card + sidebar row).
 * IssueDetail deliberately uses its own longer banner wording.
 */
export function pendingCloseTitle(pc: PendingClose): string {
  return effectiveCloseTarget(pc) === "Complete"
    ? "An agent reports this ticket's work as finished (awaiting acceptance)"
    : "An agent requested to close this ticket (no longer needed)";
}
