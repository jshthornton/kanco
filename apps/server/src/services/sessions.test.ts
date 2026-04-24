import { describe, it, expect } from "vitest";
import { buildPrompt } from "./sessions.js";
import type { Ticket } from "@kanco/shared";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t1",
    space_id: "s",
    column_id: "c",
    title: "Do the thing",
    body: "Body of the thing",
    parent_ticket_id: null,
    position: 1,
    created_at: 0,
    updated_at: 0,
    created_by: "ui",
    external_ref: null,
    manual_override_until: null,
    done_at: null,
    ...overrides,
  };
}

describe("buildPrompt", () => {
  it("renders just the ticket when no parent is supplied", () => {
    const p = buildPrompt(ticket(), null);
    expect(p).toContain("# Ticket: Do the thing");
    expect(p).toContain("Body of the thing");
    expect(p).not.toContain("Parent ticket");
  });

  it("includes parent block when parent is provided", () => {
    const child = ticket({ id: "t2", title: "Subtask", body: "Sub body" });
    const parent = ticket({ id: "t1", title: "Parent", body: "Parent body" });
    const p = buildPrompt(child, parent);
    expect(p).toContain("# Ticket: Subtask");
    expect(p).toContain("Sub body");
    expect(p).toContain("## Parent ticket: Parent");
    expect(p).toContain("Parent body");
  });

  it("handles null bodies gracefully", () => {
    const p = buildPrompt(ticket({ body: null }), ticket({ id: "p", title: "P", body: null }));
    expect(p).toContain("# Ticket: Do the thing");
    expect(p).toContain("## Parent ticket: P");
  });
});
