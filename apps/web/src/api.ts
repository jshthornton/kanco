import type {
  AgentKind,
  AgentSession,
  Bead,
  BeadGateAwaitType,
  BeadGraph,
  BeadIssueType,
  BeadSessionSummary,
  BeadStatus,
  BeadSummary,
  Space,
} from "@kanco/shared";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listSpaces: () => http<Space[]>("/api/spaces"),
  createSpace: (input: { name: string; repo_root?: string; dolt_remote_url?: string }) =>
    http<Space>("/api/spaces", { method: "POST", body: JSON.stringify(input) }),
  updateSpace: (
    id: string,
    patch: { name?: string; repo_root?: string | null; dolt_remote_url?: string | null },
  ) =>
    http<Space>(`/api/spaces/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  getSpace: (id: string) => http<Space>(`/api/spaces/${id}`),
  listSpaceRepos: (id: string) =>
    http<{ owner: string; repo: string }[]>(`/api/spaces/${id}/repos`),

  // ---- agent sessions (still keyed by legacy ticket_id; refactor to bead_id pending) ----
  listTicketSessions: (ticket_id: string) =>
    http<AgentSession[]>(`/api/tickets/${ticket_id}/sessions`),
  startSession: (
    ticket_id: string,
    input: { agent?: AgentKind; worktree?: boolean; include_parent?: boolean },
  ) =>
    http<AgentSession>(`/api/tickets/${ticket_id}/sessions`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getSession: (id: string) =>
    http<{ session: AgentSession; log_tail: string }>(`/api/sessions/${id}`),

  // ---- github auth ----
  githubStatus: () => http<{ connected: boolean; login: string | null }>("/api/auth/github/status"),
  githubStart: () =>
    http<{
      session_id: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }>("/api/auth/github/start", { method: "POST", body: JSON.stringify({}) }),
  githubPoll: (session_id: string) =>
    http<{ status: string; error?: string }>("/api/auth/github/poll", {
      method: "POST",
      body: JSON.stringify({ session_id }),
    }),
  githubDisconnect: () =>
    http<{ ok: true }>("/api/auth/github/disconnect", { method: "POST", body: JSON.stringify({}) }),

  // ---- beads ----
  listBeads: (
    spaceId: string,
    filter: {
      status?: BeadStatus;
      label?: string | string[];
      parent?: string;
      q?: string;
      includeClosed?: boolean;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    if (filter.status) qs.set("status", filter.status);
    const labels = Array.isArray(filter.label)
      ? filter.label
      : filter.label
        ? [filter.label]
        : [];
    for (const l of labels) qs.append("label", l);
    if (filter.parent) qs.set("parent", filter.parent);
    if (filter.q) qs.set("q", filter.q);
    if (filter.includeClosed) qs.set("include_closed", "1");
    const q = qs.toString();
    return http<BeadSummary[]>(`/api/spaces/${spaceId}/beads${q ? `?${q}` : ""}`);
  },
  listLabels: (spaceId: string) => http<string[]>(`/api/spaces/${spaceId}/labels`),
  getBead: (spaceId: string, beadId: string) =>
    http<Bead>(`/api/spaces/${spaceId}/beads/${beadId}`),
  createBead: (
    spaceId: string,
    input: {
      title: string;
      description?: string;
      issue_type?: BeadIssueType;
      priority?: number;
      labels?: string[];
      parent?: string;
      assignee?: string;
      design?: string;
      acceptance?: string;
      notes?: string;
      due?: string;
      ready?: boolean;
    },
  ) =>
    http<Bead>(`/api/spaces/${spaceId}/beads`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateBead: (
    spaceId: string,
    beadId: string,
    patch: {
      title?: string;
      description?: string | null;
      status?: BeadStatus;
      priority?: number;
    },
  ) =>
    http<Bead>(`/api/spaces/${spaceId}/beads/${beadId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  closeBead: (spaceId: string, beadId: string) =>
    http<{ ok: true }>(`/api/spaces/${spaceId}/beads/${beadId}`, { method: "DELETE" }),
  addBeadDep: (
    spaceId: string,
    beadId: string,
    depends_on: string,
    type: "blocks" | "tracks" | "related" | "parent-child" | "discovered-from" = "blocks",
  ) =>
    http<{ ok: true }>(`/api/spaces/${spaceId}/beads/${beadId}/deps`, {
      method: "POST",
      body: JSON.stringify({ depends_on, type }),
    }),
  removeBeadDep: (spaceId: string, beadId: string, dependsOn: string) =>
    http<{ ok: true }>(`/api/spaces/${spaceId}/beads/${beadId}/deps/${dependsOn}`, {
      method: "DELETE",
    }),
  addBeadGate: (
    spaceId: string,
    beadId: string,
    input: { type: BeadGateAwaitType; await_id: string; reason?: string },
  ) =>
    http<Bead>(`/api/spaces/${spaceId}/beads/${beadId}/gates`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  resolveGate: (spaceId: string, gateId: string) =>
    http<{ ok: true }>(`/api/spaces/${spaceId}/gates/${gateId}/resolve`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  listBeadSessionSummary: (spaceId: string) =>
    http<BeadSessionSummary[]>(`/api/spaces/${spaceId}/bead-sessions-summary`),
  listBeadSessions: (spaceId: string, beadId: string) =>
    http<AgentSession[]>(`/api/spaces/${spaceId}/beads/${beadId}/sessions`),
  startBeadSession: (
    spaceId: string,
    beadId: string,
    input: { agent?: AgentKind; worktree?: boolean } = {},
  ) =>
    http<AgentSession>(`/api/spaces/${spaceId}/beads/${beadId}/sessions`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getGraph: (
    spaceId: string,
    filter: { label?: string | string[]; parent?: string; q?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    const labels = Array.isArray(filter.label)
      ? filter.label
      : filter.label
        ? [filter.label]
        : [];
    for (const l of labels) qs.append("label", l);
    if (filter.parent) qs.set("parent", filter.parent);
    if (filter.q) qs.set("q", filter.q);
    const q = qs.toString();
    return http<BeadGraph>(`/api/spaces/${spaceId}/graph${q ? `?${q}` : ""}`);
  },
};
