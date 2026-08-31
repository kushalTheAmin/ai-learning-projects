/**
 * Entry point for the flaky-poison study. Virtual time, seeded trials:
 * this output reproduces exactly run to run.
 */
import { DEFAULT_API_OPTIONS } from "./api.js";
import { FLAKY_STUDY, crossover, runFlakyStudy, spreadFlakyIds } from "./flaky-study.js";

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i]!)).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

const pct = (v: number) => `${v.toFixed(1)}%`;
const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);
const ms = (v: number) => `${v.toFixed(0)}ms`;

async function main(): Promise<void> {
  const cfg = FLAKY_STUDY;
  const o = DEFAULT_API_OPTIONS;
  console.log(
    `flaky poison: batch of ${cfg.batchSize}, ${cfg.trials} trials per cell, ` +
      `retry budget ${cfg.maxRetries + 1} attempts per item (seed ${cfg.seed})`,
  );
  console.log(
    `api unchanged: ${o.baseLatencyMs}ms base, ${o.promptOverheadTokens} overhead + ` +
      `${o.perItemInputTokens} in tokens per item, rejection charges input and returns nothing`,
  );
  for (const count of cfg.flakyCounts) {
    console.log(
      `flaky ids at count ${count}: [${spreadFlakyIds(cfg.batchSize, count).join(", ")}]`,
    );
  }

  const rows = await runFlakyStudy(cfg);
  console.log(`\n== recovery under flake: means over ${cfg.trials} trials ==`);
  console.log(
    table(
      [
        "flaky",
        "rate",
        "strategy",
        "1st fail",
        "calls",
        "in tokens",
        "healthy done",
        "flaky done",
        "elapsed",
      ],
      rows.map((r) => [
        String(r.flakyCount),
        r.flakeRate.toFixed(1),
        r.strategy,
        pct(r.firstCallFailedPct),
        f1(r.meanCalls),
        f1(r.meanInputTokens),
        pct(r.healthyCompletedPct),
        pct(r.flakyCompletedPct),
        ms(r.meanElapsedMs),
      ]),
    ),
  );

  console.log(`\n== bisect / one-by-one cost ratio (above 1.00: bisect loses) ==`);
  console.log(
    table(
      ["flaky", "rate", "calls ratio", "tokens ratio"],
      crossover(rows).map((r) => [
        String(r.flakyCount),
        r.flakeRate.toFixed(1),
        f2(r.callsRatio),
        f2(r.tokensRatio),
      ]),
    ),
  );
}

await main();
