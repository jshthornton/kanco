import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

interface ChangeEvent {
  kind: string;
  space_id?: string;
  bead_id?: string;
}

/**
 * Subscribe to /api/events (SSE) and invalidate React Query caches on server
 * mutations. Falls back gracefully if the browser can't open an EventSource.
 */
export function useLiveSync() {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: number | null = null;
    let cancelled = false;
    let attempt = 0;

    const connect = () => {
      if (cancelled) return;
      es = new EventSource("/api/events");

      es.addEventListener("ready", () => {
        attempt = 0;
      });

      es.addEventListener("change", (ev) => {
        try {
          const e = JSON.parse((ev as MessageEvent).data) as ChangeEvent;
          if (e.kind === "space.created" || e.kind === "space.updated") {
            qc.invalidateQueries({ queryKey: ["spaces"] });
          }
          if (e.space_id) {
            qc.invalidateQueries({ queryKey: ["beads", e.space_id] });
            qc.invalidateQueries({ queryKey: ["graph", e.space_id] });
            qc.invalidateQueries({ queryKey: ["space", e.space_id] });
          }
          if (e.bead_id && e.space_id) {
            qc.invalidateQueries({ queryKey: ["bead", e.space_id, e.bead_id] });
          }
          if (e.kind.startsWith("dolt.push")) {
            qc.invalidateQueries({ queryKey: ["dolt-push", e.space_id] });
          }
        } catch (err) {
          console.warn("[useLiveSync] bad event", err);
        }
      });

      es.onerror = () => {
        es?.close();
        es = null;
        if (cancelled) return;
        attempt += 1;
        // exponential backoff, capped. Prevents reconnect storms when the
        // server is down or restarting.
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        retry = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (retry) window.clearTimeout(retry);
      es?.close();
      es = null;
    };
  }, [qc]);
}
