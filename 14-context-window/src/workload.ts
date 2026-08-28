/**
 * Seeded generator for multi-turn ops conversations with planted facts.
 *
 * Each conversation is user/assistant exchanges of filler chatter drawn from
 * a topic phrase bank, with two kinds of planted events:
 *   - fact introductions: an assistant turn states a decision, key + value,
 *     either as a short standalone sentence or buried inside a long chatty one
 *   - probes: a later user turn asks for a fact by its key, never its value
 *
 * Values are unique nonce compounds (e.g. "vega-atlas-7") that occur exactly
 * once in the whole conversation, in the introduction sentence. The assistant
 * reply to a probe never restates the value. So "the value is present in the
 * assembled context at probe time" is a pure property of the eviction policy,
 * checkable by substring, with no second copy to muddy it.
 */

import { createRng, randInt, type Rng } from "../../05-token-streaming/src/rng.js";
import type { Turn } from "./policies.js";

export type FactClass = "standalone" | "buried";
export type LagBucket = "short" | "medium" | "long";

export interface Fact {
  key: string;
  value: string;
  cls: FactClass;
  bucket: LagBucket;
  introExchange: number;
  probeExchange: number;
  /** Probe distance in exchanges. */
  lag: number;
}

export interface Conversation {
  system: string;
  /** Alternating user/assistant, user first. turns[2e] is exchange e's user turn. */
  turns: Turn[];
  facts: Fact[];
  exchanges: number;
}

export const SYSTEM_PROMPT =
  "you are the on-call assistant for the platform team. keep answers short, " +
  "remember decisions made earlier in the conversation, and never invent values.";

const TOPICS = [
  "deploy", "rollout", "pipeline", "incident", "latency", "dashboard",
  "alert", "capacity", "migration", "cache", "queue", "retry",
  "config", "region", "cluster", "database", "traffic", "canary",
];

const FACT_KEYS = [
  "deploy target", "error budget", "rollout window", "canary fraction",
  "incident channel", "retention period", "rate cap", "cache ttl",
  "primary region", "batch size", "alert threshold", "migration date",
];

const NONCE_NAMES = [
  "mira", "orion", "vega", "lyra", "atlas", "nova", "juno", "rhea",
  "iris", "leda", "kepler", "halley", "ceres", "eris", "pavo", "corvus",
];

const FILLER_TEMPLATES = [
  "the {a} checks for the {b} service look stable today.",
  "i had another look at the {a} dashboard and nothing in the {b} numbers stands out.",
  "someone on the team asked whether the {a} work blocks the {b} cleanup.",
  "the {a} graphs moved a little after lunch but the {b} side stayed flat.",
  "we still owe a writeup on how the {a} change landed against the {b} plan.",
  "the {a} review went fine, the {b} follow-ups are queued for later.",
  "nothing new on the {a} front, the {b} alerts stayed quiet overnight.",
  "the {a} rollout notes mention the {b} path twice, worth a read.",
  "i cleaned up the {a} runbook so the {b} section reads better now.",
  "the {a} tickets are mostly closed, two {b} ones are waiting on review.",
];

const STANDALONE_TEMPLATES = [
  "decision: the {key} is {value}.",
  "we settled it, the {key} is {value}.",
  "for the record, the {key} is {value}.",
];

const BURIED_TEMPLATES = [
  "by the way i was talking with the platform folks earlier and after a lot of back and forth about what would be least disruptive we sort of ended up going with {value} for the {key}, which seemed fine to everyone in the room.",
  "oh and before i forget, there was a long thread about this yesterday and once everyone had weighed in it looks like {value} is what we are going with for the {key}, nobody pushed back in the end.",
  "one more thing from the sync earlier, it took most of the meeting but the group finally came around to {value} as the {key}, so that is where things landed for now.",
];

const PROBE_TEMPLATES = [
  "quick check, what did we land on for the {key}?",
  "remind me, what is the {key} again?",
  "before i write this up, what was the {key} we agreed on?",
];

const PROBE_ACKS = [
  "let me pull up the notes and confirm, i will follow up in a moment.",
  "checking the earlier discussion for that one, give me a second.",
];

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[randInt(rng, 0, arr.length - 1)] as T;
}

function fillerSentence(rng: Rng): string {
  const a = pick(rng, TOPICS);
  let b = pick(rng, TOPICS);
  while (b === a) b = pick(rng, TOPICS);
  return pick(rng, FILLER_TEMPLATES).replace("{a}", a).replace("{b}", b);
}

function fillerText(rng: Rng, minSentences: number, maxSentences: number): string {
  const n = randInt(rng, minSentences, maxSentences);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(fillerSentence(rng));
  return out.join(" ");
}

function makeValue(rng: Rng, used: Set<string>): string {
  for (;;) {
    const a = pick(rng, NONCE_NAMES);
    let b = pick(rng, NONCE_NAMES);
    while (b === a) b = pick(rng, NONCE_NAMES);
    const v = `${a}-${b}-${randInt(rng, 2, 9)}`;
    if (!used.has(v)) {
      used.add(v);
      return v;
    }
  }
}

const LAG_RANGES: Record<LagBucket, [number, number]> = {
  short: [1, 2],
  medium: [3, 8],
  long: [9, 20],
};

const BUCKET_CYCLE: LagBucket[] = ["short", "medium", "long"];

export interface WorkloadConfig {
  seed: number;
  exchanges: number;
  factCount: number;
}

export const DEFAULT_WORKLOAD: Omit<WorkloadConfig, "seed"> = { exchanges: 30, factCount: 12 };

/**
 * Schedule intro/probe exchange pairs: intros land on distinct assistant
 * turns, probes on distinct user turns, probe strictly after intro by the
 * bucket's lag. Seeded rejection sampling with a deterministic linear scan
 * as the fallback so generation can never spin forever.
 */
function scheduleFact(
  rng: Rng,
  bucket: LagBucket,
  exchanges: number,
  usedIntro: Set<number>,
  usedProbe: Set<number>,
): { intro: number; probe: number; lag: number } {
  const [lo, hi] = LAG_RANGES[bucket];
  const maxLag = Math.min(hi, exchanges - 1);
  for (let attempt = 0; attempt < 200; attempt++) {
    const lag = randInt(rng, lo, maxLag);
    const intro = randInt(rng, 0, exchanges - 1 - lag);
    const probe = intro + lag;
    if (!usedIntro.has(intro) && !usedProbe.has(probe)) {
      usedIntro.add(intro);
      usedProbe.add(probe);
      return { intro, probe, lag };
    }
  }
  for (let lag = lo; lag <= maxLag; lag++) {
    for (let intro = 0; intro + lag < exchanges; intro++) {
      const probe = intro + lag;
      if (!usedIntro.has(intro) && !usedProbe.has(probe)) {
        usedIntro.add(intro);
        usedProbe.add(probe);
        return { intro, probe, lag };
      }
    }
  }
  throw new Error(`no free intro/probe slot for bucket ${bucket} in ${exchanges} exchanges`);
}

export function generateConversation(config: WorkloadConfig): Conversation {
  const { seed, exchanges, factCount } = config;
  if (factCount > FACT_KEYS.length) throw new Error(`factCount ${factCount} exceeds key bank ${FACT_KEYS.length}`);
  if (2 * factCount > exchanges) throw new Error(`${factCount} facts need ${2 * factCount} event slots, only ${exchanges} exchanges`);
  const rng = createRng(seed);
  const usedValues = new Set<string>();
  const usedIntro = new Set<number>();
  const usedProbe = new Set<number>();

  const facts: Fact[] = [];
  for (let i = 0; i < factCount; i++) {
    const bucket = BUCKET_CYCLE[i % BUCKET_CYCLE.length] as LagBucket;
    const cls: FactClass = i % 2 === 0 ? "standalone" : "buried";
    const { intro, probe, lag } = scheduleFact(rng, bucket, exchanges, usedIntro, usedProbe);
    facts.push({
      key: FACT_KEYS[i] as string,
      value: makeValue(rng, usedValues),
      cls,
      bucket,
      introExchange: intro,
      probeExchange: probe,
      lag,
    });
  }

  const introAt = new Map<number, Fact>();
  const probeAt = new Map<number, Fact>();
  for (const f of facts) {
    introAt.set(f.introExchange, f);
    probeAt.set(f.probeExchange, f);
  }

  const turns: Turn[] = [];
  for (let e = 0; e < exchanges; e++) {
    const probe = probeAt.get(e);
    if (probe !== undefined) {
      turns.push({ role: "user", text: pick(rng, PROBE_TEMPLATES).replace("{key}", probe.key) });
    } else {
      turns.push({ role: "user", text: fillerText(rng, 1, 2) });
    }
    const intro = introAt.get(e);
    if (intro !== undefined) {
      const template = intro.cls === "standalone" ? pick(rng, STANDALONE_TEMPLATES) : pick(rng, BURIED_TEMPLATES);
      const factSentence = template.replace("{key}", intro.key).replace("{value}", intro.value);
      turns.push({ role: "assistant", text: `${fillerSentence(rng)} ${factSentence}` });
    } else if (probe !== undefined) {
      turns.push({ role: "assistant", text: pick(rng, PROBE_ACKS) });
    } else {
      turns.push({ role: "assistant", text: fillerText(rng, 1, 2) });
    }
  }

  const convo: Conversation = { system: SYSTEM_PROMPT, turns, facts, exchanges };
  validateConversation(convo);
  return convo;
}

/** Every fact value must appear exactly once across all turns, in its intro turn. */
export function validateConversation(convo: Conversation): void {
  const all = convo.turns.map((t) => t.text).join("\n");
  for (const f of convo.facts) {
    const count = all.split(f.value).length - 1;
    if (count !== 1) throw new Error(`fact value ${f.value} occurs ${count} times, expected exactly 1`);
    const introTurn = convo.turns[2 * f.introExchange + 1];
    if (introTurn === undefined || !introTurn.text.includes(f.value)) {
      throw new Error(`fact value ${f.value} missing from its intro turn`);
    }
  }
}

export function generateConversations(baseSeed: number, count: number, cfg = DEFAULT_WORKLOAD): Conversation[] {
  const out: Conversation[] = [];
  for (let i = 0; i < count; i++) {
    out.push(generateConversation({ seed: baseSeed + i * 7919, ...cfg }));
  }
  return out;
}
