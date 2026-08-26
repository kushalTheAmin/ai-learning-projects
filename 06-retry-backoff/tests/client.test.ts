import { describe, expect, it } from "vitest";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { startClient, type ClientResult } from "../src/client.js";
import { fixedDelay, retryAfterExact } from "../src/policies.js";
import { TokenBucketServer } from "../src/server.js";
import { Simulation } from "../src/sim.js";

function collect(): { results: ClientResult[]; onDone: (r: ClientResult) => void } {
  const results: ClientResult[] = [];
  return { results, onDone: (r) => results.push(r) };
}

describe("startClient", () => {
  it("succeeds on the first attempt when capacity is free", () => {
    const sim = new Simulation();
    const server = new TokenBucketServer(sim, { ratePerSec: 10, burst: 10 });
    const { results, onDone } = collect();
    startClient(
      sim,
      server,
      { id: 0, startTimeSec: 2, maxAttempts: 5, policy: fixedDelay(1), rng: createRng(1) },
      onDone,
    );
    sim.run();
    expect(results).toEqual([
      { id: 0, success: true, attempts: 1, startTimeSec: 2, finishTimeSec: 2 },
    ]);
  });

  it("retries on the policy's delay until a token frees up", () => {
    const sim = new Simulation();
    // 1 token, refills 1 per second: second client must wait for refill.
    const server = new TokenBucketServer(sim, { ratePerSec: 1, burst: 1 });
    const { results, onDone } = collect();
    for (let id = 0; id < 2; id++) {
      startClient(
        sim,
        server,
        { id, startTimeSec: 0, maxAttempts: 5, policy: fixedDelay(1), rng: createRng(id) },
        onDone,
      );
    }
    sim.run();
    expect(results.map((r) => r.success)).toEqual([true, true]);
    const second = results.find((r) => r.id === 1)!;
    expect(second.attempts).toBe(2);
    expect(second.finishTimeSec).toBe(1);
  });

  it("gives up after exactly maxAttempts failures", () => {
    const sim = new Simulation();
    const server = new TokenBucketServer(sim, { ratePerSec: 1, burst: 0 });
    const { results, onDone } = collect();
    startClient(
      sim,
      server,
      { id: 0, startTimeSec: 0, maxAttempts: 3, policy: fixedDelay(0.5), rng: createRng(1) },
      onDone,
    );
    sim.run();
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.success).toBe(false);
    expect(r.attempts).toBe(3);
    expect(r.finishTimeSec).toBe(1); // failures at t=0, 0.5, 1.0
    expect(server.totalArrivals).toBe(3);
  });

  it("maxAttempts=1 means no retries at all", () => {
    const sim = new Simulation();
    const server = new TokenBucketServer(sim, { ratePerSec: 1, burst: 0 });
    const { results, onDone } = collect();
    startClient(
      sim,
      server,
      { id: 0, startTimeSec: 0, maxAttempts: 1, policy: fixedDelay(1), rng: createRng(1) },
      onDone,
    );
    sim.run();
    expect(results[0]!.attempts).toBe(1);
    expect(results[0]!.success).toBe(false);
  });

  it("gives up immediately on a non-finite delay instead of hanging the run", () => {
    const sim = new Simulation();
    // Zero-capacity server hints Retry-After: Infinity; exact policy echoes it.
    const server = new TokenBucketServer(sim, { ratePerSec: 0, burst: 0 });
    const { results, onDone } = collect();
    startClient(
      sim,
      server,
      { id: 0, startTimeSec: 0, maxAttempts: 10, policy: retryAfterExact(), rng: createRng(1) },
      onDone,
    );
    sim.run();
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.attempts).toBe(1);
    expect(sim.now).toBe(0);
  });

  it("rejects a non-positive attempt budget", () => {
    const sim = new Simulation();
    const server = new TokenBucketServer(sim, { ratePerSec: 1, burst: 1 });
    expect(() =>
      startClient(
        sim,
        server,
        { id: 0, startTimeSec: 0, maxAttempts: 0, policy: fixedDelay(1), rng: createRng(1) },
        () => {},
      ),
    ).toThrow(RangeError);
  });
});
