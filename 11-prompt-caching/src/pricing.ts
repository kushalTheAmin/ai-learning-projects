/**
 * Cost model for prompt-cached requests. Multipliers follow the published
 * first-party pricing shape: cache reads bill at 0.1x the base input price,
 * cache writes at 1.25x for the 5-minute TTL and 2x for the 1-hour TTL.
 * Base prices default to a sonnet-class model ($2/MTok in, $10/MTok out)
 * and are parameters, not constants of the simulation.
 */

export const TTL_5M_MS = 5 * 60_000;
export const TTL_1H_MS = 60 * 60_000;

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
  readMultiplier: number;
  writeMultiplierByTtlMs: Readonly<Record<number, number>>;
}

export const DEFAULT_PRICING: Pricing = {
  inputPerMTok: 2,
  outputPerMTok: 10,
  readMultiplier: 0.1,
  writeMultiplierByTtlMs: { [TTL_5M_MS]: 1.25, [TTL_1H_MS]: 2 },
};

export interface BilledUsage {
  uncachedTokens: number;
  readTokens: number;
  writeTokens: number;
  writeTtlMs: number;
  outputTokens: number;
}

export function writeMultiplier(pricing: Pricing, ttlMs: number): number {
  const mult = pricing.writeMultiplierByTtlMs[ttlMs];
  if (mult === undefined) {
    throw new Error(`no write multiplier configured for ttl ${ttlMs}ms`);
  }
  return mult;
}

export function requestCost(usage: BilledUsage, pricing: Pricing = DEFAULT_PRICING): number {
  const perTok = pricing.inputPerMTok / 1e6;
  const input =
    usage.uncachedTokens * perTok +
    usage.readTokens * perTok * pricing.readMultiplier +
    usage.writeTokens * perTok * (usage.writeTokens > 0 ? writeMultiplier(pricing, usage.writeTtlMs) : 0);
  const output = usage.outputTokens * (pricing.outputPerMTok / 1e6);
  return input + output;
}

/** Input-side cost only: what the caching strategy actually moves. */
export function inputCost(usage: BilledUsage, pricing: Pricing = DEFAULT_PRICING): number {
  return requestCost({ ...usage, outputTokens: 0 }, pricing);
}
