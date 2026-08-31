/**
 * The isolation strategies from isolate.ts, generalized for flaky items:
 * items that fail a call with some probability per attempt instead of always.
 * Deterministic poison made recovery a search problem; flake makes it a
 * gamble, and the strategies change character:
 *
 * - fail-all:    unchanged, one attempt, keep whatever it returns.
 * - retry-whole: no longer pure waste — a rejected batch can pass on resend,
 *                but only if no flaky item fires, so it is all-or-nothing.
 * - one-by-one:  each item now gets a retry budget of its own, because a
 *                failing singleton might just have been unlucky.
 * - bisect:      a failing singleton is retried on the same budget before it
 *                is given up; larger slices are split, never retried, so a
 *                flaky item that fires repeatedly resends its slice-mates at
 *                every level of the tree.
 *
 * Every strategy gives an item at most `maxRetries + 1` singleton attempts,
 * the same budget retry-whole gets for the whole batch. Bisect's flaky items
 * additionally ride (and can pass inside) the larger slices on the way down,
 * so bisect buys extra completion chances with its extra calls.
 */
import { SimulatedApi } from "./api.js";
import type { ItemResult, WorkItem } from "./api.js";
import { assertValidationError } from "./isolate.js";
import type { IsolationStrategy } from "./isolate.js";

export interface FlakyRecoveryOutcome {
  strategy: IsolationStrategy;
  completed: ItemResult[];
  /** Ids the strategy tried as singletons and gave up on as bad. */
  givenUp: number[];
  calls: number;
  inputTokens: number;
  elapsedMs: number;
}

export async function runFlakyRecovery(
  api: SimulatedApi,
  clock: { now(): number },
  items: readonly WorkItem[],
  strategy: IsolationStrategy,
  maxRetries = 3,
): Promise<FlakyRecoveryOutcome> {
  const before = api.snapshot();
  const startedAt = clock.now();
  const completed: ItemResult[] = [];
  const givenUp: number[] = [];
  const attemptBudget = maxRetries + 1;

  const attempt = async (slice: readonly WorkItem[]): Promise<boolean> => {
    try {
      completed.push(...(await api.call(slice)));
      return true;
    } catch (error) {
      assertValidationError(error);
      return false;
    }
  };

  if (items.length > 0) {
    switch (strategy) {
      case "fail-all":
        await attempt(items);
        break;
      case "retry-whole": {
        for (let n = 0; n < attemptBudget; n++) {
          if (await attempt(items)) break;
        }
        break;
      }
      case "one-by-one": {
        if (!(await attempt(items))) {
          for (const item of items) {
            let done = false;
            for (let n = 0; n < attemptBudget && !done; n++) {
              done = await attempt([item]);
            }
            if (!done) givenUp.push(item.id);
          }
        }
        break;
      }
      case "bisect": {
        const recurse = async (slice: readonly WorkItem[]): Promise<void> => {
          if (await attempt(slice)) return;
          if (slice.length === 1) {
            for (let extra = 0; extra < maxRetries; extra++) {
              if (await attempt(slice)) return;
            }
            givenUp.push(slice[0]!.id);
            return;
          }
          const mid = Math.ceil(slice.length / 2);
          await recurse(slice.slice(0, mid));
          await recurse(slice.slice(mid));
        };
        await recurse(items);
        break;
      }
    }
  }

  const after = api.snapshot();
  return {
    strategy,
    completed,
    givenUp,
    calls: after.calls - before.calls,
    inputTokens: after.inputTokens - before.inputTokens,
    elapsedMs: clock.now() - startedAt,
  };
}
