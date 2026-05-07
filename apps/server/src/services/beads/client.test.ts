import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { BeadsClient, clearBeadsClient } from "./client.js";

let bdAvailable = false;
try {
  execFileSync("bd", ["--version"], { stdio: "ignore" });
  bdAvailable = true;
} catch {
  bdAvailable = false;
}

const d = bdAvailable ? describe : describe.skip;

d("BeadsClient (integration)", () => {
  let tmp: string;
  let client: BeadsClient;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "bd-test-"));
    client = new BeadsClient({ spaceId: "test-space", repoPath: tmp });
    await client.ensureInitialized();
  }, 60_000);

  afterAll(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    clearBeadsClient("test-space");
  });

  it("initializes and lists empty", async () => {
    expect(client.isInitialized()).toBe(true);
    const beads = await client.list();
    expect(beads).toEqual([]);
  });

  it("creates and shows a bead", async () => {
    const b = await client.create({ title: "Test bead", issue_type: "task" });
    expect(b.id).toMatch(/^[A-Za-z0-9-]+$/);
    expect(b.title).toBe("Test bead");
    expect(b.status).toBe("open");

    const got = await client.show(b.id);
    expect(got?.id).toBe(b.id);
    expect(got?.title).toBe("Test bead");
  });

  it("updates status", async () => {
    const b = await client.create({ title: "Status test" });
    const updated = await client.update(b.id, { status: "in_progress" });
    expect(updated.status).toBe("in_progress");
  });

  it("adds and surfaces gh:pr gates", async () => {
    const b = await client.create({ title: "Gate test" });
    const gate = await client.addGate({
      blocks: b.id,
      type: "gh:pr",
      awaitId: "123",
      reason: "test",
    });
    expect(gate.issue_type).toBe("gate");
    expect(gate.await_type).toBe("gh:pr");
    expect(gate.await_id).toBe("123");

    const shown = await client.show(b.id);
    const dep = shown?.dependencies?.find((d) => "id" in d && d.id === gate.id);
    expect(dep).toBeDefined();
    if (dep && "await_type" in dep) expect(dep.await_type).toBe("gh:pr");

    await client.resolveGate(gate.id);
    const after = await client.show(b.id);
    const dep2 = after?.dependencies?.find((d) => "id" in d && d.id === gate.id);
    if (dep2 && "status" in dep2) expect(dep2.status).toBe("closed");
  });

  it("doltPush handles missing remote gracefully", async () => {
    const r = await client.doltPush();
    expect(r.status).toBe("no_remote");
  });

  it("exportAll returns parsed beads", async () => {
    const all = await client.exportAll();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((b) => typeof b.id === "string")).toBe(true);
  });
});
