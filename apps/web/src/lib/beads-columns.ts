import type { BeadStatus } from "@kanco/shared";

export const BOARD_STATUSES: BeadStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "closed",
];

export const STATUS_LABEL: Record<BeadStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  blocked: "Blocked",
  deferred: "Deferred",
  closed: "Closed",
  pinned: "Pinned",
  hooked: "Hooked",
};

export const STATUS_COLOR: Record<BeadStatus, string> = {
  open: "#3b82f6",
  in_progress: "#f59e0b",
  blocked: "#ef4444",
  deferred: "#6b7280",
  closed: "#10b981",
  pinned: "#8b5cf6",
  hooked: "#ec4899",
};
