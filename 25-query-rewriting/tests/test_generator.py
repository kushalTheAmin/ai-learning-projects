import pytest

from query_rewriting.data import load_hypotheticals
from query_rewriting.generator import GENERIC_ANSWER, Hypothetical, ScriptedHyde

BANK = {"q1": "answer one", "q2": "answer two", "q3": "answer three"}


def test_rate_zero_returns_every_query_its_own_answer():
    hyde = ScriptedHyde(BANK, hallucination_rate=0.0, seed=0)
    for query_id, text in BANK.items():
        result = hyde.generate(query_id)
        assert result == Hypothetical(text=text, hallucinated=False, source_query_id=query_id)


def test_rate_one_swaps_every_query_to_the_next_sorted_id():
    hyde = ScriptedHyde(BANK, hallucination_rate=1.0, seed=0)
    assert hyde.generate("q1") == Hypothetical("answer two", True, "q2")
    assert hyde.generate("q2") == Hypothetical("answer three", True, "q3")
    assert hyde.generate("q3") == Hypothetical("answer one", True, "q1")


def test_no_query_ever_hallucinates_its_own_answer():
    bank = load_hypotheticals()
    hyde = ScriptedHyde(bank, hallucination_rate=1.0, seed=0)
    for query_id in bank:
        assert hyde.generate(query_id).source_query_id != query_id


def test_hallucination_sets_are_nested_across_rates():
    bank = load_hypotheticals()
    previous: set[str] = set()
    for rate in (0.0, 0.1, 0.25, 0.5, 1.0):
        hyde = ScriptedHyde(bank, hallucination_rate=rate, seed=7)
        current = {q for q in bank if hyde.generate(q).hallucinated}
        assert previous <= current
        previous = current
    assert previous == set(bank)


def test_generation_is_deterministic_across_instances():
    bank = load_hypotheticals()
    a = ScriptedHyde(bank, hallucination_rate=0.5, seed=7)
    b = ScriptedHyde(bank, hallucination_rate=0.5, seed=7)
    assert [a.generate(q) for q in sorted(bank)] == [b.generate(q) for q in sorted(bank)]


def test_seed_changes_which_queries_hallucinate():
    bank = load_hypotheticals()
    a = ScriptedHyde(bank, hallucination_rate=0.5, seed=0)
    b = ScriptedHyde(bank, hallucination_rate=0.5, seed=1)
    set_a = {q for q in bank if a.generate(q).hallucinated}
    set_b = {q for q in bank if b.generate(q).hallucinated}
    assert set_a != set_b


def test_rate_out_of_range_raises():
    with pytest.raises(ValueError, match="hallucination_rate"):
        ScriptedHyde(BANK, hallucination_rate=1.5)
    with pytest.raises(ValueError, match="hallucination_rate"):
        ScriptedHyde(BANK, hallucination_rate=-0.1)


def test_single_entry_bank_raises():
    with pytest.raises(ValueError, match="at least 2"):
        ScriptedHyde({"q1": "only answer"}, hallucination_rate=0.0)


def test_unknown_query_id_raises():
    hyde = ScriptedHyde(BANK, hallucination_rate=0.0)
    with pytest.raises(KeyError, match="no authored hypothetical"):
        hyde.generate("q999")


def test_generic_answer_is_fluent_filler_with_no_subject_vocabulary():
    bank = load_hypotheticals()
    generic_words = set(GENERIC_ANSWER.split())
    for signal in ("git", "docker", "jwt", "sigkill", "asyncio", "cors", "index"):
        assert signal not in generic_words
    assert GENERIC_ANSWER not in bank.values()
