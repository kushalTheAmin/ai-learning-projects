/**
 * Entry point for the power study: null spreads and critical values per
 * detector, the detection-power grid over authored bonuses, minimal
 * detectable bonus at 80% power, and the arrangement-skew control that
 * disqualifies as-stored single calls from the race entirely.
 */

import {
  minDetectableBonus,
  runPowerStudy,
  SKEW_PAIR_COUNT,
  type DetectorTable,
} from "./power-study.js";

const result = runPowerStudy();
const { replicates, alpha, bonuses } = result.config;

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function num(value: number, digits = 3): string {
  return value.toFixed(digits);
}

function detectorLabel(table: DetectorTable): string {
  return `${table.detector} (${table.calls} calls, ${table.pairsSeen} pairs)`;
}

console.log(
  `power study  (${replicates} replicates per cell, two-sided alpha ${num(alpha, 2)}, ` +
    `thresholds calibrated on the bonus-0 null)`,
);

for (const block of result.blocks) {
  console.log(
    `\n== budget ${block.budget} calls, noise sigma ${block.noiseSigma} ==`,
  );
  console.log(
    `${pad("detector", 37)}${pad("null sd", 10)}${pad("critical", 10)}`,
  );
  for (const table of block.detectors) {
    console.log(
      `${pad(detectorLabel(table), 37)}${pad(num(table.nullSd, 4), 10)}${pad(num(table.critical, 4), 10)}`,
    );
  }
  console.log(
    `variance ratio single-equal/both-order ${num(block.varianceRatio, 1)}x ` +
      `(the call multiplier a single-call design needs to match the null spread)`,
  );
  console.log(`\n${pad("bonus", 8)}${pad("both-order", 12)}${pad("single-equal", 14)}${pad("single-half", 12)}`);
  for (let bi = 0; bi < bonuses.length; bi++) {
    const cells = block.detectors.map((table) => table.cells[bi]!);
    console.log(
      `${pad(num(bonuses[bi]!, 2), 8)}${pad(num(cells[0]!.power), 12)}` +
        `${pad(num(cells[1]!.power), 14)}${pad(num(cells[2]!.power), 12)}`,
    );
  }
  const detectable = block.detectors.map((table) => {
    const bonus = minDetectableBonus(table);
    return `${table.detector} ${bonus === null ? "none swept" : num(bonus, 2)}`;
  });
  console.log(`min bonus at 80% power: ${detectable.join(", ")}`);
}

console.log(
  `\n== arrangement-skew control: measured lean at authored bonus 0, ` +
    `${SKEW_PAIR_COUNT} pairs, truth 0.000 ==`,
);
console.log(
  `${pad("gold-in-a", 11)}${pad("as-stored", 11)}${pad("randomized", 12)}${pad("both-order", 12)}`,
);
for (const row of result.skew) {
  console.log(
    `${pad(num(row.goldInAShare, 1), 11)}${pad(num(row.asStored), 11)}` +
      `${pad(num(row.randomized), 12)}${pad(num(row.bothOrder), 12)}`,
  );
}
