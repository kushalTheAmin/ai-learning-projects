"""The cost claim.

The readme's headline paragraph prices the retry loop at a 47% call overhead
and called that "the real price of reliability ... exactly the number youd
bring to a cost conversation". The overhead is 44 calls against 30 tickets and
every one of those 14 extra calls is authored: 12 of the 30 tickets carry a
plan that breaks the schema or truncates, and 10 of those 12 carry `clean` on
attempt 1 so they comply the moment the loop fires. Script the same 12 to need
a second retry and the same loop over the same tickets bills 54.

These tests compute the mix off the real pipeline and hold the readme to
reporting it, so the paragraph cannot drift back into quoting 47% as a
transferable number.
"""
import copy
import json
from pathlib import Path

from extractor.llm_sim import ScriptedLLM
from extractor.pipeline import extract_ticket

PROJECT = Path(__file__).parent.parent
DATA_PATH = PROJECT / "data" / "tickets.jsonl"
README = PROJECT / "README.md"
MAX_RETRIES = 2


def load_tickets():
    with open(DATA_PATH, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def readme_text() -> str:
    """Whitespace-normalized, so a line wrap cannot make a prose test pass."""
    return " ".join(README.read_text(encoding="utf-8").split())


def run_all(tickets, max_retries=MAX_RETRIES):
    llm = ScriptedLLM(tickets)
    results = [
        extract_ticket(llm, t, max_retries=max_retries, lenient=True, feedback=True)
        for t in tickets
    ]
    return results, llm.calls


def loop_ticket_ids(results):
    """Tickets the retry loop actually fired on."""
    return [r.ticket_id for r in results if r.attempts > 1]


class TestTheOverheadIsTheAuthoredMix:
    """Every extra call traces to a plan entry someone wrote by hand."""

    def test_the_published_overhead(self):
        tickets = load_tickets()
        results, calls = run_all(tickets)
        n = len(tickets)
        assert calls == 44 and n == 30
        assert round((calls - n) / n * 100, 1) == 46.7  # the readme's "47%"

    def test_twelve_tickets_need_the_loop_and_ten_comply_at_once(self):
        tickets = load_tickets()
        results, _ = run_all(tickets)
        assert len(loop_ticket_ids(results)) == 12
        assert sum(1 for r in results if r.attempts == 2) == 10
        assert sum(1 for r in results if r.attempts == 3) == 2

    def test_every_extra_call_is_a_loop_ticket(self):
        tickets = load_tickets()
        results, calls = run_all(tickets)
        extra = sum(r.attempts - 1 for r in results)
        assert extra == calls - len(tickets) == 14

    def test_one_more_retry_each_bills_fifty_four(self):
        """The counterfactual the readme has to name: same code, same tickets.

        Give each loop-needing ticket one more bad attempt before it complies
        and the overhead goes 47% -> 80% without a line of the pipeline
        changing. That is what makes 47% a property of the plans.
        """
        tickets = load_tickets()
        results, _ = run_all(tickets)
        loop_ids = set(loop_ticket_ids(results))
        variant = []
        for t in tickets:
            t2 = copy.deepcopy(t)
            if t["id"] in loop_ids:
                t2["plan"] = [t["plan"][0], t["plan"][0], "clean"]
            variant.append(t2)
        _, calls = run_all(variant)
        assert calls == 54
        assert round((calls - len(tickets)) / len(tickets) * 100, 1) == 80.0

    def test_the_ceiling_at_max_retries_two(self):
        tickets = load_tickets()
        _, calls = run_all([{**t, "plan": ["truncated"]} for t in tickets])
        assert calls == 90 == len(tickets) * (1 + MAX_RETRIES)


class TestReadmeStatesTheMixNotJustTheNumber:
    def test_readme_still_publishes_the_measured_overhead(self):
        assert "47% call overhead" in readme_text()

    def test_readme_does_not_sell_the_overhead_as_a_transferable_number(self):
        text = readme_text()
        assert "the real price of reliability" not in text
        assert "exactly the number youd bring to a cost conversation" not in text

    def test_readme_names_the_authored_mix_behind_the_overhead(self):
        tickets = load_tickets()
        results, _ = run_all(tickets)
        text = readme_text()
        assert f"{len(loop_ticket_ids(results))} of the {len(tickets)} tickets" in text
        assert "10 of those comply on the first retry" in text

    def test_readme_carries_the_counterfactual_and_the_ceiling(self):
        text = readme_text()
        assert "54 calls" in text and "80%" in text
        assert "90" in text

    def test_readme_hands_the_cost_question_back_to_the_reader(self):
        assert "bring your own failure distribution" in readme_text()
