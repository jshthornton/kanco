import type { AgentAdapter } from "./types.js";

export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  buildSpawn(prompt, sessionId) {
    return { command: "claude", args: ["-p", "--session-id", sessionId, prompt] };
  },
  buildResume(sessionId) {
    return `claude --resume ${sessionId}`;
  },
};
