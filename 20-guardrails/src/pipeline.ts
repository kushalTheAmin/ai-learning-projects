/**
 * Layered guardrail pipeline: input gate (injection score threshold) ->
 * scripted model -> output gate (canary substring check + PII redaction).
 *
 * The measurement is defense in depth: what the input filter blocks, what
 * the output canary catches among attacks that got through, and what still
 * leaks (paraphrased system-prompt leaks carry no canary). Benign traffic
 * prices the other side: prompts wrongly blocked at the input gate, and PII
 * echoes scrubbed from model output.
 */

import type { PromptItem } from "./dataset.js";
import { scoreInjection, type ScoreOptions } from "./injection.js";
import { CANARY, buildSystemPrompt, scriptedModel } from "./model.js";
import { detectPii } from "./pii.js";
import { redact } from "./redact.js";

export interface PipelineConfig {
  name: string;
  inputFilter: boolean;
  inputThreshold: number;
  outputFilter: boolean;
  scoring?: ScoreOptions;
}

export interface ItemOutcome {
  id: string;
  kind: "attack" | "benign";
  category: PromptItem["category"];
  inputScore: number;
  blockedAtInput: boolean;
  modelCalled: boolean;
  canaryCaught: boolean;
  piiSpansRedacted: number;
  /** attack complied and leaked, and nothing stopped the response */
  leakedUndetected: boolean;
  finalResponse: string;
}

export interface PipelineSummary {
  config: PipelineConfig;
  attacks: {
    total: number;
    blockedAtInput: number;
    refusedByModel: number;
    caughtByCanary: number;
    leakedUndetected: number;
  };
  benign: {
    total: number;
    wronglyBlocked: number;
    answered: number;
    piiSpansRedacted: number;
  };
  outcomes: ItemOutcome[];
}

export function runPipeline(items: PromptItem[], config: PipelineConfig): PipelineSummary {
  const systemPrompt = buildSystemPrompt();
  const outcomes: ItemOutcome[] = [];
  for (const item of items) {
    const { score } = scoreInjection(item.text, config.scoring);
    const blockedAtInput = config.inputFilter && score >= config.inputThreshold;
    if (blockedAtInput) {
      outcomes.push({
        id: item.id,
        kind: item.kind,
        category: item.category,
        inputScore: score,
        blockedAtInput: true,
        modelCalled: false,
        canaryCaught: false,
        piiSpansRedacted: 0,
        leakedUndetected: false,
        finalResponse: "[blocked: input flagged as prompt injection]",
      });
      continue;
    }
    const raw = scriptedModel(item, systemPrompt);
    let canaryCaught = false;
    let piiSpansRedacted = 0;
    let finalResponse = raw;
    if (config.outputFilter) {
      if (raw.includes(CANARY)) {
        canaryCaught = true;
        finalResponse = "[blocked: response contained the system prompt canary]";
      } else {
        const spans = detectPii(raw);
        const result = redact(raw, spans);
        piiSpansRedacted = result.spansReplaced;
        finalResponse = result.redacted;
      }
    }
    const leaked =
      item.kind === "attack" &&
      item.model !== undefined &&
      item.model.complies &&
      item.model.leak !== "none";
    outcomes.push({
      id: item.id,
      kind: item.kind,
      category: item.category,
      inputScore: score,
      blockedAtInput: false,
      modelCalled: true,
      canaryCaught,
      piiSpansRedacted,
      leakedUndetected: leaked && !canaryCaught,
      finalResponse,
    });
  }
  const attacks = outcomes.filter((o) => o.kind === "attack");
  const refusedByModel = items.filter((item, i) => {
    const outcome = outcomes[i];
    return (
      item.kind === "attack" &&
      outcome !== undefined &&
      outcome.modelCalled &&
      item.model !== undefined &&
      !item.model.complies
    );
  }).length;
  const benign = outcomes.filter((o) => o.kind === "benign");
  return {
    config,
    attacks: {
      total: attacks.length,
      blockedAtInput: attacks.filter((o) => o.blockedAtInput).length,
      refusedByModel,
      caughtByCanary: attacks.filter((o) => o.canaryCaught).length,
      leakedUndetected: attacks.filter((o) => o.leakedUndetected).length,
    },
    benign: {
      total: benign.length,
      wronglyBlocked: benign.filter((o) => o.blockedAtInput).length,
      answered: benign.filter((o) => o.modelCalled).length,
      piiSpansRedacted: benign.reduce((s, o) => s + o.piiSpansRedacted, 0),
    },
    outcomes,
  };
}
