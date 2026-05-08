import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  Bead,
  BeadSummary,
  BeadDepType,
  BeadGateAwaitType,
  BeadStatus,
  CreateBeadInput,
  UpdateBeadInput,
} from "@kanco/shared";
import type { z } from "zod";

type CreateBeadArgs = z.input<typeof CreateBeadInput>;
type UpdateBeadArgs = z.input<typeof UpdateBeadInput>;
import { spaceQueue } from "./queue.js";

const execFileP = promisify(execFile);

export class BeadsCliError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly stderr: string,
    public readonly stdout: string,
  ) {
    super(message);
    this.name = "BeadsCliError";
  }
}

interface RunOpts {
  cwd: string;
  timeoutMs?: number;
}

async function runBd(args: string[], opts: RunOpts): Promise<string> {
  try {
    const { stdout } = await execFileP("bd", args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, BD_NON_INTERACTIVE: "1" },
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; code?: string };
    throw new BeadsCliError(
      `bd ${args.join(" ")} failed: ${e.message}`,
      e.code ?? "EUNKNOWN",
      e.stderr ?? "",
      e.stdout ?? "",
    );
  }
}

function peelArray<T>(parsed: unknown): T {
  // `bd show` returns a single-element array. Other commands return an object.
  if (Array.isArray(parsed) && parsed.length === 1) return parsed[0] as T;
  return parsed as T;
}

export interface BeadsClientOptions {
  spaceId: string;
  repoPath: string;
}

/**
 * Thin wrapper around the `bd` CLI. One instance per space. All writes go
 * through the per-space PQueue (Dolt embedded mode is single-writer); reads
 * bypass.
 */
export class BeadsClient {
  readonly spaceId: string;
  readonly repoPath: string;

  constructor(opts: BeadsClientOptions) {
    this.spaceId = opts.spaceId;
    this.repoPath = opts.repoPath;
  }

  /** True if the repo path looks initialized for beads. */
  isInitialized(): boolean {
    return existsSync(join(this.repoPath, ".beads"));
  }

  /** Run `bd init --stealth --non-interactive` if not yet initialized. */
  async ensureInitialized(): Promise<void> {
    if (this.isInitialized()) return;
    await spaceQueue(this.spaceId).add(() =>
      runBd(["init", "--stealth", "--non-interactive"], { cwd: this.repoPath, timeoutMs: 60_000 }),
    );
  }

  // ---- reads ----

  async list(
    filter: {
      status?: BeadStatus;
      limit?: number;
      includeClosed?: boolean;
      includeGates?: boolean;
      label?: string | string[];
      parent?: string;
      q?: string;
    } = {},
  ): Promise<BeadSummary[]> {
    const args = ["list", "--json"];
    if (filter.status) args.push("--status", filter.status);
    else if (filter.includeClosed) args.push("--all");
    if (filter.includeGates) args.push("--include-gates");
    if (filter.limit != null) args.push("--limit", String(filter.limit));
    const out = await runBd(args, { cwd: this.repoPath });
    const parsed = JSON.parse(out || "[]");
    let beads = BeadSummary.array().parse(parsed);
    const wantLabels = Array.isArray(filter.label)
      ? filter.label
      : filter.label
        ? [filter.label]
        : [];
    if (wantLabels.length > 0) {
      beads = beads.filter((b) => {
        const have = b.labels ?? [];
        return wantLabels.every((l) => have.includes(l));
      });
    }
    if (filter.q && filter.q.trim()) {
      const needle = filter.q.toLowerCase();
      beads = beads.filter((b) => {
        const hay = `${b.title}\n${b.description ?? ""}\n${b.id}`.toLowerCase();
        return hay.includes(needle);
      });
    }
    if (filter.parent) beads = beads.filter((b) => b.parent === filter.parent);
    return beads;
  }

  /** Like `list` but defaults to including closed beads — used by graph view. */
  async listAll(opts: { includeClosed?: boolean; includeGates?: boolean } = {}): Promise<BeadSummary[]> {
    return this.list({
      includeClosed: opts.includeClosed ?? true,
      includeGates: opts.includeGates ?? false,
    });
  }

  async show(id: string): Promise<Bead | null> {
    try {
      const out = await runBd(["show", id, "--json"], { cwd: this.repoPath });
      const parsed = JSON.parse(out);
      return Bead.parse(peelArray<unknown>(parsed));
    } catch (err) {
      if (err instanceof BeadsCliError && /not found/i.test(err.stderr)) return null;
      throw err;
    }
  }

  /** Stream the entire bead set as JSONL via `bd export`. Best for graph view. */
  async exportAll(opts: { all?: boolean } = {}): Promise<Bead[]> {
    const args = ["export"];
    if (opts.all) args.push("--all");
    const out = await runBd(args, { cwd: this.repoPath, timeoutMs: 60_000 });
    const beads: Bead[] = [];
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (
        raw &&
        typeof raw === "object" &&
        "_type" in raw &&
        (raw as { _type?: string })._type !== "issue"
      ) {
        continue;
      }
      const parsed = Bead.safeParse(raw);
      if (parsed.success) beads.push(parsed.data);
    }
    return beads;
  }

  async listGates(opts: { all?: boolean } = {}): Promise<Bead[]> {
    const args = ["gate", "list", "--json"];
    if (opts.all) args.push("--all");
    const out = await runBd(args, { cwd: this.repoPath });
    const parsed = JSON.parse(out || "[]");
    return Bead.array().parse(parsed);
  }

  // ---- writes (queued) ----

  private write<T>(fn: () => Promise<T>): Promise<T> {
    return spaceQueue(this.spaceId).add(fn) as Promise<T>;
  }

  async create(input: CreateBeadArgs): Promise<Bead> {
    return this.write(async () => {
      const args = [
        "create",
        "--title",
        input.title,
        "-t",
        input.issue_type ?? "task",
        "--json",
      ];
      if (input.description) args.push("-d", input.description);
      if (input.priority != null) args.push("-p", String(input.priority));
      if (input.labels && input.labels.length > 0)
        args.push("--labels", input.labels.join(","));
      if (input.parent) args.push("--parent", input.parent);
      if (input.assignee) args.push("--assignee", input.assignee);
      if (input.design) args.push("--design", input.design);
      if (input.acceptance) args.push("--acceptance", input.acceptance);
      if (input.notes) args.push("--notes", input.notes);
      if (input.due) args.push("--due", input.due);
      const out = await runBd(args, { cwd: this.repoPath });
      const parsed = JSON.parse(out);
      // `bd create --json` returns the created issue object.
      const obj = peelArray<unknown>(parsed);
      // It may be wrapped { issue: {...} } depending on version — peel that too.
      const issue =
        obj && typeof obj === "object" && "issue" in obj
          ? (obj as { issue: unknown }).issue
          : obj;
      return Bead.parse(issue);
    });
  }

  async update(id: string, patch: UpdateBeadArgs): Promise<Bead> {
    return this.write(async () => {
      const args = ["update", id, "--json"];
      if (patch.title) args.push("--title", patch.title);
      if (patch.description !== undefined)
        args.push("--description", patch.description ?? "");
      if (patch.status) args.push("--status", patch.status);
      if (patch.priority != null) args.push("--priority", String(patch.priority));
      const out = await runBd(args, { cwd: this.repoPath });
      const parsed = JSON.parse(out);
      return Bead.parse(peelArray<unknown>(parsed));
    });
  }

  async close(id: string, opts: { force?: boolean; reason?: string } = {}): Promise<void> {
    await this.write(() => {
      const args = ["close", id, "--json"];
      if (opts.force) args.push("--force");
      if (opts.reason) args.push("--reason", opts.reason);
      return runBd(args, { cwd: this.repoPath });
    });
  }

  async reopen(id: string): Promise<void> {
    await this.write(() => runBd(["reopen", id, "--json"], { cwd: this.repoPath }));
  }

  async addDep(issueId: string, dependsOnId: string, type: BeadDepType = "blocks"): Promise<void> {
    await this.write(() =>
      runBd(["dep", "add", issueId, dependsOnId, "--type", type, "--json"], {
        cwd: this.repoPath,
      }),
    );
  }

  async removeDep(issueId: string, dependsOnId: string): Promise<void> {
    await this.write(() =>
      runBd(["dep", "remove", issueId, dependsOnId, "--json"], { cwd: this.repoPath }),
    );
  }

  async addGate(opts: {
    blocks: string;
    type: BeadGateAwaitType;
    awaitId?: string;
    reason?: string;
  }): Promise<Bead> {
    return this.write(async () => {
      const args = [
        "gate",
        "create",
        "--type",
        opts.type,
        "--blocks",
        opts.blocks,
        "--json",
      ];
      if (opts.awaitId) args.push("--await-id", opts.awaitId);
      if (opts.reason) args.push("--reason", opts.reason);
      const out = await runBd(args, { cwd: this.repoPath });
      return Bead.parse(JSON.parse(out));
    });
  }

  async resolveGate(gateId: string): Promise<void> {
    await this.write(() =>
      runBd(["gate", "resolve", gateId, "--json"], { cwd: this.repoPath }),
    );
  }

  /** Push to the configured Dolt remote. Returns "ok" / "no_remote" / throws. */
  async doltPush(): Promise<{ status: "ok" | "no_remote"; message: string }> {
    return this.write(async () => {
      const out = await runBd(["dolt", "push"], { cwd: this.repoPath, timeoutMs: 120_000 });
      if (/no remote is configured/i.test(out)) {
        return { status: "no_remote" as const, message: out.trim() };
      }
      return { status: "ok" as const, message: out.trim() };
    });
  }

  async doltAddRemote(name: string, url: string): Promise<void> {
    await this.write(() =>
      runBd(["dolt", "remote", "add", name, url], { cwd: this.repoPath, timeoutMs: 60_000 }),
    );
  }
}

const clients = new Map<string, BeadsClient>();

export function getBeadsClient(opts: BeadsClientOptions): BeadsClient {
  let c = clients.get(opts.spaceId);
  if (!c || c.repoPath !== opts.repoPath) {
    c = new BeadsClient(opts);
    clients.set(opts.spaceId, c);
  }
  return c;
}

export function clearBeadsClient(spaceId: string): void {
  clients.delete(spaceId);
}
