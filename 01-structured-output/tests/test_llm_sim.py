import json
from pathlib import Path

import pytest

from extractor.llm_sim import CORRUPTIONS, ScriptedLLM
from extractor.schemas import TicketExtraction

DATA_PATH = Path(__file__).parent.parent / "data" / "tickets.jsonl"

EXPECTED = {
    "category": "bug",
    "priority": "high",
    "sentiment": "negative",
    "summary": "Something broke.",
    "product_areas": ["api"],
}


def load_tickets():
    with open(DATA_PATH, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


class TestCorruptions:
    def test_clean_is_valid(self):
        obj = json.loads(CORRUPTIONS["clean"](EXPECTED))
        TicketExtraction.model_validate(obj)

    def test_markdown_fence_wraps_json(self):
        out = CORRUPTIONS["markdown_fence"](EXPECTED)
        assert out.startswith("```json") and out.endswith("```")
        with pytest.raises(json.JSONDecodeError):
            json.loads(out)

    def test_leading_prose_not_directly_parseable(self):
        with pytest.raises(json.JSONDecodeError):
            json.loads(CORRUPTIONS["leading_prose"](EXPECTED))

    def test_trailing_comma_invalid_json(self):
        out = CORRUPTIONS["trailing_comma"](EXPECTED)
        assert out.endswith(",}")
        with pytest.raises(json.JSONDecodeError):
            json.loads(out)

    def test_single_quotes_invalid_json(self):
        with pytest.raises(json.JSONDecodeError):
            json.loads(CORRUPTIONS["single_quotes"](EXPECTED))

    def test_truncated_invalid_json(self):
        with pytest.raises(json.JSONDecodeError):
            json.loads(CORRUPTIONS["truncated"](EXPECTED))

    def test_schema_violations_parse_but_fail_validation(self):
        from pydantic import ValidationError

        for mode in ["wrong_enum", "missing_field", "wrong_type", "extra_field", "extra_wrapper"]:
            obj = json.loads(CORRUPTIONS[mode](EXPECTED))
            with pytest.raises(ValidationError):
                TicketExtraction.model_validate(obj)


class TestScriptedLLM:
    def test_follows_plan_across_attempts(self):
        ticket = {"id": "x1", "email": "hi", "expected": EXPECTED,
                  "plan": ["markdown_fence", "clean"]}
        llm = ScriptedLLM([ticket])
        first = llm.complete("Ticket ID: x1")
        second = llm.complete("Ticket ID: x1")
        assert first.startswith("```json")
        assert json.loads(second) == EXPECTED

    def test_last_plan_entry_repeats(self):
        ticket = {"id": "x1", "email": "hi", "expected": EXPECTED, "plan": ["truncated"]}
        llm = ScriptedLLM([ticket])
        outputs = [llm.complete("Ticket ID: x1") for _ in range(4)]
        assert len(set(outputs)) == 1

    def test_deterministic_across_instances(self):
        tickets = load_tickets()
        a, b = ScriptedLLM(tickets), ScriptedLLM(tickets)
        for t in tickets:
            assert a.complete(f"Ticket ID: {t['id']}") == b.complete(f"Ticket ID: {t['id']}")

    def test_unknown_ticket_id_raises(self):
        llm = ScriptedLLM([])
        with pytest.raises(KeyError):
            llm.complete("Ticket ID: nope")

    def test_call_counter(self):
        ticket = {"id": "x1", "email": "hi", "expected": EXPECTED, "plan": ["clean"]}
        llm = ScriptedLLM([ticket])
        llm.complete("Ticket ID: x1")
        llm.complete("Ticket ID: x1")
        assert llm.calls == 2


class TestDataset:
    def test_thirty_tickets_unique_ids(self):
        tickets = load_tickets()
        assert len(tickets) == 30
        assert len({t["id"] for t in tickets}) == 30

    def test_every_expected_extraction_is_schema_valid(self):
        for t in load_tickets():
            TicketExtraction.model_validate(t["expected"])

    def test_every_plan_mode_is_known(self):
        for t in load_tickets():
            assert t["plan"], f"{t['id']} has an empty plan"
            for mode in t["plan"]:
                assert mode in CORRUPTIONS, f"{t['id']} uses unknown mode {mode}"

    def test_all_failure_modes_are_covered(self):
        first_attempt_modes = {t["plan"][0] for t in load_tickets()}
        assert first_attempt_modes == set(CORRUPTIONS)
