"""The blind-retry control.

The project's headline row is a retry loop that feeds the validation error
back to the model, and the README credited the 96.7% to that feedback. But
`ScriptedLLM` replays a plan indexed by attempt number and never reads the
prompt, so a retry that resends the original prompt scores exactly the same.
These tests pin the control, pin that it ties, and hold the README to a claim
the harness can actually support.
"""
import io
import json
from contextlib import redirect_stdout
from pathlib import Path

from extractor.llm_sim import ScriptedLLM
from extractor.pipeline import build_prompt, extract_ticket

PROJECT = Path(__file__).parent.parent
DATA_PATH = PROJECT / "data" / "tickets.jsonl"
README = PROJECT / "README.md"

EXPECTED = {
    "category": "billing",
    "priority": "low",
    "sentiment": "neutral",
    "summary": "A billing question.",
    "product_areas": ["billing"],
}


def load_tickets():
    with open(DATA_PATH, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def readme_text() -> str:
    """Whitespace-normalized, so a line wrap cannot make a prose test pass."""
    return " ".join(README.read_text(encoding="utf-8").split())


class RecordingLLM(ScriptedLLM):
    def __init__(self, tickets):
        super().__init__(tickets)
        self.prompts = []

    def complete(self, prompt):
        self.prompts.append(prompt)
        return super().complete(prompt)


class TestTheModelNeverReadsThePrompt:
    """Why the two strategies cannot be told apart here."""

    def test_same_attempt_index_same_output_whatever_the_prompt(self):
        ticket = {"id": "x1", "email": "hi", "expected": EXPECTED,
                  "plan": ["wrong_enum", "clean"]}
        base = build_prompt(ticket)
        repair = (
            f"{base}\n\nYour previous response was rejected:\n{{...}}\n\n"
            "Problem: field 'priority': input should be 'low', 'medium', "
            "'high' or 'urgent'\nRespond again, fixing exactly this problem."
        )
        # fresh clients so both calls sit at attempt 0
        assert ScriptedLLM([ticket]).complete(base) == ScriptedLLM([ticket]).complete(repair)

    def test_output_is_driven_by_attempt_count_alone(self):
        ticket = {"id": "x1", "email": "hi", "expected": EXPECTED,
                  "plan": ["wrong_enum", "clean"]}
        llm = ScriptedLLM([ticket])
        first = llm.complete(build_prompt(ticket))
        second = llm.complete(build_prompt(ticket))  # identical prompt, no feedback
        assert first != second
        assert json.loads(second) == EXPECTED


class TestBlindMode:
    def test_blind_mode_never_sends_a_repair_prompt(self):
        ticket = {"id": "x1", "email": "hi", "expected": EXPECTED,
                  "plan": ["wrong_enum", "clean"]}
        llm = RecordingLLM([ticket])
        result = extract_ticket(llm, ticket, max_retries=2, feedback=False)
        assert result.success
        assert result.attempts == 2
        assert len(set(llm.prompts)) == 1
        assert llm.prompts[1] == build_prompt(ticket)
        assert "rejected" not in llm.prompts[1]

    def test_feedback_mode_does_send_a_repair_prompt(self):
        ticket = {"id": "x1", "email": "hi", "expected": EXPECTED,
                  "plan": ["wrong_enum", "clean"]}
        llm = RecordingLLM([ticket])
        extract_ticket(llm, ticket, max_retries=2, feedback=True)
        assert "rejected" in llm.prompts[1]
        assert "priority" in llm.prompts[1]

    def test_blind_mode_also_withholds_parse_error_feedback(self):
        ticket = {"id": "x1", "email": "hi", "expected": EXPECTED,
                  "plan": ["truncated", "clean"]}
        llm = RecordingLLM([ticket])
        result = extract_ticket(llm, ticket, max_retries=2, feedback=False)
        assert result.success
        assert result.parse_layers == ["parse_failed", "strict"]
        assert len(set(llm.prompts)) == 1


class TestControlTiesOnTheDataset:
    def run_all(self, feedback):
        tickets = load_tickets()
        llm = ScriptedLLM(tickets)
        results = [
            extract_ticket(llm, t, max_retries=2, lenient=True, feedback=feedback)
            for t in tickets
        ]
        return results, llm.calls

    def test_blind_retry_scores_the_headline_number(self):
        results, calls = self.run_all(feedback=False)
        assert sum(r.success for r in results) == 29
        assert calls == 44

    def test_blind_and_feedback_are_identical_ticket_for_ticket(self):
        blind, blind_calls = self.run_all(feedback=False)
        fed, fed_calls = self.run_all(feedback=True)
        assert blind_calls == fed_calls
        for b, f in zip(blind, fed):
            assert b.ticket_id == f.ticket_id
            assert (b.success, b.attempts, b.parse_layers) == (
                f.success, f.attempts, f.parse_layers
            )
            assert b.data == f.data

    def test_same_single_failure_either_way(self):
        blind, _ = self.run_all(feedback=False)
        fed, _ = self.run_all(feedback=True)
        assert [r.ticket_id for r in blind if not r.success] == ["t27"]
        assert [r.ticket_id for r in fed if not r.success] == ["t27"]


class TestEntryPointPrintsTheControl:
    def test_run_py_prints_a_blind_row_that_ties(self):
        import run

        buf = io.StringIO()
        with redirect_stdout(buf):
            run.main()
        out = buf.getvalue()
        assert "lenient + blind retry" in out
        blind = [l for l in out.splitlines() if l.startswith("lenient + blind retry")]
        feedback = [l for l in out.splitlines() if l.startswith("lenient + feedback retry")]
        assert len(blind) == 1 and len(feedback) == 1
        assert blind[0].split(maxsplit=4)[4:] == feedback[0].split(maxsplit=4)[4:]
        assert "96.7%" in blind[0] and "44" in blind[0]


class TestReadmeClaims:
    def test_readme_carries_the_blind_control_row(self):
        assert "| layered parsing + blind retry (max 2) | 96.7% | 44 |" in readme_text()

    def test_readme_still_carries_the_feedback_row(self):
        assert "| layered parsing + feedback retry (max 2) | 96.7% | 44 |" in readme_text()

    def test_readme_no_longer_credits_the_rate_to_the_feedback_loop(self):
        assert "the feedback retry loop gets you to 29/30" not in readme_text()

    def test_readme_says_the_control_ties(self):
        text = readme_text()
        assert "the blind row is the control and it ties" in text
        assert "ticket for ticket" in text

    def test_readme_says_the_harness_cannot_measure_feedback(self):
        text = readme_text()
        assert "never reads the prompt" in text
        assert "nothing here measures whether it helps" in text

    def test_readme_does_not_state_convergence_as_measured(self):
        text = readme_text()
        assert "a blind retry re-rolls the same dice - a feedback retry converges" not in text
        assert "a blind retry re-rolls the same dice — a feedback retry converges" not in text
