/**
 * Simulated LLM batch endpoint. One call carries 1..maxItemsPerCall items and
 * pays a fixed prompt overhead (shared instructions) plus a per-item token
 * cost, so batching amortizes the overhead. Latency is a per-call base plus a
 * per-item slope with seeded jitter. The server processes at most
 * `maxConcurrent` calls at once; excess calls queue FIFO, and that queue wait
 * is part of the latency a client observes.
 *
 * Failure model: a call containing any poisoned item is rejected as a whole
 * after the base latency (a validation-shaped failure: fast, no output
 * generated, no word about which item was at fault). Input tokens are still
 * charged on rejected calls; output tokens are not. Items may also be flaky
 * (`flakeRate`): they fail probabilistically per attempt instead of always,
 * with the same whole-call rejection when they do.
 */
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import type { Rng } from "../../05-token-streaming/src/rng.js";
import { Semaphore } from "./semaphore.js";

export interface WorkItem {
  id: number;
  poisoned: boolean;
  /**
   * Per-attempt failure probability. A flaky item fails each call it rides in
   * with this probability, independently per attempt; when it fails, the whole
   * call is rejected exactly like a poisoned one. 0 (or absent) never fails,
   * 1 always fails. Draws come from a dedicated rng so enabling flake leaves
   * the seeded latency stream untouched.
   */
  flakeRate?: number;
}

export interface ItemResult {
  id: number;
  finishedAtMs: number;
}

export interface ApiOptions {
  /** Per-call latency floor, ms. */
  baseLatencyMs: number;
  /** Added latency per item in the call, ms. */
  perItemLatencyMs: number;
  /** Multiplicative latency jitter: sampled uniformly from [1-j, 1+j]. */
  latencyJitter: number;
  /** Calls the server works on simultaneously; the rest queue FIFO. */
  maxConcurrent: number;
  /** Hard cap on items per call; larger calls are rejected instantly. */
  maxItemsPerCall: number;
  /** Tokens charged once per call (shared instructions / system prompt). */
  promptOverheadTokens: number;
  perItemInputTokens: number;
  perItemOutputTokens: number;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
}

export const DEFAULT_API_OPTIONS: ApiOptions = {
  baseLatencyMs: 80,
  perItemLatencyMs: 20,
  latencyJitter: 0.1,
  maxConcurrent: 8,
  maxItemsPerCall: 64,
  promptOverheadTokens: 400,
  perItemInputTokens: 60,
  perItemOutputTokens: 30,
  inputPricePerMTok: 3,
  outputPricePerMTok: 15,
};

export class ApiError extends Error {
  constructor(
    readonly kind: "validation" | "oversize" | "empty",
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiStats {
  calls: number;
  failedCalls: number;
  itemsCompleted: number;
  inputTokens: number;
  outputTokens: number;
  /** Time each call spent waiting for a server slot, ms, in call order. */
  queueWaitsMs: number[];
}

export class SimulatedApi {
  readonly opts: ApiOptions;
  private readonly slots: Semaphore;
  private readonly stats: ApiStats = {
    calls: 0,
    failedCalls: 0,
    itemsCompleted: 0,
    inputTokens: 0,
    outputTokens: 0,
    queueWaitsMs: [],
  };

  constructor(
    private readonly clock: VirtualClock,
    private readonly rng: Rng,
    opts: Partial<ApiOptions> = {},
    private readonly flakeRng?: Rng,
  ) {
    this.opts = { ...DEFAULT_API_OPTIONS, ...opts };
    this.slots = new Semaphore(this.opts.maxConcurrent);
  }

  async call(items: readonly WorkItem[]): Promise<ItemResult[]> {
    if (items.length === 0) {
      throw new ApiError("empty", "batch call carries no items");
    }
    if (items.length > this.opts.maxItemsPerCall) {
      throw new ApiError(
        "oversize",
        `batch of ${items.length} exceeds the ${this.opts.maxItemsPerCall}-item limit`,
      );
    }
    const queuedAt = this.clock.now();
    const release = await this.slots.acquire();
    this.stats.queueWaitsMs.push(this.clock.now() - queuedAt);
    this.stats.calls++;
    this.stats.inputTokens +=
      this.opts.promptOverheadTokens + items.length * this.opts.perItemInputTokens;
    try {
      const jitter = 1 - this.opts.latencyJitter + 2 * this.opts.latencyJitter * this.rng();
      if (items.some((item) => item.poisoned) || this.drawFlakes(items)) {
        await this.clock.sleep(this.opts.baseLatencyMs * jitter);
        this.stats.failedCalls++;
        throw new ApiError("validation", "batch rejected: one or more items failed validation");
      }
      const serviceMs =
        (this.opts.baseLatencyMs + items.length * this.opts.perItemLatencyMs) * jitter;
      await this.clock.sleep(serviceMs);
      this.stats.outputTokens += items.length * this.opts.perItemOutputTokens;
      this.stats.itemsCompleted += items.length;
      const finishedAtMs = this.clock.now();
      return items.map((item) => ({ id: item.id, finishedAtMs }));
    } finally {
      release();
    }
  }

  /**
   * One draw per flaky item in call order, never short-circuited, so the
   * flake rng advances by exactly the call's flaky-item count no matter the
   * outcomes. Calls with no flaky items draw nothing.
   */
  private drawFlakes(items: readonly WorkItem[]): boolean {
    let anyFlaked = false;
    for (const item of items) {
      const rate = item.flakeRate ?? 0;
      if (rate <= 0) continue;
      if (this.flakeRng === undefined) {
        throw new Error(`item ${item.id} has flakeRate ${rate} but the api has no flake rng`);
      }
      if (this.flakeRng() < rate) anyFlaked = true;
    }
    return anyFlaked;
  }

  snapshot(): ApiStats {
    return { ...this.stats, queueWaitsMs: [...this.stats.queueWaitsMs] };
  }

  costUsd(): number {
    return costUsd(this.stats.inputTokens, this.stats.outputTokens, this.opts);
  }
}

export function costUsd(
  inputTokens: number,
  outputTokens: number,
  opts: Pick<ApiOptions, "inputPricePerMTok" | "outputPricePerMTok">,
): number {
  return (
    (inputTokens * opts.inputPricePerMTok + outputTokens * opts.outputPricePerMTok) / 1_000_000
  );
}

export function makeItems(count: number, poisonedIds: readonly number[] = []): WorkItem[] {
  const poisoned = new Set(poisonedIds);
  return Array.from({ length: count }, (_, id) => ({ id, poisoned: poisoned.has(id) }));
}
