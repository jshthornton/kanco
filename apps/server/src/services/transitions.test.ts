import { describe, it, expect } from "vitest";
import { desiredColumnName, planTransition } from "./transitions.js";
import type { Column, Ticket, TicketPrLink } from "@kanco/shared";

const cols: Column[] = [
  { id: "col-todo", space_id: "s", name: "Todo", position: 1 },
  { id: "col-planning", space_id: "s", name: "Planning", position: 2 },
  { id: "col-ip", space_id: "s", name: "In Progress", position: 3 },
  { id: "col-ir", space_id: "s", name: "In Review", position: 4 },
  { id: "col-done", space_id: "s", name: "Done", position: 5 },
];

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t1",
    space_id: "s",
    column_id: "col-todo",
    title: "x",
    body: null,
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

function link(state: TicketPrLink["state"]): TicketPrLink {
  return {
    id: `l-${state}`,
    ticket_id: "t1",
    owner: "o",
    repo: "r",
    number: 1,
    state,
    title: null,
    url: "https://github.com/o/r/pull/1",
    head_sha: null,
    last_synced_at: null,
  };
}

describe("desiredColumnName", () => {
  const now = 1_000_000;

  it("returns null when there are no links", () => {
    expect(desiredColumnName({ ticket: ticket(), links: [], columns: cols, now })).toBeNull();
  });

  it("routes open PR → In Review", () => {
    expect(
      desiredColumnName({ ticket: ticket(), links: [link("open")], columns: cols, now }),
    ).toBe("In Review");
  });

  it("routes merged PR → Done", () => {
    expect(
      desiredColumnName({
        ticket: ticket({ column_id: "col-ir" }),
        links: [link("merged")],
        columns: cols,
        now,
      }),
    ).toBe("Done");
  });

  it("routes all-draft → In Progress", () => {
    expect(
      desiredColumnName({ ticket: ticket(), links: [link("draft"), link("draft")], columns: cols, now }),
    ).toBe("In Progress");
  });

  it("routes all-closed (no merge) → Closed", () => {
    expect(
      desiredColumnName({
        ticket: ticket({ column_id: "col-ir" }),
        links: [link("closed")],
        columns: cols,
        now,
      }),
    ).toBe("Closed");
  });

  it("any merged beats any open", () => {
    expect(
      desiredColumnName({
        ticket: ticket(),
        links: [link("open"), link("merged")],
        columns: cols,
        now,
      }),
    ).toBe("Done");
  });

  it("open beats draft", () => {
    expect(
      desiredColumnName({
        ticket: ticket(),
        links: [link("draft"), link("open")],
        columns: cols,
        now,
      }),
    ).toBe("In Review");
  });

  it("mixed draft + closed → In Progress", () => {
    expect(
      desiredColumnName({
        ticket: ticket(),
        links: [link("draft"), link("closed")],
        columns: cols,
        now,
      }),
    ).toBe("In Progress");
  });

  it("manual override suppresses auto transitions", () => {
    expect(
      desiredColumnName({
        ticket: ticket({ manual_override_until: now + 60_000 }),
        links: [link("merged")],
        columns: cols,
        now,
      }),
    ).toBeNull();
  });

  it("expired manual override no longer suppresses", () => {
    expect(
      desiredColumnName({
        ticket: ticket({ manual_override_until: now - 1 }),
        links: [link("merged")],
        columns: cols,
        now,
      }),
    ).toBe("Done");
  });
});

describe("planTransition", () => {
  const now = 1_000_000;

  it("returns null when already in the right column", () => {
    expect(
      planTransition({
        ticket: ticket({ column_id: "col-done" }),
        links: [link("merged")],
        columns: cols,
        now,
      }),
    ).toBeNull();
  });

  it("produces a plan when the ticket needs to move", () => {
    const p = planTransition({
      ticket: ticket({ column_id: "col-todo" }),
      links: [link("open")],
      columns: cols,
      now,
    });
    expect(p).not.toBeNull();
    expect(p!.to_column_id).toBe("col-ir");
    expect(p!.from_column_id).toBe("col-todo");
  });
});
