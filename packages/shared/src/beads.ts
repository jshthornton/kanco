import { z } from "zod";

/**
 * Bead status — built-in beads statuses (1.0.3). Custom statuses can be added
 * via `bd config set status.custom`; kanco assumes built-in only for now.
 */
export const BeadStatus = z.enum([
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
  "pinned",
  "hooked",
]);
export type BeadStatus = z.infer<typeof BeadStatus>;

export const BEAD_STATUS_CATEGORY: Record<BeadStatus, "active" | "wip" | "done" | "frozen"> = {
  open: "active",
  in_progress: "wip",
  blocked: "wip",
  hooked: "wip",
  closed: "done",
  deferred: "frozen",
  pinned: "frozen",
};

/** Status order used by the board view. */
export const BEAD_STATUS_BOARD_ORDER: BeadStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "closed",
];

/** Built-in issue types. `gate` is internal; kanco surfaces it separately. */
export const BeadIssueType = z.enum([
  "task",
  "bug",
  "feature",
  "chore",
  "epic",
  "decision",
  "spike",
  "story",
  "milestone",
  "gate",
]);
export type BeadIssueType = z.infer<typeof BeadIssueType>;

export const BeadDepType = z.enum([
  "blocks",
  "tracks",
  "related",
  "parent-child",
  "discovered-from",
]);
export type BeadDepType = z.infer<typeof BeadDepType>;

export const BeadGateAwaitType = z.enum(["human", "timer", "gh:run", "gh:pr", "bead"]);
export type BeadGateAwaitType = z.infer<typeof BeadGateAwaitType>;

const Iso = z.string();

/**
 * Edge as returned inline on `bd show`. The blocked bead's `dependencies[]`
 * carries the gate or other bead it depends on. Gates carry `await_type` /
 * `await_id`.
 */
export const BeadShowEdge = z.object({
  id: z.string(),
  title: z.string(),
  status: BeadStatus,
  issue_type: BeadIssueType,
  dependency_type: BeadDepType,
  await_type: BeadGateAwaitType.optional(),
  await_id: z.string().optional(),
  description: z.string().optional(),
  priority: z.number().optional(),
  owner: z.string().nullable().optional(),
  created_at: Iso.optional(),
  updated_at: Iso.optional(),
  closed_at: Iso.optional(),
});
export type BeadShowEdge = z.infer<typeof BeadShowEdge>;

/**
 * Edge as returned by `bd list` and `bd export` — different from `bd show`!
 * Carries only ids and dep type, no title/status of target.
 */
export const BeadExportEdge = z.object({
  issue_id: z.string(),
  depends_on_id: z.string(),
  type: BeadDepType,
  metadata: z.string().optional(),
  created_at: Iso.optional(),
  created_by: z.string().nullable().optional(),
});
export type BeadExportEdge = z.infer<typeof BeadExportEdge>;

/**
 * Permissive edge — accepts either show or export form. Code reading edges
 * should prefer the helpers `edgeTargetId` / `edgeType`.
 */
export const BeadEdge = z.union([BeadShowEdge, BeadExportEdge]);
export type BeadEdge = z.infer<typeof BeadEdge>;

export function edgeTargetId(e: BeadEdge): string {
  return "depends_on_id" in e ? e.depends_on_id : e.id;
}

export function edgeType(e: BeadEdge): BeadDepType {
  return "type" in e && typeof e.type === "string"
    ? (e.type as BeadDepType)
    : (e as BeadShowEdge).dependency_type;
}

export const Bead = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: BeadStatus,
  priority: z.number().int().nonnegative().optional(),
  issue_type: BeadIssueType,
  owner: z.string().nullable().optional(),
  created_at: Iso.optional(),
  created_by: z.string().nullable().optional(),
  updated_at: Iso.optional(),
  started_at: Iso.optional(),
  closed_at: Iso.optional(),
  /** Parent issue id (set when a parent-child dep points at this bead's parent). */
  parent: z.string().optional(),
  /** Free-form label strings attached via `bd label add`. */
  labels: z.array(z.string()).optional().default([]),
  dependencies: z.array(BeadEdge).optional().default([]),
  dependents: z.array(BeadEdge).optional().default([]),
  dependency_count: z.number().int().nonnegative().optional(),
  dependent_count: z.number().int().nonnegative().optional(),
  comment_count: z.number().int().nonnegative().optional(),
  // Gate-only fields (when issue_type === "gate")
  await_type: BeadGateAwaitType.optional(),
  await_id: z.string().optional(),
});
export type Bead = z.infer<typeof Bead>;

/**
 * Summary form returned by `bd list --json`. Carries `dependencies[]` in
 * export form (issue_id/depends_on_id) plus `parent` and `labels`.
 */
export const BeadSummary = Bead.omit({ dependents: true });
export type BeadSummary = z.infer<typeof BeadSummary>;

/** Edge in the cross-bead dependency graph (graph view). */
export const BeadGraphEdge = z.object({
  from: z.string(),
  to: z.string(),
  type: BeadDepType,
});
export type BeadGraphEdge = z.infer<typeof BeadGraphEdge>;

export const BeadGraph = z.object({
  nodes: z.array(BeadSummary),
  edges: z.array(BeadGraphEdge),
});
export type BeadGraph = z.infer<typeof BeadGraph>;

// --- write inputs ---

export const CreateBeadInput = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).optional(),
  issue_type: BeadIssueType.optional().default("task"),
  priority: z.number().int().min(0).max(5).optional(),
  labels: z.array(z.string().min(1)).optional(),
  parent: z.string().optional(),
  assignee: z.string().optional(),
  design: z.string().max(20_000).optional(),
  acceptance: z.string().max(20_000).optional(),
  notes: z.string().max(20_000).optional(),
  due: z.string().optional(),
  /** When false, server creates a manual gate blocking the bead. */
  ready: z.boolean().optional().default(true),
});
export type CreateBeadInput = z.infer<typeof CreateBeadInput>;

export const UpdateBeadInput = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(20_000).nullable().optional(),
  status: BeadStatus.optional(),
  priority: z.number().int().min(0).max(5).optional(),
});
export type UpdateBeadInput = z.infer<typeof UpdateBeadInput>;

export const AddDepInput = z.object({
  depends_on: z.string(),
  type: BeadDepType.optional().default("blocks"),
});
export type AddDepInput = z.infer<typeof AddDepInput>;

export const CreateGateInput = z.object({
  type: BeadGateAwaitType,
  await_id: z.string(),
  reason: z.string().max(500).optional(),
});
export type CreateGateInput = z.infer<typeof CreateGateInput>;

// --- dolt push status (SSE payload) ---

export const DoltPushStatus = z.enum(["idle", "pending", "ok", "no_remote", "error"]);
export type DoltPushStatus = z.infer<typeof DoltPushStatus>;

export const DoltPushEvent = z.object({
  space_id: z.string(),
  status: DoltPushStatus,
  message: z.string().optional(),
  at: z.number(),
});
export type DoltPushEvent = z.infer<typeof DoltPushEvent>;
