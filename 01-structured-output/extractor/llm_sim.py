"""Deterministic stand-in for an LLM completion endpoint.

Each ticket in the dataset carries a `plan`: the failure mode the "model"
exhibits on attempt 0, attempt 1, and so on (the last entry repeats). The
corruption functions below reproduce failure shapes seen from real models:
markdown fences, chatty prose around the JSON, trailing commas, python-style
single quotes, invalid enum values, missing/extra fields, wrong types,
truncated output.

The network is what gets mocked here — the parsing, validation and retry
logic under test is the real code.
"""
import json
import re
from collections import Counter


def _clean(expected: dict) -> str:
    return json.dumps(expected, indent=2, ensure_ascii=False)


def _markdown_fence(expected: dict) -> str:
    return f"```json\n{_clean(expected)}\n```"


def _leading_prose(expected: dict) -> str:
    return (
        "Sure! I analyzed the ticket and here is the structured extraction:\n\n"
        f"{_clean(expected)}\n\n"
        "Let me know if you need anything else."
    )


def _trailing_comma(expected: dict) -> str:
    compact = json.dumps(expected, ensure_ascii=False)
    return compact[:-1] + ",}"


def _single_quotes(expected: dict) -> str:
    return repr(expected)


def _wrong_enum(expected: dict) -> str:
    return _clean({**expected, "priority": "URGENT"})


def _missing_field(expected: dict) -> str:
    return _clean({k: v for k, v in expected.items() if k != "summary"})


def _wrong_type(expected: dict) -> str:
    return _clean({**expected, "product_areas": ", ".join(expected["product_areas"])})


def _truncated(expected: dict) -> str:
    clean = _clean(expected)
    return clean[: int(len(clean) * 0.6)]


def _extra_field(expected: dict) -> str:
    return _clean(
        {**expected, "reasoning": "The customer sounds frustrated about the charge."}
    )


def _extra_wrapper(expected: dict) -> str:
    return _clean({"result": expected})


CORRUPTIONS = {
    "clean": _clean,
    "markdown_fence": _markdown_fence,
    "leading_prose": _leading_prose,
    "trailing_comma": _trailing_comma,
    "single_quotes": _single_quotes,
    "wrong_enum": _wrong_enum,
    "missing_field": _missing_field,
    "wrong_type": _wrong_type,
    "truncated": _truncated,
    "extra_field": _extra_field,
    "extra_wrapper": _extra_wrapper,
}

_TICKET_ID_RE = re.compile(r"Ticket ID: (\S+)")


class ScriptedLLM:
    """Replays each ticket's failure-mode plan, one attempt at a time."""

    def __init__(self, tickets: list[dict]):
        self._by_id = {t["id"]: t for t in tickets}
        self._attempts: Counter = Counter()
        self.calls = 0

    def complete(self, prompt: str) -> str:
        match = _TICKET_ID_RE.search(prompt)
        if not match or match.group(1) not in self._by_id:
            raise KeyError("prompt does not reference a known ticket id")
        ticket = self._by_id[match.group(1)]
        attempt = self._attempts[ticket["id"]]
        self._attempts[ticket["id"]] += 1
        self.calls += 1
        plan = ticket["plan"]
        mode = plan[min(attempt, len(plan) - 1)]
        return CORRUPTIONS[mode](ticket["expected"])
