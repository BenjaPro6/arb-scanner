"""A trainable scorer, validated the only way that means anything here.

The failure this module is built to prevent
-------------------------------------------
Shuffle a dataset of token launches, split it 80/20 at random, train, and
report 0.91 AUC.  The number is worthless, for two compounding reasons:

1. **Time leaks.**  A random split trains on Thursday to predict Wednesday.
   Market regimes on this venue turn over in days - a sniper meta appears, gets
   crowded, stops working.  A model that has seen the future of its own test
   set is scored on a world that no longer exists by the time you deploy.
2. **Wallets leak.**  The same creator launches dozens of tokens.  Split
   randomly and the same dev appears on both sides, so the model memorises
   wallets rather than learning behaviour, and looks brilliant right up until
   it meets a wallet it has never seen - which, live, is every wallet.

So the only validation offered here is walk-forward: sort by launch time, train
on everything before a cut, predict strictly after it, advance the cut.  Every
score a backtest consumes is out-of-sample in the one direction that matters.

There is no ``fit_predict_all`` convenience function, deliberately.  If it
existed someone would call it, and the resulting numbers would be beautiful and
false.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..features import FEATURE_NAMES, to_vector
from .base import Decision, Strategy

# A trade must clear costs to count as a win.  Below this it is noise wearing a
# profit's clothes: fees, priority bid and slippage eat anything smaller.
DEFAULT_PROFIT_THRESHOLD = 1.30


@dataclass
class Sample:
    """One training row: what we knew, and what happened next."""

    mint: str
    created_at: float
    features: dict[str, float]
    realizable_multiple: float
    peak_multiple: float = 1.0
    rugged: bool = False

    def label(self, threshold: float = DEFAULT_PROFIT_THRESHOLD) -> int:
        return int(self.realizable_multiple >= threshold)


@dataclass
class WalkForwardResult:
    """Out-of-sample scores plus the diagnostics needed to judge them."""

    scores: dict[str, float] = field(default_factory=dict)
    fold_auc: list[float] = field(default_factory=list)
    fold_sizes: list[tuple[int, int]] = field(default_factory=list)
    positive_rate: float = 0.0
    n_scored: int = 0
    feature_importance: dict[str, float] = field(default_factory=dict)

    @property
    def mean_auc(self) -> float:
        return float(np.mean(self.fold_auc)) if self.fold_auc else 0.5


def _auc(y_true: np.ndarray, y_score: np.ndarray) -> float:
    """Rank-based AUC; 0.5 when a fold is single-class and AUC is undefined."""
    pos, neg = y_true == 1, y_true == 0
    if not pos.any() or not neg.any():
        return 0.5
    order = np.argsort(y_score)
    ranks = np.empty(len(y_score), dtype=float)
    ranks[order] = np.arange(1, len(y_score) + 1)
    # Average ranks within ties so identical scores cannot be credited as if
    # the model had separated them.
    _, inverse, counts = np.unique(y_score, return_inverse=True, return_counts=True)
    sums = np.zeros(len(counts))
    np.add.at(sums, inverse, ranks)
    ranks = (sums / counts)[inverse]
    n_pos, n_neg = int(pos.sum()), int(neg.sum())
    return float((ranks[pos].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def walk_forward(
    samples: list[Sample],
    n_folds: int = 5,
    profit_threshold: float = DEFAULT_PROFIT_THRESHOLD,
    min_train: int = 60,
    seed: int = 0,
) -> WalkForwardResult:
    """Score every sample using a model that only ever saw earlier ones.

    Samples are sorted by launch time; the first ``min_train`` are used to seed
    the first model and are left unscored.  Refusing to score them is the
    point: there was no honest way to have an opinion about them yet, and
    filling the gap with an in-sample score would poison the whole backtest.
    """
    from sklearn.ensemble import GradientBoostingClassifier

    ordered = sorted(samples, key=lambda s: s.created_at)
    result = WalkForwardResult()
    if len(ordered) <= min_train:
        return result

    y_all = np.array([s.label(profit_threshold) for s in ordered])
    result.positive_rate = float(y_all.mean())

    X_all = np.array([to_vector(s.features) for s in ordered], dtype=float)

    # Fold boundaries over the post-seed region.
    start = min_train
    remaining = len(ordered) - start
    if remaining < n_folds:
        n_folds = max(1, remaining)
    edges = [start + round(i * remaining / n_folds) for i in range(n_folds + 1)]

    importances = np.zeros(len(FEATURE_NAMES))
    n_models = 0

    for i in range(n_folds):
        train_end, test_end = edges[i], edges[i + 1]
        if test_end <= train_end:
            continue
        X_train, y_train = X_all[:train_end], y_all[:train_end]
        X_test, y_test = X_all[train_end:test_end], y_all[train_end:test_end]

        if len(np.unique(y_train)) < 2:
            # Cannot fit a classifier on one class; abstain rather than guess.
            for s in ordered[train_end:test_end]:
                result.scores[s.mint] = 0.0
            continue

        model = GradientBoostingClassifier(
            n_estimators=150, max_depth=3, learning_rate=0.05,
            subsample=0.8, random_state=seed,
        )
        model.fit(X_train, y_train)
        probs = model.predict_proba(X_test)[:, 1]

        for s, p in zip(ordered[train_end:test_end], probs):
            result.scores[s.mint] = float(p)

        result.fold_auc.append(_auc(y_test, probs))
        result.fold_sizes.append((train_end, test_end - train_end))
        importances += model.feature_importances_
        n_models += 1

    if n_models:
        importances /= n_models
        result.feature_importance = dict(zip(FEATURE_NAMES, importances.tolist()))
    result.n_scored = len(result.scores)
    return result


class ModelStrategy(Strategy):
    """Trades a precomputed table of out-of-sample scores.

    Taking scores as a lookup rather than holding a live model is what makes
    the leak impossible: ``walk_forward`` is the only thing that can produce
    them, and it cannot produce one without having trained on earlier data
    alone.  A token with no score is one no honest model had an opinion about,
    and it is skipped.
    """

    name = "model"

    def __init__(self, scores: dict[str, float], threshold: float = 0.5, size_sol: float = 0.25):
        self.scores = scores
        self.threshold = threshold
        self.size_sol = size_sol

    def decide(self, features: dict[str, float], mint: str = "") -> Decision:
        score = self.scores.get(mint)
        if score is None:
            return Decision(enter=False, score=0.0, reason="unscored")
        if score < self.threshold:
            return Decision(enter=False, score=score, reason="below_threshold")
        return Decision(enter=True, score=score, size_sol=self.size_sol, reason="model")


def build_samples(timelines, decision_age: float = 10.0, policy=None, position_sol: float = 0.25) -> list[Sample]:
    """Feature/label rows in launch order, with causal creator history.

    History is updated only after each token is featurised, so a creator's
    record at decision time contains strictly earlier launches.
    """
    from ..features import CreatorHistory, extract
    from ..label import label

    history = CreatorHistory()
    samples: list[Sample] = []
    for tl in sorted(timelines, key=lambda t: t.created_at):
        features = extract(tl, decision_age, history)
        outcome = label(tl, decision_age, policy, position_sol)
        samples.append(
            Sample(
                mint=tl.mint,
                created_at=tl.created_at,
                features=features,
                realizable_multiple=outcome.realizable_multiple,
                peak_multiple=outcome.peak_multiple,
                rugged=outcome.rugged,
            )
        )
        history.record(tl.creator, tl.created_at, outcome.peak_multiple, outcome.rugged)
    return samples
