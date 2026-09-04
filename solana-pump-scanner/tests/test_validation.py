"""The falsification tests.

Everything else checks that the pipeline computes what it claims.  These check
the harder thing: that it does not report an edge when there is none.
"""

from pumpscan.reconstruct import iter_timelines
from pumpscan.sources.simulator import SimConfig, Simulator
from pumpscan.strategy.ml import build_samples, walk_forward
from pumpscan.validation import (
    SIGNIFICANCE,
    permutation_test,
    sample_size_check,
)


def _samples(n=800, seed=17, signal=1.0):
    sim = Simulator(SimConfig(n_tokens=n, seed=seed, signal_strength=signal))
    return build_samples(list(iter_timelines(sim.generate())), 10.0)


def test_shuffled_outcomes_yield_no_signal():
    """The central guarantee.

    Permute which token got which future and the model must land on chance.
    If this ever fails, the pipeline is capable of manufacturing an edge from
    noise, and every backtest it has produced is void.
    """
    report = permutation_test(_samples(), n_permutations=8, n_folds=3)
    assert report.null_mean < 0.60, (
        f"shuffled labels scored AUC {report.null_mean:.3f}; the pipeline is "
        "finding structure that cannot exist"
    )
    assert report.null_p95 < 0.70


def test_a_learnable_market_is_detected():
    """The complement: the test must not be blind to signal that is really there."""
    report = permutation_test(_samples(signal=1.0), n_permutations=8, n_folds=3)
    assert report.observed_auc > report.null_p95


def test_too_few_permutations_is_inconclusive_not_negative():
    """A test that cannot pass must say so rather than report failure.

    With the (r+1)/(n+1) convention, n permutations bottom out at 1/(n+1).  Run
    too few and p<=0.05 is unreachable, so a flawless signal would be labelled
    noise - throwing away a good strategy for a bookkeeping reason.
    """
    report = permutation_test(_samples(), n_permutations=5, n_folds=3)
    assert report.min_achievable_p > SIGNIFICANCE
    assert report.verdict == "inconclusive"
    assert "need at least" in report.summary()


def test_p_value_is_never_zero():
    """Zero would claim more certainty than any finite permutation count gives."""
    report = permutation_test(_samples(), n_permutations=6, n_folds=3)
    assert report.p_value >= 1 / (report.n_permutations + 1)


def test_walk_forward_never_scores_its_own_training_block():
    samples = _samples(n=400, seed=5)
    wf = walk_forward(samples, n_folds=4, min_train=100)
    ordered = sorted(samples, key=lambda s: s.created_at)
    # The seed block is deliberately left without an opinion.
    for s in ordered[:100]:
        assert s.mint not in wf.scores
    assert wf.n_scored == len(ordered) - 100


def test_walk_forward_is_reproducible():
    samples = _samples(n=400, seed=5)
    a = walk_forward(samples, n_folds=3, seed=1)
    b = walk_forward(samples, n_folds=3, seed=1)
    assert a.scores == b.scores
    assert a.fold_auc == b.fold_auc


def test_sample_size_check_flags_thin_data():
    report = sample_size_check(_samples(n=150, seed=3), n_trades=12)
    assert not report.adequate
    assert any("tokens" in w for w in report.warnings)
    assert any("trades" in w for w in report.warnings)


def test_auc_handles_ties_and_single_class():
    """A degenerate fold must score 0.5, not crash or flatter the model."""
    import numpy as np

    from pumpscan.validation import permutation_test  # noqa: F401  (import path check)
    from pumpscan.strategy.ml import _auc

    assert _auc(np.array([1, 1, 1]), np.array([0.1, 0.5, 0.9])) == 0.5
    assert _auc(np.array([0, 1]), np.array([0.5, 0.5])) == 0.5
    assert _auc(np.array([0, 1]), np.array([0.1, 0.9])) == 1.0
    assert _auc(np.array([1, 0]), np.array([0.1, 0.9])) == 0.0
