import { z } from "zod";

export const DEFAULT_COLUMNS = [
  { name: "Todo", position: 1 },
  { name: "Planning", position: 2 },
  { name: "In Progress", position: 3 },
  { name: "In Review", position: 4 },
  { name: "Done", position: 5 },
  { name: "Closed", position: 6 },
] as const;

export type DefaultColumnName = (typeof DEFAULT_COLUMNS)[number]["name"];

export const PrState = z.enum(["draft", "open", "closed", "merged"]);
export type PrState = z.infer<typeof PrState>;

export const Space = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  repo_root: z.string().nullable(),
  created_at: z.number(),
});
export type Space = z.infer<typeof Space>;

export const AgentKind = z.enum(["claude", "codex", "cursor"]);
export type AgentKind = z.infer<typeof AgentKind>;

export const AgentSessionStatus = z.enum(["starting", "running", "exited", "error"]);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatus>;

export const AgentSession = z.object({
  id: z.string(),
  ticket_id: z.string(),
  space_id: z.string(),
  agent: AgentKind,
  agent_session_id: z.string().nullable(),
  worktree_path: z.string().nullable(),
  branch: z.string().nullable(),
  cwd: z.string(),
  pid: z.number().nullable(),
  status: AgentSessionStatus,
  exit_code: z.number().nullable(),
  log_path: z.string(),
  prompt: z.string(),
  include_parent: z.boolean(),
  used_worktree: z.boolean(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
});
export type AgentSession = z.infer<typeof AgentSession>;

export const Column = z.object({
  id: z.string(),
  space_id: z.string(),
  name: z.string(),
  position: z.number(),
});
export type Column = z.infer<typeof Column>;

export const Ticket = z.object({
  id: z.string(),
  space_id: z.string(),
  column_id: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  parent_ticket_id: z.string().nullable(),
  position: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
  created_by: z.string(),
  external_ref: z.string().nullable(),
  manual_override_until: z.number().nullable(),
  done_at: z.number().nullable(),
});
export type Ticket = z.infer<typeof Ticket>;

// Tickets older than this in the Done column are filtered out of list views.
export const DONE_VISIBILITY_MS = 14 * 24 * 60 * 60 * 1000;

export const TicketPrLink = z.object({
  id: z.string(),
  ticket_id: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  state: PrState,
  title: z.string().nullable(),
  url: z.string(),
  head_sha: z.string().nullable(),
  last_synced_at: z.number().nullable(),
});
export type TicketPrLink = z.infer<typeof TicketPrLink>;

// API input schemas

export const CreateSpaceInput = z.object({
  name: z.string().min(1).max(100),
  repo_root: z.string().min(1).max(1000).optional(),
});

export const UpdateSpaceInput = z.object({
  id: z.string(),
  name: z.string().min(1).max(100).optional(),
  repo_root: z.string().max(1000).nullable().optional(),
});

export const StartSessionInput = z.object({
  ticket_id: z.string(),
  agent: AgentKind.default("claude"),
  worktree: z.boolean().default(true),
  include_parent: z.boolean().default(true),
});

export const CreateTicketInput = z.object({
  space_id: z.string(),
  title: z.string().min(1).max(300),
  body: z.string().max(20000).optional(),
  column: z.string().optional(),
  parent_ticket_id: z.string().optional(),
  created_by: z.string().default("ui"),
});

export const UpdateTicketInput = z.object({
  id: z.string(),
  title: z.string().min(1).max(300).optional(),
  body: z.string().max(20000).nullable().optional(),
});

export const MoveTicketInput = z.object({
  id: z.string(),
  column_id: z.string(),
  position: z.number(),
  manual: z.boolean().default(true),
});

export const LinkPrInput = z.object({
  ticket_id: z.string(),
  pr_url: z.string().url(),
});

// github PR URL parser — github.com/<owner>/<repo>/pull/<number>
const PR_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = PR_RE.exec(url.trim());
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]!) };
}

// columns we care about by name — used by the transition machine
export const WELL_KNOWN = {
  TODO: "Todo",
  PLANNING: "Planning",
  IN_PROGRESS: "In Progress",
  IN_REVIEW: "In Review",
  DONE: "Done",
  CLOSED: "Closed",
} as const;
