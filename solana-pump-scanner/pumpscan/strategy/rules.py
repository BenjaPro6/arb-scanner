"""A hand-written baseline built from the archetypes we are trying to avoid.

Rules are worth keeping even once a model exists.  They are auditable - when a
rule declines a token you can say exactly why - and they are the honest control
for the model: a gradient booster that cannot beat eight readable thresholds
has not learned anything, it has memorised the sample.

The thresholds below are starting points calibrated on simulated data.  Refit
them on your own capture before trusting them; ``pumpscan tune`` will sweep
them for you.
"""

from __future__ import annotations

from dataclasses import dataclass

from .base import Decision, Strategy


@dataclass
class RuleThresholds:
    min_buys: int = 4
    min_unique_buyers: int = 4
    min_net_inflow: float = 1.5           # SOL
    max_buyer_concentration: float = 0.45  # one wallet supplying the volume
    max_buyer_repeat: float = 2.5          # same wallets buying over and over
    max_dev_share: float = 0.35            # creator holding too much of the float
    max_price_change: float = 4.0          # already ran; we would be exit liquidity
    min_price_change: float = 1.02         # no traction at all
    max_burst_1s: int = 8                  # a bot bundle, not a market
    block_dev_selling: bool = True
    max_creator_rug_rate: float = 0.5
    size_sol: float = 0.25


class RuleStrategy(Strategy):
    """Reject on any single red flag; enter otherwise.

    Framed as rejection rather than scoring on purpose.  In a population where
    the overwhelming majority of launches are worthless, the useful question is
    not "how good is this one" but "what is wrong with it" - and a single
    disqualifying flag should be enough, without a good score elsewhere voting
    it back in.
    """

    name = "rules"

    def __init__(self, thresholds: RuleThresholds | None = None):
        self.t = thresholds or RuleThresholds()

    def decide(self, features: dict[str, float], mint: str = "") -> Decision:
        t = self.t
        f = features

        checks: list[tuple[bool, str]] = [
            (f["n_buys"] < t.min_buys, "too_few_buys"),
            (f["unique_buyers"] < t.min_unique_buyers, "too_few_buyers"),
            (f["net_inflow"] < t.min_net_inflow, "weak_inflow"),
            (f["buyer_concentration"] > t.max_buyer_concentration, "concentrated_buying"),
            (f["buyer_repeat_ratio"] > t.max_buyer_repeat, "wallets_recycling"),
            (f["dev_share"] > t.max_dev_share, "dev_holds_too_much"),
            (f["price_change"] > t.max_price_change, "already_ran"),
            (f["price_change"] < t.min_price_change, "no_traction"),
            (f["burst_1s"] > t.max_burst_1s, "sniper_bundle"),
            (bool(t.block_dev_selling) and f["dev_sold"] > 0, "dev_selling"),
            (f["creator_rug_rate"] > t.max_creator_rug_rate, "creator_rugs"),
        ]

        for failed, reason in checks:
            if failed:
                return Decision(enter=False, score=0.0, reason=reason)

        # Score is only used for ranking and reporting; entry is binary.
        score = min(
            1.0,
            (f["net_inflow"] / 10.0) * 0.4
            + (f["unique_buyers"] / 20.0) * 0.4
            + (1.0 - f["buyer_concentration"]) * 0.2,
        )
        return Decision(enter=True, score=score, size_sol=t.size_sol, reason="passed")
