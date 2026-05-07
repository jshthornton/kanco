import { describe, it, expect } from "vitest";
import { spaceQueue, clearSpaceQueue } from "./queue.js";

describe("spaceQueue", () => {
  it("serializes work for the same space", async () => {
    const id = `t-${Math.random()}`;
    const order: number[] = [];
    const q = spaceQueue(id);
    const tasks = [0, 1, 2, 3].map((n) =>
      q.add(async () => {
        await new Promise((r) => setTimeout(r, 5 - n));
        order.push(n);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3]);
    clearSpaceQueue(id);
  });

  it("isolates different spaces", async () => {
    const a = spaceQueue("a");
    const b = spaceQueue("b");
    expect(a).not.toBe(b);
    clearSpaceQueue("a");
    clearSpaceQueue("b");
  });
});
