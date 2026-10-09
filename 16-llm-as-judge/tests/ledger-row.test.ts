/**
 * The repo ledger's COMPLETED row for 16, held to what `npm start` prints.
 *
 * The row in ../../progress.md is the summary another project reads before
 * reusing a mechanism from here, and it quotes measured figures. Nothing
 * bound them to the harness, so the row credited order randomization with
 * 0.485 — the both-order column — for 38 days after the 2026-08-31 fix
 * found exactly that error in the readme and corrected it there, while
 * `runChampion` printed the real randomized figure, 0.440, the whole time.
 * 03, 07, 11, 14, 17, 21 and 25 grew the same drift before they were bound.
 *
 * These recompute every measured figure in the row from the same experiment
 * result `src/main.ts` prints, so the row cannot be typed stale again.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { DEFAULT_SEED, runExperiment } from "../src/experiment.js";

const result = runExperiment(DEFAULT_SEED);

/** The same formatting main.ts prints the tables with. */
const num = (value: number, digits = 3): string => value.toFixed(digits);
const usd = (value: number): string => `$${value.toFixed(2)}`;

const pointwise = (judge: string) =>
  result.pointwise.rows.find((r) => r.judge === judge)!;
const core = (judge: string) => result.core.find((r) => r.judge === judge)!;
const champion = (judge: string) => result.champion.find((r) => r.judge === judge)!;
const house = (judge: string) => result.house.find((r) => r.judge === judge)!;
const cost = (protocol: string) => result.cost.find((r) => r.protocol === protocol)!;

/** The one COMPLETED row for 16, two directories up. */
function ledgerRow(): string {
  const text = readFileSync(new URL("../../progress.md", import.meta.url), "utf-8");
  // The REVIEWED table keys its rows by project name too, so scope to the
  // COMPLETED section first or that date row comes back as a second match.
  const completed = text.split("## COMPLETED", 1 + 1)[1]!.split("\n## ", 1)[0]!;
  const rows = completed
    .split("\n")
    // the trailing pipe is what separates the base row from the
    // "| 16-llm-as-judge, direction extension |" and power extension rows
    .filter((line) => line.startsWith("| 16-llm-as-judge |"));
  expect(rows, "progress.md has no single COMPLETED row for 16").toHaveLength(1);
  return rows[0]!;
}

describe("the ledger's completed row for 16", () => {
  test("there is exactly one, and it is the base row not an extension", () => {
    const row = ledgerRow();
    expect(row.startsWith("| 16-llm-as-judge |")).toBe(true);
    expect(row).not.toContain("direction extension");
    expect(row).not.toContain("power extension");
  });

  test("row credits randomization with the randomized column, not both-order", () => {
    // The figure the 2026-08-31 readme fix moved out from under: randomizing
    // the order reaches 0.440, and 0.485 is what the second call buys.
    const primacy = champion("primacy");
    expect([num(primacy.championFirst), num(primacy.randomized), num(primacy.bothOrder)]).toEqual([
      "0.380",
      "0.440",
      "0.485",
    ]);
    const row = ledgerRow();
    expect(row).toContain(
      `drags a true 0.500 challenger to ${num(primacy.championFirst)} and randomization ` +
        `takes back half of that at no cost (${num(primacy.randomized)})`,
    );
    expect(row).toContain(`to reach ${num(primacy.bothOrder)}`);
  });

  test("row does not credit randomization with 0.485", () => {
    expect(ledgerRow()).not.toContain("randomization restores 0.485");
  });

  test("row quotes the leniency figures and the gold base rate", () => {
    const lenient = pointwise("lenient");
    const quoted = [
      num(lenient.passRate),
      num(lenient.accuracy),
      num(result.pointwise.goldPassRate),
      num(lenient.kappa),
    ];
    expect(quoted).toEqual(["0.955", "0.745", "0.700", "0.198"]);
    expect(ledgerRow()).toContain(
      `lenient passes ${quoted[0]} and still scores ${quoted[1]} accuracy on the ` +
        `${quoted[2]} base rate where kappa says ${quoted[3]}`,
    );
  });

  test("row quotes the always-pass baseline", () => {
    const alwaysPass = result.pointwise.alwaysPass;
    expect([num(alwaysPass.accuracy), num(alwaysPass.kappa)]).toEqual(["0.700", "0.000"]);
    expect(ledgerRow()).toContain(
      `(always-pass: ${num(alwaysPass.accuracy)} accuracy, kappa exactly ${num(alwaysPass.kappa)})`,
    );
  });

  test("row quotes primacy's flip rate, decided accuracy and coverage", () => {
    const primacy = core("primacy");
    const quoted = [
      num(primacy.flipRate),
      num(primacy.decidedAccuracy),
      num(primacy.coverage),
    ];
    expect(quoted).toEqual(["0.287", "1.000", "0.713"]);
    expect(ledgerRow()).toContain(
      `primacy flips ${quoted[0]} of order-swapped pairs yet is perfect (${quoted[1]}) ` +
        `on the ${quoted[2]} it decides`,
    );
  });

  test("row quotes the 2x protocol cost per 1k pairs", () => {
    const both = cost("both-order");
    const single = cost("as-stored");
    expect(both.callsPerPair / single.callsPerPair).toBe(2);
    expect([usd(both.usdPer1k), usd(single.usdPer1k)]).toEqual(["$2.53", "$1.26"]);
    expect(ledgerRow()).toContain(
      `pays 2x (${usd(both.usdPer1k)} vs ${usd(single.usdPer1k)} per 1k pairs)`,
    );
  });

  test("row quotes primacy's effective and randomized core accuracy", () => {
    const primacy = core("primacy");
    expect([num(primacy.effectiveAccuracy), num(primacy.randomizedAccuracy)]).toEqual([
      "0.857",
      "0.887",
    ]);
    expect(ledgerRow()).toContain(
      `(primacy effective ${num(primacy.effectiveAccuracy)} vs randomized ` +
        `${num(primacy.randomizedAccuracy)})`,
    );
  });

  test("row quotes self-preference surviving order debiasing", () => {
    const selfPref = house("self-pref");
    expect([num(selfPref.singleOrder), num(selfPref.bothOrder)]).toEqual(["0.600", "0.620"]);
    expect(ledgerRow()).toContain(
      `self-preference (${num(selfPref.singleOrder)}) survives order debiasing untouched ` +
        `(${num(selfPref.bothOrder)})`,
    );
  });

  test("row quotes the two modes being mutually blind", () => {
    const primacyPointwise = pointwise("primacy");
    const calibratedPointwise = pointwise("calibrated");
    expect(num(primacyPointwise.accuracy)).toBe(num(calibratedPointwise.accuracy));
    expect(num(primacyPointwise.accuracy)).toBe("0.990");
    expect(num(core("lenient").randomizedAccuracy)).toBe("1.000");
    const row = ledgerRow();
    expect(row).toContain(
      `pointwise cannot express position bias (primacy ${num(primacyPointwise.accuracy)}, ` +
        `identical to calibrated)`,
    );
    expect(row).toContain(
      `pairwise cannot express leniency (lenient ${num(core("lenient").randomizedAccuracy)} randomized)`,
    );
  });
});
