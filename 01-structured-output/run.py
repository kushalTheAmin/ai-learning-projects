"""Benchmark three parsing strategies over the scripted-LLM ticket dataset.

  strict   - json.loads only, no retry (what naive glue code does)
  lenient  - layered parse repair, still no retry
  blind    - layered parsing + retry that resends the original prompt
  full     - layered parsing + validation-feedback retry loop

blind is the control for full: ScriptedLLM replays a plan indexed by attempt
number and never reads the prompt, so the two rows are expected to tie. That
tie is the honest reading of the headline rate - it prices retrying, not
feedback.

Prints measured success rates, LLM call counts, and which repair layer or
retry rescued each failure mode.
"""
import json
from collections import Counter
from pathlib import Path

from extractor import ScriptedLLM, extract_ticket

DATA_PATH = Path(__file__).parent / "data" / "tickets.jsonl"
MAX_RETRIES = 2


def load_tickets() -> list[dict]:
    with open(DATA_PATH, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def run_strategy(tickets: list[dict], lenient: bool, max_retries: int, feedback: bool):
    llm = ScriptedLLM(tickets)
    results = [
        extract_ticket(
            llm, t, max_retries=max_retries, lenient=lenient, feedback=feedback
        )
        for t in tickets
    ]
    return results, llm.calls


def main() -> None:
    tickets = load_tickets()
    n = len(tickets)
    strategies = [
        ("strict, no retry", False, 0, True),
        ("lenient, no retry", True, 0, True),
        ("lenient + blind retry", True, MAX_RETRIES, False),
        ("lenient + feedback retry", True, MAX_RETRIES, True),
    ]

    print(f"dataset: {n} tickets, max_retries={MAX_RETRIES} for the retry strategies\n")
    print(f"{'strategy':<25} {'ok':>4} {'fail':>5} {'success':>8} {'llm calls':>10}")
    print("-" * 56)

    full_results = None
    for name, lenient, retries, feedback in strategies:
        results, calls = run_strategy(tickets, lenient, retries, feedback)
        ok = sum(r.success for r in results)
        print(f"{name:<25} {ok:>4} {n - ok:>5} {ok / n:>7.1%} {calls:>10}")
        if retries and feedback:
            full_results = results

    print(
        "\nblind is the control: the scripted model never reads the prompt, so it"
        "\nties by construction - the retry rows price retrying, not feedback"
    )

    print("\nfeedback strategy: how each first-attempt failure mode was resolved")
    print(f"{'failure mode':<16} {'count':>5}  resolution")
    print("-" * 56)
    by_mode: Counter = Counter()
    resolution: dict[str, Counter] = {}
    for ticket, result in zip(tickets, full_results):
        mode = ticket["plan"][0]
        by_mode[mode] += 1
        if not result.success:
            res = f"FAILED after {result.attempts} attempts"
        elif result.attempts == 1:
            res = f"parse layer '{result.parse_layers[0]}'"
        else:
            res = f"retry (attempt {result.attempts})"
        resolution.setdefault(mode, Counter())[res] += 1
    for mode, count in by_mode.most_common():
        detail = ", ".join(f"{c}x {r}" for r, c in resolution[mode].most_common())
        print(f"{mode:<16} {count:>5}  {detail}")

    failed = [r for r in full_results if not r.success]
    print(f"\nunrecoverable tickets: {len(failed)}")
    for r in failed:
        print(f"  {r.ticket_id}: {r.error}")


if __name__ == "__main__":
    main()
