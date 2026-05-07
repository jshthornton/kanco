import PQueue from "p-queue";

const queues = new Map<string, PQueue>();

/**
 * Per-space write queue. Embedded Dolt is single-writer; concurrent `bd ...`
 * invocations against the same `.beads/` will silently lose commits. Reads
 * bypass the queue.
 */
export function spaceQueue(spaceId: string): PQueue {
  let q = queues.get(spaceId);
  if (!q) {
    q = new PQueue({ concurrency: 1 });
    queues.set(spaceId, q);
  }
  return q;
}

export function clearSpaceQueue(spaceId: string): void {
  queues.delete(spaceId);
}
