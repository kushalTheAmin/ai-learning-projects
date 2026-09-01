import { describe, expect, it } from "vitest";

import { buildDataset } from "../src/dataset.js";
import { JUDGES, makeJudge } from "../src/judge.js";
import { runPairs } from "../src/protocols.js";
import { rate } from "../src/metrics.js";
import {
  directionStats,
  flipKind,
  judgeDirectionStats,
  measureDirections,
  type PairDirection,
} from "../src/direction.js";
import { DEFAULT_SEED } from "../src/experiment.js";

const dataset = buildDataset(DEFAULT_SEED);

describe("flipKind", () => {
  it("classifies agreement as none", () => {
    expect(flipKind({ pairId: "p", forward: "a", reverse: "a" })).toBe("none");
    expect(flipKind({ pairId: "p", forward: "b", reverse: "b" })).toBe("none");
  });

  it("both calls naming their first-presented answer is toward-first", () => {
    expect(flipKind({ pairId: "p", forward: "a", reverse: "b" })).toBe("toward-first");
  });

  it("both calls naming their second-presented answer is toward-second", () => {
    expect(flipKind({ pairId: "p", forward: "b", reverse: "a" })).toBe("toward-second");
  });
});

describe("directionStats", () => {
  it("throws on an empty set", () => {
    expect(() => directionStats([])).toThrow(/empty/);
    expect(() => measureDirections(JUDGES[0]!, [])).toThrow(/empty/);
  });

  it("handles a single pair", () => {
    const stats = directionStats([{ pairId: "p", forward: "a", reverse: "b" }]);
    expect(stats.pairs).toBe(1);
    expect(stats.flipRate).toBe(1);
    expect(stats.towardFirstRate).toBe(1);
    expect(stats.towardSecondRate).toBe(0);
    expect(stats.firstWinRate).toBe(1);
    expect(stats.positionLean).toBe(0.5);
  });

  it("an unflipped pair contributes exactly half to the first-win rate", () => {
    const consistent: PairDirection[] = [
      { pairId: "p1", forward: "a", reverse: "a" },
      { pairId: "p2", forward: "b", reverse: "b" },
    ];
    const stats = directionStats(consistent);
    expect(stats.flipRate).toBe(0);
    expect(stats.firstWinRate).toBe(0.5);
    expect(stats.positionLean).toBe(0);
  });

  it("opposite flip directions cancel out of the lean but not the flip rate", () => {
    const stats = directionStats([
      { pairId: "p1", forward: "a", reverse: "b" },
      { pairId: "p2", forward: "b", reverse: "a" },
    ]);
    expect(stats.flipRate).toBe(1);
    expect(stats.positionLean).toBe(0);
  });

  it("lean equals half the net flip direction on every cast judge", () => {
    for (const judge of JUDGES) {
      const stats = judgeDirectionStats(judge, dataset.corePairs);
      const net = (stats.towardFirstRate - stats.towardSecondRate) / 2;
      expect(stats.positionLean).toBeCloseTo(net, 12);
      expect(stats.flipRate).toBeCloseTo(
        stats.towardFirstRate + stats.towardSecondRate,
        12,
      );
    }
  });

  it("replays the both-order protocol's flip rate exactly", () => {
    for (const judge of JUDGES) {
      const protocolRun = runPairs(judge, dataset.corePairs, "both-order", DEFAULT_SEED);
      const protocolFlipRate = rate(protocolRun.verdicts, (v) => v.flipped);
      const stats = judgeDirectionStats(judge, dataset.corePairs);
      expect(stats.flipRate).toBe(protocolFlipRate);
    }
  });
});

describe("lean under authored extremes", () => {
  it("a noise-free judge with a bonus above every gap flips every pair toward-first", () => {
    const judge = makeJudge("pure-primacy", { positionBonus: 1, noiseSigma: 0 });
    const stats = judgeDirectionStats(judge, dataset.corePairs);
    expect(stats.flipRate).toBe(1);
    expect(stats.towardFirstRate).toBe(1);
    expect(stats.positionLean).toBe(0.5);
  });

  it("the mirror recency judge leans -0.5", () => {
    const judge = makeJudge("pure-recency", { positionBonus: -1, noiseSigma: 0 });
    const stats = judgeDirectionStats(judge, dataset.corePairs);
    expect(stats.towardSecondRate).toBe(1);
    expect(stats.positionLean).toBe(-0.5);
  });

  it("a noise-free unbiased judge never flips and has zero lean", () => {
    const judge = makeJudge("oracle", { noiseSigma: 0 });
    const stats = judgeDirectionStats(judge, dataset.corePairs);
    expect(stats.flipRate).toBe(0);
    expect(stats.positionLean).toBe(0);
  });
});
