/**
 * Seeded traffic replay: zipf-popular intents, a phrasing per request, and
 * surface noise — greeting/tail filler and occasional adjacent-letter typos
 * — so repeats of one ask rarely repeat byte for byte, the way real support
 * traffic behaves. Fully deterministic from the seed.
 */

import { createRng, randInt, type Rng } from "../../05-token-streaming/src/rng.js";
import { INTENTS, type Intent } from "./dataset.js";

export type PhrasingClass = "canonical" | "trivial" | "paraphrase";

export interface TrafficRequest {
  text: string;
  intentId: string;
  phrasingClass: PhrasingClass;
  /** True when the typo pass actually changed the text. */
  typoed: boolean;
}

export interface TrafficConfig {
  seed: number;
  requests: number;
  /** Zipf exponent for intent popularity; larger = more skew. */
  zipfExponent: number;
  greetingProbability: number;
  tailProbability: number;
  typoProbability: number;
}

export const DEFAULT_TRAFFIC: TrafficConfig = {
  seed: 20260828,
  requests: 2000,
  zipfExponent: 1.1,
  greetingProbability: 0.5,
  tailProbability: 0.5,
  typoProbability: 0.15,
};

const GREETINGS = ["hey", "hi", "hello", "quick question"] as const;
const TAILS = ["please", "thanks", "thank you", "asap"] as const;

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[randInt(rng, 0, items.length - 1)];
  if (item === undefined) throw new Error("pick from empty list");
  return item;
}

/** Cumulative zipf distribution over a seeded shuffle of the intents. */
function zipfSampler(rng: Rng, intents: readonly Intent[], exponent: number): () => Intent {
  const shuffled = [...intents];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    const a = shuffled[i];
    const b = shuffled[j];
    if (a === undefined || b === undefined) throw new Error("shuffle out of range");
    shuffled[i] = b;
    shuffled[j] = a;
  }
  const cumulative: number[] = [];
  let total = 0;
  for (let rank = 1; rank <= shuffled.length; rank++) {
    total += 1 / Math.pow(rank, exponent);
    cumulative.push(total);
  }
  return () => {
    const draw = rng() * total;
    for (let i = 0; i < cumulative.length; i++) {
      const bound = cumulative[i];
      if (bound !== undefined && draw < bound) {
        const intent = shuffled[i];
        if (intent === undefined) throw new Error("sampler out of range");
        return intent;
      }
    }
    const last = shuffled[shuffled.length - 1];
    if (last === undefined) throw new Error("sampler on empty intents");
    return last;
  };
}

function choosePhrasing(rng: Rng, intent: Intent): { text: string; phrasingClass: PhrasingClass } {
  const roll = rng();
  if (roll < 0.35) return { text: intent.canonical, phrasingClass: "canonical" };
  if (roll < 0.7) return { text: pick(rng, intent.trivial), phrasingClass: "trivial" };
  return { text: pick(rng, intent.paraphrases), phrasingClass: "paraphrase" };
}

/** Swap two adjacent letters inside one word of length >= 4, if any. */
export function applyTypo(rng: Rng, text: string): string {
  const words = text.split(" ");
  const eligible: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word !== undefined && word.length >= 4) eligible.push(i);
  }
  if (eligible.length === 0) return text;
  const wordIndex = pick(rng, eligible);
  const word = words[wordIndex];
  if (word === undefined) return text;
  const at = randInt(rng, 0, word.length - 2);
  const swapped = word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2);
  words[wordIndex] = swapped;
  return words.join(" ");
}

export function generateTraffic(config: TrafficConfig, intents: readonly Intent[] = INTENTS): TrafficRequest[] {
  const rng = createRng(config.seed);
  const sampleIntent = zipfSampler(rng, intents, config.zipfExponent);
  const requests: TrafficRequest[] = [];
  for (let i = 0; i < config.requests; i++) {
    const intent = sampleIntent();
    const { text, phrasingClass } = choosePhrasing(rng, intent);
    let composed = text;
    if (rng() < config.greetingProbability) composed = `${pick(rng, GREETINGS)} ${composed}`;
    if (rng() < config.tailProbability) composed = `${composed} ${pick(rng, TAILS)}`;
    let typoed = false;
    if (rng() < config.typoProbability) {
      const mutated = applyTypo(rng, composed);
      typoed = mutated !== composed;
      composed = mutated;
    }
    requests.push({ text: composed, intentId: intent.id, phrasingClass, typoed });
  }
  return requests;
}
