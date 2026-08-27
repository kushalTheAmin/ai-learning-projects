/**
 * Dataset loading. The task file is itself zod-validated on the way in:
 * an authored dataset earns no more trust than model output, and a typo in
 * a flawed call would silently change what the experiment measures.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { CityRecord, NoteRecord } from "./tools.js";
import type { Intent, TaskSpec } from "./model.js";

const toolCallSchema = z.strictObject({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
});

const intentSchema = z
  .strictObject({
    call: toolCallSchema,
    flawKind: z.enum(["none", "wrong-type", "missing-field", "extra-field", "unknown-tool"]),
    flawedCall: toolCallSchema.optional(),
    correctsAfter: z.number().int().min(0).nullable(),
  })
  .refine((i) => i.flawKind === "none" || i.flawedCall !== undefined, {
    message: "a flawed intent needs a flawedCall",
  })
  .refine((i) => i.flawKind !== "none" || i.flawedCall === undefined, {
    message: "a clean intent must not carry a flawedCall",
  });

const taskSchema = z.strictObject({
  id: z.string().min(1),
  prompt: z.string().min(1),
  intents: z.array(intentSchema),
  finalTemplate: z.string().min(1),
  expectedAnswer: z.string().min(1),
  fetchTransientFailures: z.number().int().min(0),
});

const citySchema = z.strictObject({ name: z.string().min(1), population: z.number().int().min(0) });
const noteSchema = z.strictObject({ title: z.string().min(1), body: z.string().min(1) });

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadTasks(path: string): TaskSpec[] {
  const raw = z.array(taskSchema).parse(readJson(path));
  const ids = new Set<string>();
  for (const t of raw) {
    if (ids.has(t.id)) throw new Error(`duplicate task id: ${t.id}`);
    ids.add(t.id);
  }
  return raw.map((t) => ({
    ...t,
    intents: t.intents.map(
      (i): Intent => ({
        call: { type: "tool_call", name: i.call.name, args: i.call.args },
        flawKind: i.flawKind,
        flawedCall:
          i.flawedCall === undefined
            ? undefined
            : { type: "tool_call", name: i.flawedCall.name, args: i.flawedCall.args },
        correctsAfter: i.correctsAfter,
      }),
    ),
  }));
}

export function loadCities(path: string): CityRecord[] {
  return z.array(citySchema).parse(readJson(path));
}

export function loadNotes(path: string): NoteRecord[] {
  return z.array(noteSchema).parse(readJson(path));
}
