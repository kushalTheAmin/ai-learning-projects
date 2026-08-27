/**
 * Renders the experiment report as the fixed-width text `main.ts` prints.
 * Kept out of the entry point so tests can assert on the rendering without
 * running the experiment twice.
 */

import type { ExperimentReport } from "./experiment.js";
import { PRICING } from "./messages.js";

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

function money(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function renderReport(report: ExperimentReport): string {
  const taskCount = report.perPolicy[0]?.tasks ?? 0;
  const lines: string[] = [];
  lines.push(`agent tool loop: policy comparison over ${taskCount} tasks`);
  lines.push(
    `(scripted model, virtual clock; token estimate ~4 chars/token, priced at ` +
      `$${PRICING.inputPerMTok}/M in, $${PRICING.outputPerMTok}/M out)`,
  );
  lines.push("");
  lines.push(
    `policy    ok     model  wasted  tool   tokens-in  tokens-out  cost     mean-ms  p95-ms`,
  );
  for (const p of report.perPolicy) {
    lines.push(
      `${p.policy.padEnd(8)}${pad(`${p.completed}/${p.tasks}`, 6)}` +
        `${pad(p.modelCalls, 7)}${pad(p.wastedModelCalls, 8)}${pad(p.toolCalls, 7)}` +
        `${pad(p.tokensIn, 11)}${pad(p.tokensOut, 12)}${pad(money(p.costUsd), 9)}` +
        `${pad(Math.round(p.meanTaskMs), 9)}${pad(Math.round(p.p95TaskMs), 8)}`,
    );
  }
  lines.push("");
  for (const p of report.perPolicy) {
    const reasons = Object.entries(p.failReasons)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`${p.policy.padEnd(8)} failures: ${reasons === "" ? "none" : reasons}`);
  }
  lines.push("");
  lines.push("what malformed args cost (guarded policy, per task vs its clean twin):");
  lines.push(`group           tasks  ok  extra-model-calls  extra-tokens  extra-cost  extra-ms`);
  for (const row of report.flawCosts) {
    lines.push(
      `${row.group.padEnd(15)}${pad(row.tasks, 5)}${pad(row.completed, 4)}` +
        `${pad(row.meanExtraModelCalls.toFixed(1), 19)}${pad(Math.round(row.meanExtraTokens), 14)}` +
        `${pad(money(row.meanExtraCostUsd), 12)}${pad(Math.round(row.meanExtraMs), 10)}`,
    );
  }
  lines.push("");
  const s = report.stubborn;
  lines.push(`stubborn model (${s.tasks} tasks that never correct):`);
  lines.push(
    `  feedback policy burns ${s.feedbackModelCalls} model calls / ${s.feedbackTokens} tokens ` +
      `(${money(s.feedbackCostUsd)}) before giving up`,
  );
  lines.push(
    `  guarded  policy burns ${s.guardedModelCalls} model calls / ${s.guardedTokens} tokens ` +
      `(${money(s.guardedCostUsd)}) - loop guard aborts at the 3rd identical invalid call`,
  );
  const savedTokens = s.feedbackTokens - s.guardedTokens;
  const savedPct = (100 * savedTokens) / s.feedbackTokens;
  lines.push(`  saved: ${savedTokens} tokens (${savedPct.toFixed(1)}%) on those tasks`);
  return lines.join("\n");
}
