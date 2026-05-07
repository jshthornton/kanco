import type { BeadsClient } from "./client.js";
import { emitChange } from "../../events.js";

/**
 * Fire-and-forget Dolt push. Goes through the per-space queue tail (because
 * BeadsClient.doltPush is itself queued), so it serializes after the write
 * that triggered it. We never throw to callers — push failures surface via
 * the SSE channel instead so the UI can show a status pill.
 */
export function schedulePush(client: BeadsClient): void {
  void (async () => {
    emitChange({
      kind: "dolt.push.status",
      space_id: client.spaceId,
      payload: { status: "pending", at: Date.now() },
    });
    try {
      const result = await client.doltPush();
      emitChange({
        kind: "dolt.push.status",
        space_id: client.spaceId,
        payload: {
          status: result.status === "ok" ? "ok" : "no_remote",
          message: result.message,
          at: Date.now(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[beads.push] space=${client.spaceId} failed:`, message);
      emitChange({
        kind: "dolt.push.status",
        space_id: client.spaceId,
        payload: { status: "error", message, at: Date.now() },
      });
    }
  })();
}

/** Wrap a write so it auto-pushes after success. */
export async function withAutoPush<T>(client: BeadsClient, fn: () => Promise<T>): Promise<T> {
  const result = await fn();
  schedulePush(client);
  return result;
}
