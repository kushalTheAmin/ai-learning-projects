"""End to end over the committed golden set: run, persist, reload, compare,
gate. Pinned numbers here are exact under the fixed seeds; if any of them
moves, the pipeline's determinism broke somewhere."""

from pathlib import Path

from eval_harness.compare import compare_runs, gate_ci, gate_slice
from eval_harness.data import load_golden
from eval_harness.harness import load_run, run_eval, save_run
from eval_harness.model import BASELINE, MASKED_REGRESSION
from eval_harness.reuse import paired_bootstrap

GOLDEN_PATH = Path(__file__).resolve().parents[1] / "data" / "golden.jsonl"


class TestFullPipeline:
    def test_persisted_baseline_gates_the_masked_candidate(self, tmp_path):
        items = load_golden(GOLDEN_PATH)
        baseline = run_eval(BASELINE, items, eval_seed=11)
        save_run(baseline, tmp_path / "baseline.json")
        stored = load_run(tmp_path / "baseline.json")
        assert stored == baseline

        candidate = run_eval(MASKED_REGRESSION, items, eval_seed=12)
        comparison = compare_runs(stored, candidate, n_resamples=2000)

        # exact values under seeds (11, 12) on the committed dataset
        assert comparison.baseline_accuracy == 0.8791666666666667
        assert comparison.candidate_accuracy == 0.8375
        by_name = {c.category: c for c in comparison.categories}
        assert by_name["date"].baseline_accuracy == 0.9
        assert by_name["date"].candidate_accuracy == 0.65

        # the aggregate ci gate misses the masked regression, the slice
        # gate catches it in the date category
        assert gate_ci(comparison).passed
        verdict = gate_slice(comparison)
        assert not verdict.passed
        assert "date" in verdict.reason

    def test_noise_only_comparison_passes_ci_gate(self):
        items = load_golden(GOLDEN_PATH)
        comparison = compare_runs(
            run_eval(BASELINE, items, eval_seed=21),
            run_eval(BASELINE, items, eval_seed=22),
            n_resamples=2000,
        )
        assert gate_ci(comparison).passed

    def test_imported_bootstrap_is_02s(self):
        import retrieval_eval.bootstrap as upstream

        assert paired_bootstrap is upstream.paired_bootstrap

    def test_bootstrap_interval_behaves_on_known_input(self):
        result = paired_bootstrap([1.0] * 30, [0.0] * 30, n_resamples=500)
        assert result.diff == 1.0
        assert result.ci.lo == 1.0
        assert result.ci.hi == 1.0
        assert result.p_le_zero == 0.0
