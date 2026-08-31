/**
 * What to do when a batch call is rejected because of items it wont name.
 * The API fails the whole call and says only "one or more items failed
 * validation", so the client chooses a recovery strategy:
 *
 * - fail-all:    give up on the whole batch. Cheapest, loses every healthy item.
 * - retry-whole: resend the identical batch up to `maxRetries` times. Against
 *                a deterministic rejection this is pure waste, priced here.
 * - one-by-one:  resend every item as its own call. Saves all healthy items,
 *                costs n extra calls and n prompt overheads.
 * - bisect:      split the failing batch in half and recurse; halves with no
 *                poison succeed as batches, poisoned singletons are named.
 *                Saves all healthy items in O(k log n) extra calls.
 */
import { ApiError, SimulatedApi } from "./api.js";
import type { ItemResult, WorkItem } from "./api.js";

export type IsolationStrategy = "fail-all" | "retry-whole" | "one-by-one" | "bisect";

export const ISOLATION_STRATEGIES: readonly IsolationStrategy[] = [
  "fail-all",
  "retry-whole",
  "one-by-one",
  "bisect",
];

export interface IsolationOutcome {
  strategy: IsolationStrategy;
  completed: ItemResult[];
  /** Healthy items that never completed because a strategy dropped them. */
  lostHealthy: number;
  /** Ids the strategy pinned down as the poisoned ones. */
  poisonedIdentified: number[];
  calls: number;
  inputTokens: number;
  elapsedMs: number;
}

export async function runWithIsolation(
  api: SimulatedApi,
  clock: { now(): number },
  items: readonly WorkItem[],
  strategy: IsolationStrategy,
  maxRetries = 3,
): Promise<IsolationOutcome> {
  const before = api.snapshot();
  const startedAt = clock.now();
  const completed: ItemResult[] = [];
  const poisonedIdentified: number[] = [];

  const attemptWhole = async (): Promise<boolean> => {
    try {
      completed.push(...(await api.call(items)));
      return true;
    } catch (error) {
      assertValidationError(error);
      return false;
    }
  };

  switch (strategy) {
    case "fail-all":
      await attemptWhole();
      break;
    case "retry-whole": {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (await attemptWhole()) break;
      }
      break;
    }
    case "one-by-one": {
      if (!(await attemptWhole())) {
        for (const item of items) {
          try {
            completed.push(...(await api.call([item])));
          } catch (error) {
            assertValidationError(error);
            poisonedIdentified.push(item.id);
          }
        }
      }
      break;
    }
    case "bisect": {
      const recurse = async (slice: readonly WorkItem[]): Promise<void> => {
        try {
          completed.push(...(await api.call(slice)));
        } catch (error) {
          assertValidationError(error);
          if (slice.length === 1) {
            poisonedIdentified.push(slice[0]!.id);
            return;
          }
          const mid = Math.ceil(slice.length / 2);
          await recurse(slice.slice(0, mid));
          await recurse(slice.slice(mid));
        }
      };
      await recurse(items);
      break;
    }
  }

  const after = api.snapshot();
  const healthyTotal = items.filter((item) => !item.poisoned).length;
  return {
    strategy,
    completed,
    lostHealthy: healthyTotal - completed.length,
    poisonedIdentified,
    calls: after.calls - before.calls,
    inputTokens: after.inputTokens - before.inputTokens,
    elapsedMs: clock.now() - startedAt,
  };
}

export function assertValidationError(error: unknown): void {
  if (!(error instanceof ApiError) || error.kind !== "validation") {
    throw error;
  }
}
