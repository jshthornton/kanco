import type { AgentKind } from "@kanco/shared";

export interface AgentSpawn {
  command: string;
  args: string[];
}

export interface AgentAdapter {
  kind: AgentKind;
  /** Build the spawn command for a prompt + pre-allocated session id. */
  buildSpawn(prompt: string, sessionId: string): AgentSpawn;
  /** Shell command (no `cd`) the user runs to resume the session interactively. */
  buildResume(sessionId: string): string;
}
