import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTasks } from "../src/tasks.js";

function writeTasks(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "tasks-"));
  const path = join(dir, "tasks.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

const validTask = {
  id: "a",
  prompt: "p",
  intents: [
    {
      call: { name: "calc", args: { op: "add", a: 1, b: 2 } },
      flawKind: "none",
      correctsAfter: 0,
    },
  ],
  finalTemplate: "result: {last}",
  expectedAnswer: "result: 3",
  fetchTransientFailures: 0,
};

describe("loadTasks", () => {
  it("loads a valid dataset and tags calls as tool_call turns", () => {
    const tasks = loadTasks(writeTasks([validTask]));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.intents[0]!.call.type).toBe("tool_call");
  });

  it("accepts an empty dataset", () => {
    expect(loadTasks(writeTasks([]))).toEqual([]);
  });

  it("rejects a flawed intent with no flawedCall", () => {
    const bad = {
      ...validTask,
      intents: [{ ...validTask.intents[0], flawKind: "wrong-type" }],
    };
    expect(() => loadTasks(writeTasks([bad]))).toThrow();
  });

  it("rejects a clean intent that carries a flawedCall", () => {
    const bad = {
      ...validTask,
      intents: [
        {
          ...validTask.intents[0],
          flawedCall: { name: "calc", args: {} },
        },
      ],
    };
    expect(() => loadTasks(writeTasks([bad]))).toThrow();
  });

  it("rejects duplicate task ids", () => {
    expect(() => loadTasks(writeTasks([validTask, validTask]))).toThrow(/duplicate task id/);
  });

  it("rejects unknown keys in a task", () => {
    expect(() => loadTasks(writeTasks([{ ...validTask, extra: true }]))).toThrow();
  });

  it("rejects a negative fetchTransientFailures", () => {
    expect(() => loadTasks(writeTasks([{ ...validTask, fetchTransientFailures: -1 }]))).toThrow();
  });

  it("rejects malformed json", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-"));
    const path = join(dir, "tasks.json");
    writeFileSync(path, "{not json");
    expect(() => loadTasks(path)).toThrow();
  });
});
