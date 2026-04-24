import type {
  AgentKind,
  AgentSession,
  Column,
  Space,
  Ticket,
  TicketPrLink,
  TicketSessionSummary,
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
  createSpace: (name: string) =>
    http<Space>("/api/spaces", { method: "POST", body: JSON.stringify({ name }) }),
  updateSpace: (id: string, patch: { name?: string; repo_root?: string | null }) =>
    http<Space>(`/api/spaces/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  getSpace: (id: string) => http<Space>(`/api/spaces/${id}`),
  listBoard: (spaceId: string) =>
    http<{
      tickets: Ticket[];
      links: TicketPrLink[];
      columns: Column[];
      session_summary: TicketSessionSummary[];
    }>(`/api/spaces/${spaceId}/tickets`),
  createTicket: (input: {
    space_id: string;
    title: string;
    body?: string;
    column?: string;
    parent_ticket_id?: string;
  }) =>
    http<Ticket>("/api/tickets", { method: "POST", body: JSON.stringify(input) }),
  getTicket: (id: string) =>
    http<{ ticket: Ticket; links: TicketPrLink[]; subtasks: Ticket[] }>(`/api/tickets/${id}`),
  updateTicket: (id: string, patch: { title?: string; body?: string | null }) =>
    http<Ticket>(`/api/tickets/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteTicket: (id: string) => http<{ ok: true }>(`/api/tickets/${id}`, { method: "DELETE" }),
  moveTicket: (id: string, column_id: string, position: number, manual = true) =>
    http<Ticket>(`/api/tickets/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ column_id, position, manual }),
    }),
  linkPr: (ticket_id: string, pr_url: string) =>
    http<TicketPrLink>(`/api/tickets/${ticket_id}/links`, {
      method: "POST",
      body: JSON.stringify({ pr_url }),
    }),
  unlinkPr: (link_id: string) => http<{ ok: true }>(`/api/links/${link_id}`, { method: "DELETE" }),
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
};
