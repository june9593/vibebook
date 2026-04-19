import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../../src/digest/concurrency.js";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("mapWithConcurrency", () => {
  it("returns results in input order, regardless of completion order", async () => {
    // Worker for index 0 takes 30ms; index 1 takes 10ms.
    const got = await mapWithConcurrency([0, 1, 2], 3, async (n) => {
      await delay(n === 0 ? 30 : 5);
      return n * 10;
    });
    expect(got).toEqual([0, 10, 20]);
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const worker = async (n: number): Promise<number> => {
      active++;
      peak = Math.max(peak, active);
      await delay(15);
      active--;
      return n;
    };
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, worker);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // sanity: at least some parallelism happened
  });

  it("returns empty array for empty input", async () => {
    const got = await mapWithConcurrency([], 4, async (n: number) => n);
    expect(got).toEqual([]);
  });

  it("works with limit larger than items.length", async () => {
    const got = await mapWithConcurrency([1, 2, 3], 99, async (n) => n * 2);
    expect(got).toEqual([2, 4, 6]);
  });

  it("works with limit=1 (effectively serial)", async () => {
    const order: number[] = [];
    await mapWithConcurrency([0, 1, 2, 3], 1, async (n) => {
      order.push(n);
      await delay(5);
    });
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("throws on first worker error and stops dispatching", async () => {
    let started = 0;
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4], 2, async (n) => {
        started++;
        await delay(5);
        if (n === 1) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow(/boom/);
    // started should be < items.length (we stop dispatching after the error).
    // Exact count depends on race; just assert we didn't dispatch all 5.
    expect(started).toBeLessThan(5);
  });

  it("throws on limit < 1", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(/limit/);
  });
});
