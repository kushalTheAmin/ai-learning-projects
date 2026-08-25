import json
from pathlib import Path

from extractor.llm_sim import ScriptedLLM
from extractor.pipeline import build_prompt, build_repair_prompt, extract_ticket
from extractor.schemas import TicketExtraction

DATA_PATH = Path(__file__).parent.parent / "data" / "tickets.jsonl"

EXPECTED = {
    "category": "billing",
    "priority": "low",
    "sentiment": "neutral",
    "summary": "A billing question.",
    "product_areas": ["billing"],
}


def make_ticket(plan, id="x1", email="Can you check my invoice?"):
    return {"id": id, "email": email, "expected": EXPECTED, "plan": plan}


def load_tickets():
    with open(DATA_PATH, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


class RecordingLLM(ScriptedLLM):
    """ScriptedLLM that also keeps every prompt it receives."""

    def __init__(self, tickets):
        super().__init__(tickets)
        self.prompts = []

    def complete(self, prompt):
        self.prompts.append(prompt)
        return super().complete(prompt)


class TestExtractTicket:
    def test_clean_response_first_attempt(self):
        ticket = make_ticket(["clean"])
        result = extract_ticket(ScriptedLLM([ticket]), ticket)
        assert result.success
        assert result.attempts == 1
        assert result.parse_layers == ["strict"]
        assert isinstance(result.data, TicketExtraction)
        assert result.data.category.value == "billing"

    def test_parse_layer_recovers_without_retry(self):
        ticket = make_ticket(["markdown_fence", "clean"])
        llm = ScriptedLLM([ticket])
        result = extract_ticket(llm, ticket)
        assert result.success
        assert result.attempts == 1
        assert result.parse_layers == ["fence"]
        assert llm.calls == 1

    def test_validation_error_triggers_feedback_retry(self):
        ticket = make_ticket(["wrong_enum", "clean"])
        llm = RecordingLLM([ticket])
        result = extract_ticket(llm, ticket)
        assert result.success
        assert result.attempts == 2
        repair_prompt = llm.prompts[1]
        assert "rejected" in repair_prompt
        assert "priority" in repair_prompt  # the actual failing field is named

    def test_parse_error_triggers_feedback_retry(self):
        ticket = make_ticket(["truncated", "clean"])
        llm = RecordingLLM([ticket])
        result = extract_ticket(llm, ticket)
        assert result.success
        assert result.attempts == 2
        assert result.parse_layers == ["parse_failed", "strict"]
        assert "unparseable output" in llm.prompts[1]

    def test_hard_failure_after_max_retries(self):
        ticket = make_ticket(["truncated"])
        llm = ScriptedLLM([ticket])
        result = extract_ticket(llm, ticket, max_retries=2)
        assert not result.success
        assert result.data is None
        assert result.attempts == 3
        assert llm.calls == 3
        assert result.error is not None

    def test_max_retries_zero_means_single_call(self):
        ticket = make_ticket(["wrong_enum", "clean"])
        llm = ScriptedLLM([ticket])
        result = extract_ticket(llm, ticket, max_retries=0)
        assert not result.success
        assert llm.calls == 1

    def test_strict_mode_rejects_fenced_output(self):
        ticket = make_ticket(["markdown_fence", "markdown_fence"])
        result = extract_ticket(ScriptedLLM([ticket]), ticket, max_retries=0, lenient=False)
        assert not result.success

    def test_second_retry_used_when_first_retry_also_bad(self):
        ticket = make_ticket(["wrong_enum", "wrong_enum", "clean"])
        llm = ScriptedLLM([ticket])
        result = extract_ticket(llm, ticket, max_retries=2)
        assert result.success
        assert result.attempts == 3

    def test_python_dict_output_with_a_brace_in_a_value_costs_no_retry(self):
        # the model emits a python dict and the summary happens to contain a
        # brace - the python_literal layer handles that for free, it must not
        # burn an llm call
        expected = {**EXPECTED, "summary": "Export fails when a filter ends with }."}
        ticket = {"id": "x2", "email": "export is broken", "expected": expected,
                  "plan": ["single_quotes", "clean"]}
        llm = ScriptedLLM([ticket])
        result = extract_ticket(llm, ticket)
        assert result.success
        assert result.attempts == 1
        assert result.parse_layers == ["python_literal"]
        assert llm.calls == 1

    def test_empty_email_ticket_still_flows(self):
        ticket = make_ticket(["clean"], email="")
        result = extract_ticket(ScriptedLLM([ticket]), ticket)
        assert result.success

    def test_prompts_contain_schema_and_ticket(self):
        ticket = make_ticket(["clean"])
        prompt = build_prompt(ticket)
        assert "Ticket ID: x1" in prompt
        assert ticket["email"] in prompt
        assert '"category"' in prompt
        repair = build_repair_prompt(ticket, "{bad", "not valid JSON")
        assert "{bad" in repair and "not valid JSON" in repair


class TestEndToEnd:
    """Integration over the real committed dataset - exact, deterministic numbers."""

    def run_all(self, lenient, max_retries):
        tickets = load_tickets()
        llm = ScriptedLLM(tickets)
        results = [
            extract_ticket(llm, t, max_retries=max_retries, lenient=lenient)
            for t in tickets
        ]
        return results, llm.calls

    def test_strict_no_retry_success_rate(self):
        results, calls = self.run_all(lenient=False, max_retries=0)
        assert sum(r.success for r in results) == 6
        assert calls == 30

    def test_lenient_no_retry_success_rate(self):
        results, calls = self.run_all(lenient=True, max_retries=0)
        assert sum(r.success for r in results) == 18
        assert calls == 30

    def test_full_pipeline_success_rate_and_cost(self):
        results, calls = self.run_all(lenient=True, max_retries=2)
        assert sum(r.success for r in results) == 29
        assert calls == 44

    def test_only_permanent_truncation_fails(self):
        results, _ = self.run_all(lenient=True, max_retries=2)
        failed = [r for r in results if not r.success]
        assert [r.ticket_id for r in failed] == ["t27"]

    def test_every_success_is_fully_validated(self):
        results, _ = self.run_all(lenient=True, max_retries=2)
        for r in results:
            if r.success:
                assert isinstance(r.data, TicketExtraction)
            else:
                assert r.data is None

    def test_unicode_ticket_roundtrips(self):
        tickets = load_tickets()
        t16 = next(t for t in tickets if t["id"] == "t16")
        result = extract_ticket(ScriptedLLM([t16]), t16)
        assert result.success
        assert result.data.summary == t16["expected"]["summary"]
