import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { MicroBatcher } from "../src/batcher.js";

interface Dispatched {
  atMs: number;
  items: string[];
}

function echoBatcher(
  clock: VirtualClock,
  opts: { maxBatchSize: number; maxWaitMs: number; dispatchDelayMs?: number },
) {
  const dispatched: Dispatched[] = [];
  const batcher = new MicroBatcher<string, string>(clock, {
    maxBatchSize: opts.maxBatchSize,
    maxWaitMs: opts.maxWaitMs,
    dispatch: async (items) => {
      dispatched.push({ atMs: clock.now(), items: [...items] });
      await clock.sleep(opts.dispatchDelayMs ?? 10);
      return items.map((item) => `${item}!`);
    },
  });
  return { batcher, dispatched };
}

describe("MicroBatcher", () => {
  it("rejects invalid options", () => {
    const clock = new VirtualClock();
    const dispatch = async (items: string[]) => items;
    expect(() => new MicroBatcher(clock, { maxBatchSize: 0, maxWaitMs: 10, dispatch })).toThrow(
      /positive integer/,
    );
    expect(() => new MicroBatcher(clock, { maxBatchSize: 2.5, maxWaitMs: 10, dispatch })).toThrow(
      /positive integer/,
    );
    expect(() => new MicroBatcher(clock, { maxBatchSize: 2, maxWaitMs: -1, dispatch })).toThrow(
      /non-negative/,
    );
  });

  it("dispatches immediately when the batch fills to maxBatchSize", async () => {
    const clock = new VirtualClock();
    const { batcher, dispatched } = echoBatcher(clock, { maxBatchSize: 3, maxWaitMs: 1000 });
    const run = Promise.all([batcher.submit("a"), batcher.submit("b"), batcher.submit("c")]);
    const results = await clock.runUntil(run);
    expect(dispatched).toEqual([{ atMs: 0, items: ["a", "b", "c"] }]);
    expect(results).toEqual(["a!", "b!", "c!"]);
  });

  it("flushes a partial batch when maxWaitMs expires", async () => {
    const clock = new VirtualClock();
    const { batcher, dispatched } = echoBatcher(clock, { maxBatchSize: 10, maxWaitMs: 50 });
    const run = Promise.all([batcher.submit("a"), batcher.submit("b")]);
    const results = await clock.runUntil(run);
    expect(dispatched).toEqual([{ atMs: 50, items: ["a", "b"] }]);
    expect(results).toEqual(["a!", "b!"]);
    expect(clock.now()).toBe(60);
  });

  it("treats maxWaitMs 0 as no coalescing: every submit is its own batch", async () => {
    const clock = new VirtualClock();
    const { batcher, dispatched } = echoBatcher(clock, { maxBatchSize: 10, maxWaitMs: 0 });
    const run = Promise.all([batcher.submit("a"), batcher.submit("b")]);
    await clock.runUntil(run);
    expect(dispatched.map((d) => d.items)).toEqual([["a"], ["b"]]);
  });

  it("a stale timer from a size-flushed batch does not flush the next batch early", async () => {
    const clock = new VirtualClock();
    const { batcher, dispatched } = echoBatcher(clock, { maxBatchSize: 2, maxWaitMs: 50 });
    const driver = (async () => {
      const first = Promise.all([batcher.submit("a"), batcher.submit("b")]);
      await clock.sleep(10);
      const second = batcher.submit("c");
      return Promise.all([first, second]);
    })();
    await clock.runUntil(driver);
    // "c" opened at t=10, so its own timer flushes it at t=60. The stale
    // timer from the first batch fires at t=50 and must be a no-op.
    expect(dispatched).toEqual([
      { atMs: 0, items: ["a", "b"] },
      { atMs: 60, items: ["c"] },
    ]);
    const stats = batcher.snapshot();
    expect(stats.batchSizes).toEqual([2, 1]);
    expect(stats.itemsSubmitted).toBe(3);
  });

  it("routes each result back to the submitter that sent the item", async () => {
    const clock = new VirtualClock();
    const { batcher } = echoBatcher(clock, { maxBatchSize: 3, maxWaitMs: 100 });
    const run = Promise.all([batcher.submit("x"), batcher.submit("y"), batcher.submit("z")]);
    const [x, y, z] = await clock.runUntil(run);
    expect(x).toBe("x!");
    expect(y).toBe("y!");
    expect(z).toBe("z!");
  });

  it("handles the same payload submitted twice as two independent items", async () => {
    const clock = new VirtualClock();
    const { batcher, dispatched } = echoBatcher(clock, { maxBatchSize: 2, maxWaitMs: 100 });
    const run = Promise.all([batcher.submit("dup"), batcher.submit("dup")]);
    const results = await clock.runUntil(run);
    expect(results).toEqual(["dup!", "dup!"]);
    expect(dispatched[0]?.items).toEqual(["dup", "dup"]);
  });

  it("rejects every item in the batch when dispatch fails", async () => {
    const clock = new VirtualClock();
    const batcher = new MicroBatcher<string, string>(clock, {
      maxBatchSize: 2,
      maxWaitMs: 100,
      dispatch: async () => {
        await clock.sleep(5);
        throw new Error("batch call failed");
      },
    });
    const a = batcher.submit("a");
    const b = batcher.submit("b");
    await expect(clock.runUntil(Promise.all([a.catch((e: Error) => e.message), b.catch((e: Error) => e.message)]))).resolves.toEqual([
      "batch call failed",
      "batch call failed",
    ]);
  });

  it("rejects the batch when dispatch returns the wrong number of results", async () => {
    const clock = new VirtualClock();
    const batcher = new MicroBatcher<string, string>(clock, {
      maxBatchSize: 2,
      maxWaitMs: 100,
      dispatch: async (items) => items.slice(0, 1),
    });
    const run = Promise.all([
      batcher.submit("a").catch((e: Error) => e.message),
      batcher.submit("b").catch((e: Error) => e.message),
    ]);
    const results = await clock.runUntil(run);
    expect(results).toEqual([
      "dispatch returned 1 results for 2 items",
      "dispatch returned 1 results for 2 items",
    ]);
  });

  it("tracks pending items in the open batch", async () => {
    const clock = new VirtualClock();
    const { batcher } = echoBatcher(clock, { maxBatchSize: 5, maxWaitMs: 50 });
    expect(batcher.pending()).toBe(0);
    const run = Promise.all([batcher.submit("a"), batcher.submit("b")]);
    expect(batcher.pending()).toBe(2);
    await clock.runUntil(run);
    expect(batcher.pending()).toBe(0);
  });
});
