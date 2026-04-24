import { useEffect } from "react";
import { TicketDetail } from "./TicketDetail";

interface Props {
  ticketId: string | null;
  onClose: () => void;
  onOpenTicket?: (id: string) => void;
}

export function TicketDrawer({ ticketId, onClose, onOpenTicket }: Props) {
  useEffect(() => {
    if (!ticketId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ticketId, onClose]);

  const open = !!ticketId;

  return (
    <>
      <div
        className={`drawer-backdrop${open ? " open" : ""}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={`drawer${open ? " open" : ""}`}
        role="dialog"
        aria-label="Ticket details"
        aria-hidden={!open}
      >
        <div className="drawer-inner">
          {ticketId && (
            <TicketDetail ticketId={ticketId} onClose={onClose} onOpenTicket={onOpenTicket} />
          )}
        </div>
      </aside>
    </>
  );
}
