import type { AgentKind } from "@kanco/shared";
import type { AgentAdapter } from "./types.js";
import { claudeAdapter } from "./claude.js";

const REGISTRY: Partial<Record<AgentKind, AgentAdapter>> = {
  claude: claudeAdapter,
};

export function getAgent(kind: AgentKind): AgentAdapter {
  const a = REGISTRY[kind];
  if (!a) {
    const err = new Error(`agent ${kind} not implemented`) as Error & { code: string };
    err.code = "agent_not_implemented";
    throw err;
  }
  return a;
}

export type { AgentAdapter, AgentSpawn } from "./types.js";
