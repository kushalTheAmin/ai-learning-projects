import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";
import { detectPii } from "../src/pii.js";

describe("redact", () => {
  it("replaces a span with a typed placeholder", () => {
    const text = "mail a@b.com now";
    const result = redact(text, detectPii(text));
    expect(result.redacted).toBe("mail [EMAIL_1] now");
    expect(result.spansReplaced).toBe(1);
    expect(result.placeholders.get("[EMAIL_1]")).toBe("a@b.com");
  });

  it("gives the same value one stable placeholder", () => {
    const text = "reply to a@b.com or a@b.com";
    const result = redact(text, detectPii(text));
    expect(result.redacted).toBe("reply to [EMAIL_1] or [EMAIL_1]");
    expect(result.spansReplaced).toBe(2);
    expect(result.placeholders.size).toBe(1);
  });

  it("numbers distinct values of a type in order", () => {
    const text = "cc a@b.com and c@d.com";
    const result = redact(text, detectPii(text));
    expect(result.redacted).toBe("cc [EMAIL_1] and [EMAIL_2]");
  });

  it("numbers types independently", () => {
    const text = "a@b.com card 4111111111111111";
    const result = redact(text, detectPii(text));
    expect(result.redacted).toBe("[EMAIL_1] card [CARD_1]");
  });

  it("returns the text unchanged when there is nothing to redact", () => {
    expect(redact("nothing here", []).redacted).toBe("nothing here");
    expect(redact("nothing here", []).spansReplaced).toBe(0);
  });
});
