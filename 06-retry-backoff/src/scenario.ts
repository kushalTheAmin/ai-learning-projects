/**
 * Runs one policy through one traffic scenario: fresh simulation, fresh
 * server, N clients with per-client seeded RNGs, run to completion, summarize.
 * Everything is derived from the scenario seed, so a run is reproducible
 * bit-for-bit.
 */
import { createRng } from "../../05-token-streaming/src/rng.js";
import { startClient, type ClientResult } from "./client.js";
import { summarize, type ScenarioMetrics } from "./metrics.js";
import type { RetryPolicy } from "./policies.js";
import { TokenBucketServer, type ServerOptions } from "./server.js";
import { Simulation } from "./sim.js";

export interface Scenario {
  name: string;
  clients: number;
  /** Client i starts at startSpreadSec * i / clients (0 = all at once). */
  startSpreadSec: number;
  maxAttempts: number;
  server: ServerOptions;
  seed: number;
}

export interface ScenarioRun {
  metrics: ScenarioMetrics;
  results: ClientResult[];
  server: TokenBucketServer;
}

export function runScenario(scenario: Scenario, policy: RetryPolicy): ScenarioRun {
  const sim = new Simulation();
  const server = new TokenBucketServer(sim, scenario.server);
  const results: ClientResult[] = [];
  for (let i = 0; i < scenario.clients; i++) {
    startClient(
      sim,
      server,
      {
        id: i,
        startTimeSec:
          scenario.clients > 0 ? (scenario.startSpreadSec * i) / scenario.clients : 0,
        maxAttempts: scenario.maxAttempts,
        policy,
        rng: createRng(scenario.seed * 100_003 + i),
      },
      (result) => results.push(result),
    );
  }
  sim.run();
  return { metrics: summarize(policy.name, results, server, scenario.server.ratePerSec), results, server };
}
