import { EventEmitter } from "node:events";

export type ChangeKind =
  | "space.created"
  | "ticket.created"
  | "ticket.updated"
  | "ticket.moved"
  | "ticket.deleted"
  | "pr.linked"
  | "pr.unlinked"
  | "pr.state_changed"
  | "space.updated"
  | "session.started"
  | "session.ended"
  | "bead.changed"
  | "dolt.push.status";

export interface ChangeEvent {
  kind: ChangeKind;
  /** space id affected, when known — clients use this to narrow invalidation */
  space_id?: string;
  /** ticket id affected, when relevant */
  ticket_id?: string;
  /** bead id affected, when relevant */
  bead_id?: string;
  /** kind-specific payload */
  payload?: Record<string, unknown>;
}

const bus = new EventEmitter();
bus.setMaxListeners(1000);

export function emitChange(e: ChangeEvent): void {
  bus.emit("change", e);
}

export function onChange(fn: (e: ChangeEvent) => void): () => void {
  bus.on("change", fn);
  return () => bus.off("change", fn);
}
