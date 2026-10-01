/**
 * Holds the readme's account of the entropy gate to what the gate does.
 *
 * The gate is empirical Shannon entropy in bits per character, so it is
 * bounded above by log2(distinct characters). That bound is what the readme
 * got backwards: it named a git sha as the gate's false-positive risk, and a
 * hex token tops out at exactly the gate's own threshold, so every realistic
 * one is a reject. The direction the gate really errs is recall, at the
 * candidate regex's own 20 character floor, and the corpus cannot show it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { entropyBitsPerChar } from "../src/checks.js";
import { loadPiiCorpus } from "../src/dataset.js";
import { DEFAULT_ENTROPY_THRESHOLD, detectPii } from "../src/pii.js";
import { entropyGateProbe, FLOOR_BASE, GATE_TOKENS } from "../src/report.js";

const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
const corpus = loadPiiCorpus(fileURLToPath(new URL("../data/pii-corpus.json", import.meta.url)));
const probe = entropyGateProbe(corpus);

const GIT_SHA = "9f2a7c1e4b8d0a3f6e5c2b9d8a7f6e5c4b3a2d1f";
const MD5 = "d41d8cd98f00b204e9800998ecf8427e";

describe("the gate is bounded by its alphabet, not by randomness", () => {
  it("tops a hex token out at exactly the gate's threshold", () => {
    const balanced = "0123456789abcdef".repeat(2);
    expect(entropyBitsPerChar(balanced)).toBeCloseTo(4, 12);
    expect(DEFAULT_ENTROPY_THRESHOLD).toBe(4);
    expect(probe.hexCeiling).toBeCloseTo(4, 12);
  });

  it("puts a real git sha and a real md5 below the gate", () => {
    expect(entropyBitsPerChar(GIT_SHA)).toBeCloseTo(3.928, 3);
    expect(entropyBitsPerChar(MD5)).toBeCloseTo(3.391, 3);
    for (const bits of [entropyBitsPerChar(GIT_SHA), entropyBitsPerChar(MD5)]) {
      expect(bits).toBeLessThan(DEFAULT_ENTROPY_THRESHOLD);
    }
  });

  it("so a git sha is a reject, not the false positive the readme named", () => {
    expect(detectPii(`deploy ${GIT_SHA} to prod`)).toEqual([]);
    expect(detectPii(`checksum ${MD5} for the blob`)).toEqual([]);
    // only an impossible gate lets them through, which is what "below" means
    expect(detectPii(`deploy ${GIT_SHA} to prod`, { entropyThreshold: 0 }).map((s) => s.type)).toEqual([
      "SECRET",
    ]);
  });
});

describe("the cost the ablation does not price", () => {
  it("drops a 20 char token once four of its characters repeat", () => {
    expect(new Set(FLOOR_BASE).size).toBe(20);
    const bits = probe.atFloor.map((r) => Number(r.bits.toFixed(3)));
    expect(bits).toEqual([4.322, 4.222, 4.122, 4.022, 3.922]);
    expect(probe.atFloor.map((r) => r.clearsGate)).toEqual([true, true, true, true, false]);
  });

  it("measures the floor rows against the real detector, not against arithmetic", () => {
    for (const row of probe.atFloor) {
      const found = detectPii(`token ${row.token} rotates`).some((s) => s.type === "SECRET");
      expect(found).toBe(row.clearsGate);
    }
  });

  it("rests the whole measured gain on one gold secret of all-distinct characters", () => {
    expect(probe.goldPrefixless).toHaveLength(1);
    const gold = probe.goldPrefixless[0];
    expect(gold?.length).toBe(32);
    expect(gold?.distinct).toBe(32);
    expect(gold?.bits).toBeCloseTo(5, 12);
  });

  it("keeps the published precision ablation exactly where it was", () => {
    expect(GATE_TOKENS.map((t) => t.label)).toEqual(["40 char git sha", "32 char md5 digest"]);
    expect(probe.threshold).toBe(4);
  });
});

describe("the readme says what the gate does", () => {
  it("no longer calls a git sha a false positive the gate would produce", () => {
    expect(README).not.toMatch(/a git sha is high entropy and not a secret/);
    expect(README).not.toMatch(/false-positive floor/);
  });

  it("names the alphabet ceiling and the direction the gate errs", () => {
    expect(README).toMatch(/log2\(distinct characters\)/);
    expect(README).toMatch(/3\.928/);
    expect(README).toMatch(/3\.391/);
    expect(README).toMatch(/3\.922/);
  });

  it("says the ablation prices only the precision side", () => {
    expect(README).toMatch(/recall/i);
    expect(README).toMatch(/32 distinct characters/);
  });
});
