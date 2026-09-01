/**
 * Entry point for the direction study: prints the cast under the lean
 * statistic, the authored-bonus sweep at both noise levels, and the
 * bonus-against-gap suppression map.
 */

import { GAP_PAIR_COUNT, runDirectionStudy } from "./direction-study.js";
import { CORE_COUNT } from "./dataset.js";

const result = runDirectionStudy();

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function num(value: number, digits = 3): string {
  return value.toFixed(digits);
}

console.log(`direction study  (seed ${result.seed})`);
console.log(
  `${CORE_COUNT} core pairs for the cast and the sweep; ` +
    `${GAP_PAIR_COUNT} pairs per gap set for the suppression map`,
);

console.log("\n== the cast: flip rate vs position lean (both-order calls) ==");
console.log(
  `${pad("judge", 12)}${pad("flip rate", 11)}${pad("toward-1st", 12)}${pad("toward-2nd", 12)}` +
    `${pad("first-win", 11)}${pad("lean", 8)}`,
);
for (const row of result.cast) {
  const s = row.stats;
  console.log(
    `${pad(row.judge, 12)}${pad(num(s.flipRate), 11)}${pad(num(s.towardFirstRate), 12)}` +
      `${pad(num(s.towardSecondRate), 12)}${pad(num(s.firstWinRate), 11)}` +
      `${pad(num(s.positionLean, 3), 8)}`,
  );
}

for (const sweep of result.sweeps) {
  console.log(
    `\n== authored bonus vs measured lean, noise sigma ${sweep.noiseSigma} ==`,
  );
  console.log(`${pad("bonus", 8)}${pad("flip rate", 11)}${pad("lean", 8)}`);
  for (const row of sweep.rows) {
    console.log(
      `${pad(num(row.bonus, 2), 8)}${pad(num(row.flipRate), 11)}${pad(num(row.positionLean), 8)}`,
    );
  }
}

console.log(
  "\n== challenger win rate, champion-first, truth 0.500 (rows: bonus, cols: exact gap) ==",
);
const header = result.suppression.gaps.map((g) => pad(`gap ${num(g, 2)}`, 10)).join("");
console.log(`${pad("bonus", 8)}${header}`);
for (let bi = 0; bi < result.suppression.bonuses.length; bi++) {
  const cells = result.suppression.winRates[bi]!
    .map((w) => pad(num(w), 10))
    .join("");
  console.log(`${pad(num(result.suppression.bonuses[bi]!, 2), 8)}${cells}`);
}
