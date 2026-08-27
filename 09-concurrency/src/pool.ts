/**
 * Bounded-parallelism map over an async function. All items are submitted up
 * front; a FIFO semaphore admits at most `limit` of them at once, so items
 * start in input order and results come back in input order regardless of
 * completion order.
 */
import { Semaphore } from "./semaphore.js";

export type Settled<R> = { status: "ok"; value: R } | { status: "error"; error: unknown };

export interface PoolStats {
  /** Most calls actually in flight at once (never exceeds the limit). */
  concurrencyHighWater: number;
  started: number;
}

/**
 * Run every item and report each outcome individually. One item failing
 * costs only that item.
 */
export async function mapBoundedSettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<{ results: Settled<R>[]; stats: PoolStats }> {
  const sem = new Semaphore(limit);
  let started = 0;
  const results = await Promise.all(
    items.map((item, index) =>
      sem.withPermit(async (): Promise<Settled<R>> => {
        started++;
        try {
          return { status: "ok", value: await fn(item, index) };
        } catch (error) {
          return { status: "error", error };
        }
      }),
    ),
  );
  return { results, stats: { concurrencyHighWater: sem.highWater(), started } };
}

/**
 * Fail-fast variant: after the first rejection no new items start, in-flight
 * items are allowed to settle, and the first error (in completion order) is
 * rethrown. Succeeds only if every item succeeds.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<{ results: R[]; stats: PoolStats }> {
  const sem = new Semaphore(limit);
  let started = 0;
  let failed = false;
  let firstError: unknown;
  const results = new Array<R>(items.length);
  await Promise.all(
    items.map((item, index) =>
      sem.withPermit(async () => {
        if (failed) return;
        started++;
        try {
          results[index] = await fn(item, index);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }),
    ),
  );
  if (failed) throw firstError;
  return { results, stats: { concurrencyHighWater: sem.highWater(), started } };
}
