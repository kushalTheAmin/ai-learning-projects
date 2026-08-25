"""Layered parsing for LLM output that is supposed to be JSON.

Layers, cheapest first:
  1. strict        - json.loads on the raw text
  2. fence         - strip a ```json ... ``` markdown fence, then strict
  3. extract       - pull the first balanced {...} out of surrounding prose
  4. repair_commas - drop trailing commas (string-aware), then parse
  5. python_literal- ast.literal_eval for single-quoted python-dict output

Each layer only runs if the previous ones failed, and the winning layer is
reported so callers can measure which failure modes actually occur.
"""
import ast
import json
import re


class ParseError(Exception):
    """Raised when no layer can turn the text into a JSON object."""


_FENCE_RE = re.compile(r"```(?:json)?\s*\n?(.*?)\n?\s*```", re.DOTALL)


def parse_strict(text: str) -> dict:
    """json.loads, and the result must be an object (dict)."""
    try:
        obj = json.loads(text)
    except (json.JSONDecodeError, TypeError) as exc:
        raise ParseError(f"not valid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise ParseError(f"expected a JSON object, got {type(obj).__name__}")
    return obj


def strip_code_fence(text: str) -> str:
    """Return the contents of the first markdown code fence, if any."""
    match = _FENCE_RE.search(text)
    return match.group(1) if match else text


def extract_balanced_object(text: str) -> str | None:
    """Return the first balanced {...} substring, respecting quoted strings.

    Walks the text once, tracking string boundaries and escape characters so
    braces inside string values do not confuse the depth count. Both " and '
    open a string, closed by the same character that opened it: this candidate
    also feeds the python_literal layer, where values are single-quoted.
    """
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    quote = None
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if quote is not None:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def remove_trailing_commas(text: str) -> str:
    """Remove commas that directly precede } or ], skipping string contents."""
    out = []
    in_string = False
    escaped = False
    for ch in text:
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
        elif ch in "}]":
            while out and out[-1].isspace():
                out.pop()
            if out and out[-1] == ",":
                out.pop()
            out.append(ch)
        else:
            out.append(ch)
    return "".join(out)


def parse_python_literal(text: str) -> dict:
    """Parse python-dict-style output ({'key': 'value'}) safely."""
    try:
        obj = ast.literal_eval(text.strip())
    except (ValueError, SyntaxError, MemoryError, RecursionError) as exc:
        raise ParseError(f"not a python literal: {exc}") from exc
    if not isinstance(obj, dict):
        raise ParseError(f"expected a dict literal, got {type(obj).__name__}")
    return obj


def parse_lenient(text: str) -> tuple[dict, str]:
    """Try every layer in order. Returns (object, layer_name) or raises ParseError."""
    if not isinstance(text, str) or not text.strip():
        raise ParseError("empty response")

    try:
        return parse_strict(text), "strict"
    except ParseError:
        pass

    unfenced = strip_code_fence(text)
    if unfenced != text:
        try:
            return parse_strict(unfenced), "fence"
        except ParseError:
            pass

    candidate = extract_balanced_object(unfenced)
    if candidate is not None:
        try:
            return parse_strict(candidate), "extract"
        except ParseError:
            pass
        try:
            return parse_strict(remove_trailing_commas(candidate)), "repair_commas"
        except ParseError:
            pass
        try:
            return parse_python_literal(candidate), "python_literal"
        except ParseError:
            pass

    raise ParseError(
        "response contains no parseable JSON object "
        f"(first 80 chars: {text.strip()[:80]!r})"
    )
