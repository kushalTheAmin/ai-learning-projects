/**
 * Entry point. Prints every headline number the readme quotes:
 *   1. PII span detection precision/recall/f1, per type, with the luhn and
 *      entropy ablations that show what each check buys.
 *   2. Prompt-injection scoring as a ranker: baseline (raw text) vs hardened
 *      (de-obfuscation + base64 decode), ROC-AUC and per-category detection.
 *   3. The layered pipeline end to end: input gate + canary + output
 *      redaction, baseline vs hardened, attacks stopped and benign cost.
 *
 * Everything is deterministic. Run with `npm start`.
 */

import { loadPiiCorpus, loadPrompts } from "./dataset.js";
import { evalInjection, evalPii } from "./report.js";
import { runPipeline, type PipelineConfig } from "./pipeline.js";
import type { PiiType } from "./pii.js";

const PII_PATH = "data/pii-corpus.json";
const PROMPTS_PATH = "data/prompts.json";
const THRESHOLD = 3;

const PII_ORDER: readonly PiiType[] = ["EMAIL", "PHONE", "SSN", "CARD", "IP", "SECRET"];

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function section(title: string): void {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

function main(): void {
  const corpus = loadPiiCorpus(PII_PATH);
  const prompts = loadPrompts(PROMPTS_PATH);

  section("1. PII SPAN DETECTION (exact start/end/type match)");
  const goldSpans = corpus.reduce((n, item) => n + item.spans.length, 0);
  console.log(`corpus: ${corpus.length} messages, ${goldSpans} gold spans`);
  const base = evalPii(corpus);
  console.log(
    `\noverall  P ${base.overall.precision.toFixed(3)}  R ${base.overall.recall.toFixed(3)}  ` +
      `F1 ${base.overall.f1.toFixed(3)}  (tp ${base.overall.tp}, fp ${base.overall.fp}, fn ${base.overall.fn})`,
  );
  console.log("\nper type:");
  console.log("  type     tp  fp  fn   precision  recall");
  for (const type of PII_ORDER) {
    const s = base.perType.get(type);
    if (s === undefined) continue;
    console.log(
      `  ${type.padEnd(7)} ${String(s.tp).padStart(3)} ${String(s.fp).padStart(3)} ` +
        `${String(s.fn).padStart(3)}    ${s.precision.toFixed(3)}     ${s.recall.toFixed(3)}`,
    );
  }
  const luhnOff = evalPii(corpus, { luhn: false });
  const entropyOff = evalPii(corpus, { entropyThreshold: 0 });
  console.log("\nablations (what each check buys, precision):");
  console.log(`  all checks on      P ${base.overall.precision.toFixed(3)}  (fp ${base.overall.fp})`);
  console.log(
    `  luhn OFF           P ${luhnOff.overall.precision.toFixed(3)}  (fp ${luhnOff.overall.fp}) ` +
      `- a valid-prefix reference number is now flagged as a card`,
  );
  console.log(
    `  entropy gate OFF   P ${entropyOff.overall.precision.toFixed(3)}  (fp ${entropyOff.overall.fp}) ` +
      `- a low-entropy placeholder is now flagged as a secret`,
  );

  section("2. PROMPT INJECTION SCORING (attacks vs benign, as a ranker)");
  const attacks = prompts.filter((p) => p.kind === "attack").length;
  const benign = prompts.filter((p) => p.kind === "benign").length;
  console.log(`prompts: ${attacks} attacks, ${benign} benign  |  block threshold = score >= ${THRESHOLD}`);
  const baseline = evalInjection(prompts, { normalize: false, decodeBase64: false }, THRESHOLD);
  const hardened = evalInjection(prompts, { normalize: true, decodeBase64: true }, THRESHOLD);
  console.log(`\nROC-AUC (attack score ranks above benign):`);
  console.log(`  baseline (raw lowercased text)         ${baseline.auc.toFixed(3)}`);
  console.log(`  hardened (de-obfuscate + decode base64) ${hardened.auc.toFixed(3)}`);
  const blocked = (e: typeof baseline): number => e.attackScores.filter((s) => s >= THRESHOLD).length;
  const wrong = (e: typeof baseline): number => e.benignScores.filter((s) => s >= THRESHOLD).length;
  console.log(`\nat threshold ${THRESHOLD}:`);
  console.log(`  baseline  ${blocked(baseline)}/${attacks} attacks flagged, ${wrong(baseline)}/${benign} benign wrongly flagged`);
  console.log(`  hardened  ${blocked(hardened)}/${attacks} attacks flagged, ${wrong(hardened)}/${benign} benign wrongly flagged`);
  console.log("\nper-category detection (fraction of attacks flagged at threshold):");
  console.log("  category         baseline   hardened");
  const cats = new Set([...baseline.categoryDetection.keys()]);
  for (const cat of cats) {
    const b = baseline.categoryDetection.get(cat);
    const h = hardened.categoryDetection.get(cat);
    if (b === undefined || h === undefined) continue;
    console.log(
      `  ${cat.padEnd(15)}  ${b.flagged}/${b.total}=${pct(b.flagged / b.total).padStart(6)}   ` +
        `${h.flagged}/${h.total}=${pct(h.flagged / h.total).padStart(6)}`,
    );
  }

  section("3. LAYERED PIPELINE END TO END (input gate + canary + redaction)");
  const configs: PipelineConfig[] = [
    {
      name: "baseline",
      inputFilter: true,
      inputThreshold: THRESHOLD,
      outputFilter: true,
      scoring: { normalize: false, decodeBase64: false },
    },
    {
      name: "hardened",
      inputFilter: true,
      inputThreshold: THRESHOLD,
      outputFilter: true,
      scoring: { normalize: true, decodeBase64: true },
    },
  ];
  for (const config of configs) {
    const summary = runPipeline(prompts, config);
    const a = summary.attacks;
    const b = summary.benign;
    console.log(`\n[${config.name}]`);
    console.log(
      `  attacks: ${a.total} total  ->  ${a.blockedAtInput} blocked at input, ` +
        `${a.refusedByModel} refused by model, ${a.caughtByCanary} caught by output canary, ` +
        `${a.leakedUndetected} leaked undetected`,
    );
    console.log(
      `  benign:  ${b.total} total  ->  ${b.wronglyBlocked} wrongly blocked, ` +
        `${b.answered} answered, ${b.piiSpansRedacted} PII spans scrubbed from output`,
    );
  }
  console.log(
    "\nthe residual undetected leak in both configs is the paraphrased system-prompt",
  );
  console.log(
    "leak: it carries no canary token, so a substring check cannot see it. that is",
  );
  console.log("the limit of string-level output filtering, not a tuning miss.\n");
}

main();
