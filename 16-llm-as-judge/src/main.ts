/**
 * Entry point: run the whole harness and print every table the README quotes.
 */

import {
  CHAMPION_COUNT,
  CORE_COUNT,
  GRADING_COUNT,
  HOUSE_COUNT,
  LENGTH_COUNT,
} from "./dataset.js";
import { DEFAULT_SEED, runExperiment } from "./experiment.js";

const result = runExperiment(DEFAULT_SEED);

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function num(value: number, digits = 3): string {
  return Number.isNaN(value) ? "n/a" : value.toFixed(digits);
}

console.log(`llm-as-judge harness  (seed ${result.seed})`);
console.log(
  `${GRADING_COUNT} graded answers; pairs: ${CORE_COUNT} core, ` +
    `${CHAMPION_COUNT} champion-vs-challenger, ${HOUSE_COUNT} house-vs-rival, ` +
    `${LENGTH_COUNT} short-vs-long`,
);

console.log("\n== pointwise pass/fail vs gold labels ==");
console.log(`gold pass rate ${num(result.pointwise.goldPassRate)}`);
console.log(
  `${pad("judge", 12)}${pad("pass rate", 11)}${pad("accuracy", 10)}${pad("kappa", 8)}`,
);
for (const row of [...result.pointwise.rows, result.pointwise.alwaysPass]) {
  console.log(
    `${pad(row.judge, 12)}${pad(num(row.passRate), 11)}${pad(num(row.accuracy), 10)}${pad(num(row.kappa), 8)}`,
  );
}

console.log("\n== pairwise on balanced core pairs ==");
console.log(
  `${pad("judge", 12)}${pad("as-stored", 11)}${pad("randomized", 12)}${pad("flip rate", 11)}` +
    `${pad("coverage", 10)}${pad("decided", 9)}${pad("effective", 10)}`,
);
for (const row of result.core) {
  console.log(
    `${pad(row.judge, 12)}${pad(num(row.asStoredAccuracy), 11)}${pad(num(row.randomizedAccuracy), 12)}` +
      `${pad(num(row.flipRate), 11)}${pad(num(row.coverage), 10)}${pad(num(row.decidedAccuracy), 9)}` +
      `${pad(num(row.effectiveAccuracy), 10)}`,
  );
}

console.log("\n== challenger win rate, incumbent stored in slot a (truth 0.500) ==");
console.log(
  `${pad("judge", 12)}${pad("champion-first", 16)}${pad("randomized", 12)}${pad("both-order", 12)}`,
);
for (const row of result.champion) {
  console.log(
    `${pad(row.judge, 12)}${pad(num(row.championFirst), 16)}${pad(num(row.randomized), 12)}` +
      `${pad(num(row.bothOrder), 12)}`,
  );
}

console.log("\n== house win rate, randomized order (truth 0.500) ==");
console.log(`${pad("judge", 12)}${pad("randomized", 12)}${pad("both-order", 12)}`);
for (const row of result.house) {
  console.log(
    `${pad(row.judge, 12)}${pad(num(row.singleOrder), 12)}${pad(num(row.bothOrder), 12)}`,
  );
}

console.log("\n== short vs long pairs, randomized order ==");
console.log(
  `${pad("judge", 12)}${pad("longer wins", 13)}${pad("acc long-better", 17)}${pad("acc short-better", 17)}`,
);
for (const row of result.length) {
  console.log(
    `${pad(row.judge, 12)}${pad(num(row.longerWinRate), 13)}${pad(num(row.accuracyLongerBetter), 17)}` +
      `${pad(num(row.accuracyShorterBetter), 17)}`,
  );
}

console.log("\n== protocol cost per 1000 pairs (core pair sizes) ==");
console.log(
  `${pad("protocol", 12)}${pad("calls/pair", 12)}${pad("tokens in", 11)}${pad("tokens out", 12)}${pad("usd", 8)}`,
);
for (const row of result.cost) {
  console.log(
    `${pad(row.protocol, 12)}${pad(row.callsPerPair, 12)}${pad(row.tokensInPer1k, 11)}` +
      `${pad(row.tokensOutPer1k, 12)}${pad(`$${num(row.usdPer1k, 2)}`, 8)}`,
  );
}
