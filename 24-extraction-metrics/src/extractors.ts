/**
 * Scripted extractor family. Each one takes a gold invoice and emits the JSON
 * a flawed extraction model would: the flaw class and its rate are authored,
 * seeded, and known, so the metrics can be judged against ground truth about
 * which extractor is actually better.
 *
 * The semantic quality ordering, by construction:
 *   perfect = format-drift = shuffler (all facts right)
 *   > tax-bungler (one field wrong)  > lazy / dropper (facts missing)
 *   > hallucinator (facts invented)  > corruptor (facts wrong)
 */

import { createRng, randInt, type Rng } from "../../05-token-streaming/src/rng.js";
import type { JsonObject, JsonValue } from "./json.js";
import { isObject, isPrimitive } from "./json.js";
import type { Invoice } from "./dataset.js";

export interface Extractor {
  name: string;
  /** What the flaw is, for the report. */
  flaw: string;
  run: (invoice: Invoice, rng: Rng) => JsonValue;
}

function clone(invoice: Invoice): JsonObject {
  return structuredClone(invoice) as unknown as JsonObject;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const CURRENCY_SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CAD: "$" };

function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

function moneyString(n: number, currency: string): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const [whole, frac] = abs.toFixed(2).split(".") as [string, string];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${CURRENCY_SYMBOL[currency] ?? "$"}${sign}${grouped}.${frac}`;
}

/** Swap two adjacent characters, codepoint-safe. Strings shorter than 2 gain an "x". */
function typo(s: string, rng: Rng): string {
  const chars = Array.from(s);
  if (chars.length < 2) return s + "x";
  const i = randInt(rng, 0, chars.length - 2);
  const tmp = chars[i] as string;
  chars[i] = chars[i + 1] as string;
  chars[i + 1] = tmp;
  return chars.join("");
}

function seededShuffle<T>(items: T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Drop leaf-valued object keys with probability p, anywhere in the tree. */
function dropLeaves(value: JsonValue, p: number, rng: Rng): JsonValue {
  if (isPrimitive(value)) return value;
  if (Array.isArray(value)) return value.map((v) => dropLeaves(v, p, rng));
  const out: JsonObject = {};
  for (const key of Object.keys(value)) {
    const child = value[key] as JsonValue;
    if (isPrimitive(child)) {
      if (rng() >= p) out[key] = child;
    } else {
      out[key] = dropLeaves(child, p, rng);
    }
  }
  return out;
}

/** Corrupt leaf values with probability p; types are preserved, content is not. */
function corruptLeaves(value: JsonValue, p: number, rng: Rng): JsonValue {
  if (isPrimitive(value)) {
    if (value === null || typeof value === "boolean" || rng() >= p) return value;
    if (typeof value === "number") {
      return value === 0 ? randInt(rng, 1, 9) : Math.round(value * (1 + 0.1 * randInt(rng, 1, 5)) * 100) / 100;
    }
    return typo(value, rng);
  }
  if (Array.isArray(value)) return value.map((v) => corruptLeaves(v, p, rng));
  const out: JsonObject = {};
  for (const key of Object.keys(value)) {
    out[key] = corruptLeaves(value[key] as JsonValue, p, rng);
  }
  return out;
}

export const EXTRACTORS: Extractor[] = [
  {
    name: "perfect",
    flaw: "none",
    run: (invoice) => clone(invoice),
  },
  {
    name: "format-drift",
    flaw: "every fact right, surface forms changed: pretty dates, currency strings, stringified qty, shouted vendor, padded descriptions",
    run: (invoice) => {
      const out = clone(invoice);
      out.date = prettyDate(invoice.date);
      (out.vendor as JsonObject).name = invoice.vendor.name.toUpperCase();
      out.line_items = invoice.line_items.map((it) => ({
        description: `  ${it.description}  `,
        qty: String(it.qty),
        unit_price: moneyString(it.unit_price, invoice.currency),
        total: moneyString(it.total, invoice.currency),
      }));
      out.totals = {
        subtotal: moneyString(invoice.totals.subtotal, invoice.currency),
        tax: moneyString(invoice.totals.tax, invoice.currency),
        total: moneyString(invoice.totals.total, invoice.currency),
      };
      return out;
    },
  },
  {
    name: "shuffler",
    flaw: "line items emitted in a different order, every value intact",
    run: (invoice, rng) => {
      const out = clone(invoice);
      out.line_items = seededShuffle(invoice.line_items, rng) as unknown as JsonValue[];
      return out;
    },
  },
  {
    name: "tax-bungler",
    flaw: "totals.tax always wrong, everything else perfect",
    run: (invoice) => {
      const out = clone(invoice);
      (out.totals as JsonObject).tax = Math.round((invoice.totals.tax * 2 + 1) * 100) / 100;
      return out;
    },
  },
  {
    name: "lazy",
    flaw: "stops reading: only the first 2 line items survive",
    run: (invoice) => {
      const out = clone(invoice);
      out.line_items = (out.line_items as JsonValue[]).slice(0, 2);
      return out;
    },
  },
  {
    name: "dropper",
    flaw: "each leaf field independently missing with p=0.25",
    run: (invoice, rng) => dropLeaves(clone(invoice), 0.25, rng),
  },
  {
    name: "hallucinator",
    flaw: "invents fields the document never had: po_number, vat id, per-item skus, one extra line item",
    run: (invoice, rng) => {
      const out = clone(invoice);
      out.po_number = `PO-${randInt(rng, 10000, 99999)}`;
      (out.vendor as JsonObject).vat_id = `VAT${randInt(rng, 100000, 999999)}`;
      out.line_items = invoice.line_items.map((it) => ({ ...it, sku: `SKU-${randInt(rng, 1000, 9999)}` }));
      const fee = randInt(rng, 5, 40);
      (out.line_items as JsonValue[]).push({
        description: "Handling fee",
        qty: 1,
        unit_price: fee,
        total: fee,
        sku: `SKU-${randInt(rng, 1000, 9999)}`,
      });
      return out;
    },
  },
  {
    name: "corruptor",
    flaw: "each leaf independently wrong with p=0.3: numbers scaled, strings typoed",
    run: (invoice, rng) => corruptLeaves(clone(invoice), 0.3, rng),
  },
];

/** One rng per (extractor, record) so records are independent and reordering-safe. */
export function extractorRng(baseSeed: number, extractorIndex: number, recordIndex: number): Rng {
  return createRng(baseSeed + extractorIndex * 1000 + recordIndex);
}
