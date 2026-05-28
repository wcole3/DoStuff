// Read-only link display primitives: a single chip and a strip. Shared by the
// IssueDetail "Links" / "Linked by" sections. Clicking a chip posts
// `revealTicket` so the host surfaces the referenced ticket.

import type { CSSProperties } from "react";
import type { Issue, LinkKind } from "../types";
import { Icon, STATUS_META, TYPE_ICON } from "./Icons";
import { INVERSE_LINK_KIND_LABEL, LINK_KIND_LABEL, type InboundLink } from "./linkModel";
import { postRevealTicket } from "./messaging";

/** Per-kind accent color, shared with the graph edge palette. */
export const LINK_KIND_COLOR: Record<LinkKind, string> = {
  "blocks": "#f48771",
  "child-of": "#75beff",
  "relates-to": "#888888",
};

interface OutboundChipProps {
  kind: LinkKind;
  target: Issue | undefined;
  targetId: string;
  onRemove?: () => void;
}

/** A chip for an outbound link: "[kind] → #N title". */
export function OutboundLinkChip({ kind, target, targetId, onRemove }: OutboundChipProps) {
  const label = `${target ? `#${target.number}` : targetId} ${target?.title ?? ""}`.trim();
  return (
    <span
      className="ds-link-chip"
      style={{ ["--link-color" as string]: LINK_KIND_COLOR[kind] } as CSSProperties}
    >
      <span className="ds-link-kind">{LINK_KIND_LABEL[kind]}</span>
      <button
        type="button"
        className="ds-link-chip-main"
        onClick={() => postRevealTicket(targetId)}
        title={`Open ${target ? `#${target.number} — ${target.title}` : targetId}`}
      >
        {target && (
          <Icon name={TYPE_ICON[target.type]} size={11} />
        )}
        <span className="ds-link-chip-label">{label || targetId}</span>
        {target && (
          <span
            className="ds-link-status-dot"
            style={{ background: STATUS_META[target.status].color }}
            title={target.status}
          />
        )}
      </button>
      {onRemove && (
        <button
          type="button"
          className="ds-link-chip-rm"
          onClick={onRemove}
          aria-label={`Remove link to ${targetId}`}
          title="Remove link"
        >
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  );
}

interface InboundChipProps {
  link: InboundLink;
  source: Issue | undefined;
}

/** A chip for a derived inbound link ("Linked by"). Read-only — to remove it,
 *  you edit the source ticket. The kind is the already-inverted label. */
export function InboundLinkChip({ link, source }: InboundChipProps) {
  const label = `${source ? `#${source.number}` : link.sourceId} ${source?.title ?? link.sourceTitle}`.trim();
  return (
    <span className="ds-link-chip ds-link-chip-inbound">
      <span className="ds-link-kind">{INVERSE_LINK_KIND_LABEL[link.kind]}</span>
      <button
        type="button"
        className="ds-link-chip-main"
        onClick={() => postRevealTicket(link.sourceId)}
        title={`Open ${source ? `#${source.number} — ${source.title}` : link.sourceId}`}
      >
        {source && <Icon name={TYPE_ICON[source.type]} size={11} />}
        <span className="ds-link-chip-label">{label || link.sourceId}</span>
        {source && (
          <span
            className="ds-link-status-dot"
            style={{ background: STATUS_META[source.status].color }}
            title={source.status}
          />
        )}
      </button>
    </span>
  );
}
