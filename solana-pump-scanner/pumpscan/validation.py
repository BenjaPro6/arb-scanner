"""Tests that try to prove the pipeline wrong.

Everything else in this project asks "how well does the strategy do?".  This
module asks the prior question - "would this pipeline report an edge even if
there were none?" - and it is the more important one.  A backtester is a
machine for producing encouraging numbers; unless something is actively trying
to falsify them, encouraging numbers are all you will ever get.

Three checks, in increasing order of how much they can save you:

``leakage_audit``     structural.  Proves features cannot see the future, by
                      deleting the future and checking they do not change.
``permutation_test``  statistical.  Destroys the feature-outcome relationship
                      and checks the model then finds nothing.
``sample_size_check`` epistemic.  Asks whether there was ever enough data to
                      support the claim being made.

The permutation test is the one to run on real captures, because it needs no
ground truth and no simulator - only your own data.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

import numpy as np

from .features import extract
from .reconstruct import TokenTimeline

# Significance level for the permutation test.
SIGNIFICANCE = 0.05


@dataclass
class LeakageReport:
    checked: int = 0
    violations: list[tuple[str, str, float, float]] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        return not self.violations

    def summary(self) -> str:
        if self.clean:
            return f"no leakage: {self.checked} tokens, features identical with the future removed"
        lines = [f"LEAKAGE in {len(self.violations)} feature/token pairs:"]
        for mint, feature, full, truncated in self.violations[:10]:
            lines.append(f"  {mint} {feature}: full={full:.6g} truncated={truncated:.6g}")
        return "\n".join(lines)


def leakage_audit(
    timelines: list[TokenTimeline],
    decision_age: float = 10.0,
    tolerance: float = 1e-9,
) -> LeakageReport:
    """Prove no feature reads past the decision point.

    The method is blunt and therefore trustworthy: compute features on the full
    timeline, then delete every event our process had not received by the
    decision and compute them again.  If a feature is honest the two must be
    bit-identical, because the deleted events were invisible to it anyway.  Any
    difference is a feature reading the future, no matter how innocent the code
    looked.

    This is a structural proof rather than a statistical hint, and it costs one
    extra feature pass.  Run it whenever you add a feature.
    """
    report = LeakageReport()

    for tl in timelines:
        visible = tl.observable_at(decision_age)
        # A timeline containing *only* what was visible at the decision.
        truncated = TokenTimeline(mint=tl.mint, events=list(visible))
        if truncated.create is None:
            continue

        full_features = extract(tl, decision_age)
        trunc_features = extract(truncated, decision_age)
        report.checked += 1

        for name, value in full_features.items():
            other = trunc_features.get(name, 0.0)
            if abs(value - other) > tolerance:
                report.violations.append((tl.mint, name, value, other))

    return report


@dataclass
class PermutationReport:
    observed_auc: float = 0.5
    null_aucs: list[float] = field(default_factory=list)
    n_permutations: int = 0

    @property
    def null_mean(self) -> float:
        return float(np.mean(self.null_aucs)) if self.null_aucs else 0.5

    @property
    def null_p95(self) -> float:
        return float(np.percentile(self.null_aucs, 95)) if self.null_aucs else 0.5

    @property
    def p_value(self) -> float:
        """Fraction of shuffled runs that matched the real one.

        Uses the (r+1)/(n+1) convention, so the best achievable p-value with
        ``n`` permutations is ``1/(n+1)`` and never a misleading zero.
        """
        if not self.null_aucs:
            return 1.0
        at_least = sum(1 for a in self.null_aucs if a >= self.observed_auc)
        return (at_least + 1) / (len(self.null_aucs) + 1)

    @property
    def min_achievable_p(self) -> float:
        """Best p-value this many permutations can possibly produce.

        With the (r+1)/(n+1) convention, ``n`` permutations bottom out at
        ``1/(n+1)``.  Run 15 and the smallest p-value obtainable is 0.0625 -
        so a 0.05 threshold can never be met, and a test that cannot pass
        would quietly report "noise" for even a flawless signal.  Reporting
        this explicitly turns that trap into a visible precondition.
        """
        return 1.0 / (self.n_permutations + 1) if self.n_permutations else 1.0

    @property
    def verdict(self) -> str:
        """``"signal"``, ``"noise"``, or ``"inconclusive"``.

        Three outcomes rather than two, because "we did not run enough
        permutations to tell" is a real and common state, and collapsing it
        into "noise" throws away good strategies for a bookkeeping reason.
        """
        if self.n_permutations == 0:
            return "inconclusive"
        if self.min_achievable_p > SIGNIFICANCE:
            return "inconclusive"
        if self.p_value <= SIGNIFICANCE and self.observed_auc > self.null_p95:
            return "signal"
        return "noise"

    @property
    def passes(self) -> bool:
        return self.verdict == "signal"

    def summary(self) -> str:
        label = {
            "signal": "REAL SIGNAL",
            "noise": "NOT DISTINGUISHABLE FROM NOISE",
            "inconclusive": "INCONCLUSIVE",
        }[self.verdict]
        lines = [
            label,
            f"  observed AUC     : {self.observed_auc:.3f}",
            f"  shuffled AUC     : mean {self.null_mean:.3f}, 95th pct {self.null_p95:.3f} "
            f"({self.n_permutations} permutations)",
            f"  p-value          : {self.p_value:.4f}",
        ]
        if self.verdict == "inconclusive":
            need = int(round(1 / SIGNIFICANCE)) - 1
            lines.append(
                f"  -> {self.n_permutations} permutations bottom out at p={self.min_achievable_p:.4f}; "
                f"need at least {need} to reach p<={SIGNIFICANCE}"
            )
        return "\n".join(lines)


def permutation_test(
    samples: list,
    n_permutations: int = 24,
    n_folds: int = 4,
    profit_threshold: float = 1.30,
    seed: int = 0,
) -> PermutationReport:
    """Shuffle outcomes across tokens and re-run the whole modelling pipeline.

    Permuting the labels destroys any real relationship between what a token
    looked like and what it did, while leaving every other property of the data
    intact - the class balance, the feature correlations, the fold structure,
    the number of rows.  So whatever AUC the pipeline still reports is pure
    overfitting, and the spread of those runs is the bar the real result has to
    clear.

    An observed AUC of 0.85 sounds excellent until shuffled labels also score
    0.80, at which point you have measured your model's capacity to memorise,
    not the market.  That comparison is the entire point.
    """
    from .strategy.ml import Sample, walk_forward

    if len(samples) < 100:
        return PermutationReport(n_permutations=0)

    observed = walk_forward(samples, n_folds=n_folds, profit_threshold=profit_threshold, seed=seed)
    report = PermutationReport(observed_auc=observed.mean_auc, n_permutations=n_permutations)

    outcomes = [s.realizable_multiple for s in samples]
    rng = random.Random(seed)

    for i in range(n_permutations):
        shuffled = list(outcomes)
        rng.shuffle(shuffled)
        # Keep features, timestamps and ordering; swap only the futures.
        permuted = [
            Sample(
                mint=s.mint,
                created_at=s.created_at,
                features=s.features,
                realizable_multiple=m,
                peak_multiple=s.peak_multiple,
                rugged=s.rugged,
            )
            for s, m in zip(samples, shuffled)
        ]
        null = walk_forward(permuted, n_folds=n_folds, profit_threshold=profit_threshold, seed=seed + i)
        report.null_aucs.append(null.mean_auc)

    return report


@dataclass
class SampleSizeReport:
    n_tokens: int = 0
    n_winners: int = 0
    n_trades: int = 0
    warnings: list[str] = field(default_factory=list)

    @property
    def adequate(self) -> bool:
        return not self.warnings

    def summary(self) -> str:
        head = f"{self.n_tokens} tokens, {self.n_winners} winners, {self.n_trades} trades"
        if self.adequate:
            return f"sample size OK: {head}"
        return "\n".join([f"sample size concerns ({head}):"] + [f"  - {w}" for w in self.warnings])


def sample_size_check(
    samples: list,
    n_trades: int,
    profit_threshold: float = 1.30,
) -> SampleSizeReport:
    """Ask whether the data could support the claim at all.

    In a market where a few percent of launches produce nearly all the upside,
    a backtest's result is decided by a handful of rows.  Thirty winners is not
    a distribution, it is an anecdote with error bars, and no amount of careful
    modelling downstream repairs that.
    """
    winners = sum(1 for s in samples if s.realizable_multiple >= profit_threshold)
    report = SampleSizeReport(n_tokens=len(samples), n_winners=winners, n_trades=n_trades)

    if len(samples) < 500:
        report.warnings.append(
            f"only {len(samples)} tokens; collect a few thousand before believing any ranking"
        )
    if winners < 50:
        report.warnings.append(
            f"only {winners} profitable outcomes - too few to fit or trust a model on"
        )
    if n_trades < 30:
        report.warnings.append(
            f"only {n_trades} trades executed; P&L is dominated by individual outliers"
        )
    if samples and winners / len(samples) < 0.02:
        report.warnings.append(
            f"winners are {100 * winners / len(samples):.1f}% of the sample; "
            "results will hinge on a handful of rows"
        )
    return report
