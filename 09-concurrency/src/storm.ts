/**
 * Timeout-retry storm simulation: an open-loop arrival stream against the
 * queueing server, with a client-side timeout and 06's retry policies wired
 * into the loop. The timeout abandons the call without cancelling it (the
 * HTTP client hangs up; the server keeps the request in its FIFO queue and
 * serves it anyway), so every abandoned attempt is load the server still
 * pays and nobody consumes. Retries add fresh load on top. Whether that
 * feedback loop converges after a transient capacity dip, or sustains itself
 * as a storm, is the measurement.
 *
 * The one client-side mechanism built new here is a retry budget: retries
 * spend from a token balance earned as a fixed fraction of first attempts,
 * capping the whole client population's retry volume at `ratio` of offered
 * load no matter how many individual tasks want to retry.
 *
 * `cancelOnTimeout` flips the abandonment model: the timeout aborts the
 * attempt's call, which dequeues it if it is still waiting for a server slot
 * (never served, never charged) but cannot touch an attempt already in
 * service. That is the AbortSignal-through-the-stack story: cancellation
 * kills queued work, in-flight work is unkillable.
 *
 * `policy.breaker` puts 06's circuit breaker (imported, not reimplemented) in
 * front of the wire as ONE gate shared by every task in the run, fail-fast
 * only: a rejected gate ends the task immediately with zero wire attempts and
 * zero budget spent. Wait mode is deliberately absent here — the arrivals are
 * open-loop, so waiting for the probe window would re-queue the whole storm
 * client-side without shedding any of the volume arithmetic that sustains it.
 * The breaker sees the client's evidence: an attempt's gate settles at the
 * instant the client learns the outcome, so a timeout settles as a counted
 * failure right then, and the orphan's eventual server-side result never
 * touches the breaker at all.
 */
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { CircuitBreaker, type BreakerOptions } from "../../06-rate-limiting/src/breaker.js";
import { nextDelayMs, type BackoffPolicy } from "../../06-rate-limiting/src/backoff.js";
import { percentile } from "../../06-rate-limiting/src/percentile.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { ApiError, SimulatedApi, type ApiOptions, type ApiStats } from "./api.js";

export interface RetryBudgetOptions {
  /** Budget earned per first attempt; caps retry volume at this fraction of offered load. */
  ratio: number;
  /** Balance ceiling, which is also the starting balance (a bounded burst allowance). */
  cap: number;
}

export class RetryBudget {
  private balance: number;
  private denied = 0;

  constructor(private readonly opts: RetryBudgetOptions) {
    if (!Number.isFinite(opts.ratio) || opts.ratio < 0 || opts.ratio > 1) {
      throw new Error(`budget ratio must be in [0, 1], got ${opts.ratio}`);
    }
    if (!Number.isFinite(opts.cap) || opts.cap < 1) {
      throw new Error(`budget cap must be a finite number >= 1, got ${opts.cap}`);
    }
    this.balance = opts.cap;
  }

  /** Credit one first attempt's worth of budget. */
  earn(): void {
    this.balance = Math.min(this.opts.cap, this.balance + this.opts.ratio);
  }

  /** Spend one retry if the balance allows it; a denial is final for that task. */
  trySpend(): boolean {
    if (this.balance >= 1) {
      this.balance -= 1;
      return true;
    }
    this.denied++;
    return false;
  }

  deniedCount(): number {
    return this.denied;
  }

  balanceNow(): number {
    return this.balance;
  }
}

export interface StormPolicy {
  name: string;
  /** Retries after the first attempt; 0 means one attempt and give up. */
  maxRetries: number;
  /** Delay between attempts, from 06's policy set; ignored when maxRetries is 0. */
  backoff: BackoffPolicy;
  /** Optional shared retry budget across every task in the run. */
  budget?: RetryBudgetOptions;
  /**
   * Optional circuit breaker shared by every task in the run, fail-fast: a
   * rejected gate ends the task on the spot with no wire attempt. First
   * attempts and retries pass the same gate. A retry the budget has already
   * granted can still die at the gate, and that budget token stays spent —
   * the two mechanisms account independently, which is part of what the
   * study measures.
   */
  breaker?: BreakerOptions;
}

export interface StormConfig {
  seed: number;
  /** Deterministic inter-arrival gap, ms. */
  arrivalGapMs: number;
  /** Tasks arrive at 0, gap, 2*gap, ... strictly below this horizon. */
  arrivalWindowMs: number;
  /** Client-side per-attempt timeout; firing abandons but does not cancel. */
  timeoutMs: number;
  /**
   * When true, the timeout also aborts the attempt's call. Cancellation
   * reaches only work still queued for a server slot (dequeued, never served,
   * never charged); an attempt already in service completes as an orphan
   * exactly as in abandon mode. Default false: abandon without cancelling.
   */
  cancelOnTimeout?: boolean;
  /** Per-attempt transient failure probability for every task's item. */
  flakeRate?: number;
  api: Partial<ApiOptions>;
  policy: StormPolicy;
}

export interface TaskRecord {
  id: number;
  arrivedMs: number;
  attempts: number;
  ok: boolean;
  /** Instant the task settled: success, or the final give-up. */
  settledMs: number;
  /** Arrival-to-success latency; absent on failure. */
  latencyMs?: number;
  /** The task gave up because the shared budget refused its next retry. */
  budgetDenied: boolean;
  /** The task ended on an open-breaker rejection, not a server answer. */
  fastFailed: boolean;
}

export interface BreakerRunStats {
  /** Times the shared breaker went from closed to open. */
  trips: number;
  /** Half-open probes admitted (each is a real wire attempt). */
  probes: number;
  /** Probes whose attempt failed or timed out, restarting the cooldown. */
  probeFailures: number;
  /** Gate rejections; each one is a task ending fast-failed. */
  rejections: number;
}

export interface StormResult {
  records: TaskRecord[];
  attemptsStarted: number;
  /** Attempts the client abandoned at the timeout. */
  attemptsAbandoned: number;
  /** Abandoned attempts the server nonetheless served to completion. */
  wastedCompletions: number;
  /** Abandoned attempts cancelled while still queued: dequeued, never served. */
  attemptsCancelled: number;
  retriesDenied: number;
  /** Tasks ended by an open-breaker rejection. */
  fastFailedTasks: number;
  /** Present iff the policy carried a breaker. */
  breakerStats?: BreakerRunStats;
  apiStats: ApiStats;
  costUsd: number;
  /** Virtual instant the last attempt (orphans included) finished draining. */
  drainedAtMs: number;
}

export async function runStorm(cfg: StormConfig): Promise<StormResult> {
  if (!Number.isFinite(cfg.arrivalGapMs) || cfg.arrivalGapMs <= 0) {
    throw new Error(`arrivalGapMs must be positive, got ${cfg.arrivalGapMs}`);
  }
  if (!Number.isFinite(cfg.arrivalWindowMs) || cfg.arrivalWindowMs < 0) {
    throw new Error(`arrivalWindowMs must be non-negative, got ${cfg.arrivalWindowMs}`);
  }
  if (!Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs <= 0) {
    throw new Error(`timeoutMs must be positive, got ${cfg.timeoutMs}`);
  }
  if (!Number.isInteger(cfg.policy.maxRetries) || cfg.policy.maxRetries < 0) {
    throw new Error(`maxRetries must be a non-negative integer, got ${cfg.policy.maxRetries}`);
  }
  if (cfg.flakeRate !== undefined && (!Number.isFinite(cfg.flakeRate) || cfg.flakeRate < 0 || cfg.flakeRate > 1)) {
    throw new Error(`flakeRate must be in [0, 1], got ${cfg.flakeRate}`);
  }
  const clock = new VirtualClock();
  // Three rng streams: the api draws latency jitter per admitted call, the
  // flake stream draws per-attempt faults, the backoff stream draws retry
  // delays. Separate streams keep the server's latency sequence identical
  // across policies with different retry counts.
  const api = new SimulatedApi(clock, createRng(cfg.seed), cfg.api, createRng(cfg.seed ^ 0x5f356495));
  const backoffRng = createRng(cfg.seed ^ 0x9e3779b9);
  const flakeRate = cfg.flakeRate ?? 0;
  const budget = cfg.policy.budget ? new RetryBudget(cfg.policy.budget) : undefined;
  const breaker = cfg.policy.breaker ? new CircuitBreaker(clock, cfg.policy.breaker) : undefined;
  let probeFailures = 0;
  let fastFailedTasks = 0;

  let attemptsStarted = 0;
  let attemptsAbandoned = 0;
  let wastedCompletions = 0;
  let attemptsCancelled = 0;
  let drainedAtMs = 0;
  const orphans: Promise<void>[] = [];

  const runTask = async (id: number, arrivedMs: number): Promise<TaskRecord> => {
    budget?.earn();
    let prevDelayMs: number | undefined;
    for (let attempt = 1; ; attempt++) {
      const gate = breaker?.tryAcquire();
      if (gate !== undefined && !gate.admitted) {
        fastFailedTasks++;
        const settledMs = clock.now();
        drainedAtMs = Math.max(drainedAtMs, settledMs);
        return {
          id,
          arrivedMs,
          attempts: attempt - 1,
          ok: false,
          settledMs,
          budgetDenied: false,
          fastFailed: true,
        };
      }
      attemptsStarted++;
      const controller = cfg.cancelOnTimeout ? new AbortController() : undefined;
      const call = api.call([{ id, poisoned: false, flakeRate }], controller?.signal);
      const outcome = await Promise.race([
        call.then(
          () => "ok" as const,
          () => "error" as const,
        ),
        clock.sleep(cfg.timeoutMs).then(() => "timeout" as const),
      ]);
      // The gate settles on the client's evidence, exactly once, right now: a
      // timeout is a counted failure at the timeout instant, and the orphan's
      // eventual result is a straggler the breaker never hears about.
      if (gate !== undefined) {
        const countedOk = outcome === "ok";
        if (gate.probe && !countedOk) probeFailures++;
        breaker!.settle(gate, countedOk);
      }
      if (outcome === "ok") {
        const settledMs = clock.now();
        drainedAtMs = Math.max(drainedAtMs, settledMs);
        return {
          id,
          arrivedMs,
          attempts: attempt,
          ok: true,
          settledMs,
          latencyMs: settledMs - arrivedMs,
          budgetDenied: false,
          fastFailed: false,
        };
      }
      if (outcome === "timeout") {
        attemptsAbandoned++;
        orphans.push(
          call.then(
            () => {
              wastedCompletions++;
              drainedAtMs = Math.max(drainedAtMs, clock.now());
            },
            (err: unknown) => {
              if (err instanceof ApiError && err.kind === "cancelled") attemptsCancelled++;
              drainedAtMs = Math.max(drainedAtMs, clock.now());
            },
          ),
        );
        controller?.abort();
      }
      const retriesUsed = attempt - 1;
      const denied = retriesUsed < cfg.policy.maxRetries && budget !== undefined && !budget.trySpend();
      if (retriesUsed >= cfg.policy.maxRetries || denied) {
        const settledMs = clock.now();
        drainedAtMs = Math.max(drainedAtMs, settledMs);
        return {
          id,
          arrivedMs,
          attempts: attempt,
          ok: false,
          settledMs,
          budgetDenied: denied,
          fastFailed: false,
        };
      }
      const delayMs = nextDelayMs(cfg.policy.backoff, attempt, prevDelayMs, backoffRng);
      prevDelayMs = delayMs;
      await clock.sleep(delayMs);
    }
  };

  const driver = (async () => {
    const tasks: Promise<TaskRecord>[] = [];
    const count = Math.ceil(cfg.arrivalWindowMs / cfg.arrivalGapMs);
    for (let i = 0; i < count; i++) {
      const dueMs = i * cfg.arrivalGapMs;
      if (clock.now() < dueMs) await clock.sleep(dueMs - clock.now());
      tasks.push(runTask(i, clock.now()));
    }
    const records = await Promise.all(tasks);
    await Promise.all(orphans);
    return records;
  })();

  const records = await clock.runUntil(driver);
  return {
    records,
    attemptsStarted,
    attemptsAbandoned,
    wastedCompletions,
    attemptsCancelled,
    retriesDenied: budget?.deniedCount() ?? 0,
    fastFailedTasks,
    breakerStats:
      breaker === undefined
        ? undefined
        : {
            trips: breaker.trips,
            probes: breaker.probes,
            probeFailures,
            rejections: breaker.rejections,
          },
    apiStats: api.snapshot(),
    costUsd: api.costUsd(),
    drainedAtMs,
  };
}

export interface StormSummary {
  tasks: number;
  succeeded: number;
  failed: number;
  successPct: number;
  attemptsStarted: number;
  /** Attempts per task: the load multiplier the retry loop imposed. */
  amplification: number;
  wastedCompletions: number;
  /** Fraction of started attempts the server served for nobody. */
  wastedPct: number;
  attemptsCancelled: number;
  /** Fraction of started attempts cancelled in the queue before service. */
  cancelledPct: number;
  /** Longest the server admission queue ever got. */
  maxQueueDepth: number;
  retriesDenied: number;
  fastFailedTasks: number;
  /** Fraction of tasks ended by an open-breaker rejection. */
  fastFailPct: number;
  /** Present iff the policy carried a breaker. */
  breakerStats?: BreakerRunStats;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  costUsd: number;
  usdPer1kDone?: number;
  drainedAtMs: number;
}

export function summarize(result: StormResult): StormSummary {
  const tasks = result.records.length;
  const succeeded = result.records.filter((r) => r.ok).length;
  const latencies = result.records
    .filter((r) => r.ok)
    .map((r) => r.latencyMs!)
    .sort((a, b) => a - b);
  return {
    tasks,
    succeeded,
    failed: tasks - succeeded,
    successPct: tasks === 0 ? 100 : (succeeded / tasks) * 100,
    attemptsStarted: result.attemptsStarted,
    amplification: tasks === 0 ? 0 : result.attemptsStarted / tasks,
    wastedCompletions: result.wastedCompletions,
    wastedPct:
      result.attemptsStarted === 0 ? 0 : (result.wastedCompletions / result.attemptsStarted) * 100,
    attemptsCancelled: result.attemptsCancelled,
    cancelledPct:
      result.attemptsStarted === 0 ? 0 : (result.attemptsCancelled / result.attemptsStarted) * 100,
    maxQueueDepth: result.apiStats.maxQueueDepth,
    retriesDenied: result.retriesDenied,
    fastFailedTasks: result.fastFailedTasks,
    fastFailPct: tasks === 0 ? 0 : (result.fastFailedTasks / tasks) * 100,
    breakerStats: result.breakerStats,
    p50LatencyMs: latencies.length === 0 ? undefined : percentile(latencies, 0.5),
    p95LatencyMs: latencies.length === 0 ? undefined : percentile(latencies, 0.95),
    costUsd: result.costUsd,
    usdPer1kDone: succeeded === 0 ? undefined : (result.costUsd / succeeded) * 1000,
    drainedAtMs: result.drainedAtMs,
  };
}

/**
 * Recovery lag: how long after the dip ends the last task failure arrives.
 * A failure arriving within `guardMs` of the arrival horizon means the run
 * was still failing when arrivals stopped: no recovery observed (undefined).
 * 0 means every task arriving after the dip end succeeded.
 */
export function recoveryLagMs(
  result: StormResult,
  dipEndMs: number,
  arrivalWindowMs: number,
  guardMs = 5000,
): number | undefined {
  let lastFailedArrivalMs = -Infinity;
  for (const record of result.records) {
    if (!record.ok) lastFailedArrivalMs = Math.max(lastFailedArrivalMs, record.arrivedMs);
  }
  if (lastFailedArrivalMs === -Infinity) return 0;
  if (lastFailedArrivalMs >= arrivalWindowMs - guardMs) return undefined;
  return Math.max(0, lastFailedArrivalMs - dipEndMs);
}

export interface TimelineBin {
  startMs: number;
  arrivals: number;
  succeededPct: number;
  meanAttempts: number;
  /** Mean arrival-to-success latency for the bin's successes; absent if none. */
  meanLatencyMs?: number;
}

/** Bucket task outcomes by arrival time. */
export function timeline(
  records: readonly TaskRecord[],
  binMs: number,
  windowMs: number,
): TimelineBin[] {
  if (!Number.isFinite(binMs) || binMs <= 0) {
    throw new Error(`binMs must be positive, got ${binMs}`);
  }
  const binCount = Math.ceil(windowMs / binMs);
  const bins: TimelineBin[] = Array.from({ length: binCount }, (_, i) => ({
    startMs: i * binMs,
    arrivals: 0,
    succeededPct: 0,
    meanAttempts: 0,
  }));
  const succeeded = new Array<number>(binCount).fill(0);
  const attempts = new Array<number>(binCount).fill(0);
  const latencySum = new Array<number>(binCount).fill(0);
  for (const record of records) {
    const index = Math.min(binCount - 1, Math.floor(record.arrivedMs / binMs));
    const bin = bins[index]!;
    bin.arrivals++;
    attempts[index]! += record.attempts;
    if (record.ok) {
      succeeded[index]!++;
      latencySum[index]! += record.latencyMs!;
    }
  }
  for (let i = 0; i < binCount; i++) {
    const bin = bins[i]!;
    if (bin.arrivals > 0) {
      bin.succeededPct = (succeeded[i]! / bin.arrivals) * 100;
      bin.meanAttempts = attempts[i]! / bin.arrivals;
    }
    if (succeeded[i]! > 0) bin.meanLatencyMs = latencySum[i]! / succeeded[i]!;
  }
  return bins;
}
