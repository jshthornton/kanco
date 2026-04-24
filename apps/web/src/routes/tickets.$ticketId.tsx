import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api";

export const Route = createFileRoute("/tickets/$ticketId")({
  component: TicketRedirect,
});

function TicketRedirect() {
  const { ticketId } = Route.useParams();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: () => api.getTicket(ticketId),
  });

  useEffect(() => {
    if (data?.ticket) {
      void navigate({
        to: "/spaces/$spaceId",
        params: { spaceId: data.ticket.space_id },
        search: { ticket: ticketId },
        replace: true,
      });
    }
  }, [data?.ticket?.space_id]);

  return <div className="muted">Opening…</div>;
}
