/**
 * Weighted-rule prompt injection scoring. Rules are lowercase regexes over
 * either the raw lowercased text (baseline) or the de-obfuscated form from
 * normalize.ts (hardened). Base64 blobs in the raw text are decoded and
 * rescanned, so an encoded "ignore previous instructions" still scores.
 *
 * The score is the sum of distinct rule weights that fired; a rule counts
 * once no matter how many times it matches.
 */

import { normalizeForMatching } from "./normalize.js";

export type RuleCategory =
  | "override"
  | "exfiltration"
  | "hijack"
  | "smuggling"
  | "encoding";

export interface Rule {
  id: string;
  category: RuleCategory;
  weight: number;
  re: RegExp;
}

export interface RuleHit {
  ruleId: string;
  category: RuleCategory;
  weight: number;
  excerpt: string;
  via: "text" | "base64";
}

export interface InjectionScore {
  score: number;
  hits: RuleHit[];
}

export const RULES: readonly Rule[] = [
  {
    id: "override.ignore-instructions",
    category: "override",
    weight: 3,
    re: /\b(?:ignore|disregard|forget|drop)\b[^.!?\n]{0,50}?\b(?:previous|prior|above|earlier|original|all)\b[^.!?\n]{0,50}?\b(?:instructions?|rules?|prompts?|guidelines?|directives?)\b/,
  },
  {
    id: "override.supersede",
    category: "override",
    weight: 3,
    re: /\b(?:this message|the following|these instructions|my message)\b[^.!?\n]{0,40}?\b(?:overrides?|supersedes?|replaces?|takes? priority over)\b[^.!?\n]{0,40}?\b(?:instructions?|rules?|prompts?|configuration)\b/,
  },
  {
    id: "exfiltration.system-prompt",
    category: "exfiltration",
    weight: 3,
    re: /\b(?:reveal|show|print|repeat|output|display|share|paste|recite)\b[^.!?\n]{0,50}?\b(?:system|initial|hidden|original|secret|internal)\b[^.!?\n]{0,30}?\b(?:prompt|instructions?|message|rules?|configuration)\b/,
  },
  {
    id: "exfiltration.ask-instructions",
    category: "exfiltration",
    weight: 2,
    re: /\bwhat\b[^.!?\n]{0,30}?\b(?:are|were)\b[^.!?\n]{0,30}?\byour\b[^.!?\n]{0,30}?\b(?:instructions|rules|guidelines|system prompt)\b/,
  },
  {
    id: "hijack.new-identity",
    category: "hijack",
    weight: 2,
    re: /\byou are (?:now|no longer)\b/,
  },
  {
    id: "hijack.no-rules-roleplay",
    category: "hijack",
    weight: 3,
    re: /\b(?:pretend|imagine|act as if|behave as if|roleplay)\b[^.!?\n]{0,60}?\b(?:no (?:rules|restrictions|guidelines|filters)|unrestricted|without (?:any )?(?:rules|restrictions|filters|limits))\b/,
  },
  {
    id: "hijack.developer-mode",
    category: "hijack",
    weight: 3,
    re: /\b(?:developer mode|dan mode|jailbreak(?:ed|ing)? mode|god mode)\b/,
  },
  {
    id: "smuggling.role-tag",
    category: "smuggling",
    weight: 3,
    re: /(?:^|\n)\s*(?:system|assistant)\s*:/,
  },
  {
    id: "smuggling.chat-template",
    category: "smuggling",
    weight: 4,
    re: /<\|im_start\|>|\[\/?(?:inst|sys)\]|<<\/?sys>>/,
  },
  {
    id: "smuggling.markdown-system",
    category: "smuggling",
    weight: 2,
    re: /(?:^|\n)#{1,4}\s*(?:system|new instructions)\b/,
  },
];

const BASE64_CANDIDATE_RE = /[A-Za-z0-9+/]{24,}={0,2}/g;

function decodePrintableBase64(candidate: string): string | undefined {
  let buf: Buffer;
  try {
    buf = Buffer.from(candidate, "base64");
  } catch {
    return undefined;
  }
  if (buf.length < 12) return undefined;
  const text = buf.toString("utf8");
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127)) printable++;
  }
  return printable / [...text].length >= 0.9 ? text : undefined;
}

function runRules(target: string, via: RuleHit["via"], hits: RuleHit[]): void {
  for (const rule of RULES) {
    if (hits.some((h) => h.ruleId === rule.id)) continue;
    const m = rule.re.exec(target);
    if (m === null) continue;
    hits.push({
      ruleId: rule.id,
      category: rule.category,
      weight: rule.weight,
      excerpt: m[0].slice(0, 60),
      via,
    });
  }
}

export interface ScoreOptions {
  /** run normalize.ts de-obfuscation before matching (default true) */
  normalize?: boolean;
  /** decode base64 blobs and rescan their contents (default true) */
  decodeBase64?: boolean;
}

export function scoreInjection(text: string, opts: ScoreOptions = {}): InjectionScore {
  const normalize = opts.normalize ?? true;
  const decodeBase64 = opts.decodeBase64 ?? true;
  const hits: RuleHit[] = [];
  const target = normalize ? normalizeForMatching(text) : text.toLowerCase();
  runRules(target, "text", hits);
  if (decodeBase64) {
    for (const m of text.matchAll(BASE64_CANDIDATE_RE)) {
      const decoded = decodePrintableBase64(m[0]);
      if (decoded === undefined) continue;
      const innerBefore = hits.length;
      const innerTarget = normalize ? normalizeForMatching(decoded) : decoded.toLowerCase();
      runRules(innerTarget, "base64", hits);
      if (hits.length > innerBefore && !hits.some((h) => h.ruleId === "encoding.base64-payload")) {
        hits.push({
          ruleId: "encoding.base64-payload",
          category: "encoding",
          weight: 2,
          excerpt: m[0].slice(0, 24),
          via: "base64",
        });
      }
    }
  }
  return { score: hits.reduce((s, h) => s + h.weight, 0), hits };
}
