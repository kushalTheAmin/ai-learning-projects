/**
 * Loop-guard keys. The exact key is the canonical (name, args) of the
 * invalid call, so it only counts verbatim repeats. The signature key
 * collapses an invalid call to the tool name plus the sorted (path, code)
 * pairs of its zod issues: two calls broken in the same way count together
 * even when their values differ. Values, messages, and the names of
 * unrecognized keys are deliberately left out - a model inventing a new
 * bogus field every round is still failing in the same way.
 */

import type { z } from "zod";
import { canonical, type ToolCallTurn } from "./messages.js";

export type GuardKeyKind = "exact" | "signature";

export function exactGuardKey(turn: ToolCallTurn): string {
  return canonical({ name: turn.name, args: turn.args });
}

export function unknownToolGuardKey(kind: GuardKeyKind, turn: ToolCallTurn): string {
  // An unknown tool has no schema, so there is no issue signature beyond
  // the name itself; the exact key still counts the args.
  if (kind === "exact") return exactGuardKey(turn);
  return `unknown-tool|${turn.name}`;
}

export function issueSignature(toolName: string, error: z.ZodError): string {
  const parts = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}:${issue.code}`;
    })
    .sort();
  return `invalid-args|${toolName}|${parts.join(",")}`;
}

export function invalidArgsGuardKey(
  kind: GuardKeyKind,
  turn: ToolCallTurn,
  error: z.ZodError,
): string {
  if (kind === "exact") return exactGuardKey(turn);
  return issueSignature(turn.name, error);
}
