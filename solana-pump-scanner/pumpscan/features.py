"""Features for the buy/skip decision.

Every feature here is computed from ``TokenTimeline.observable_at(...)`` and
nothing else.  That single restriction is what separates a backtest you can
trust from one that flatters you, so the extraction function does not even
accept a raw event list - it takes the timeline and the decision age, and does
its own slicing.

The features are grouped by the question they try to answer:

  flow        is money arriving, and how fast?
  breadth     is it many wallets or a few wearing hats?
  timing      did it arrive in a co-ordinated burst (bots) or organically?
  dev         how much does the creator hold, and did they start selling?
  history     has this creator wallet done this before, and how did it end?

The historical group is the one that needs care: it must only see launches that
had already *concluded* before this token existed.  ``CreatorHistory`` enforces
that; see its docstring.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from statistics import mean, pstdev

from .curve import LAMPORTS_PER_SOL, state_from_reserves
from .models import EventType
from .reconstruct import TokenTimeline

# Feature vector order is fixed and public: the model, the report and the
# rule-based strategy all index into it by name via FEATURE_NAMES.
FEATURE_NAMES: list[str] = [
    # flow
    "n_trades", "n_buys", "n_sells", "buy_ratio",
    "sol_in", "sol_out", "net_inflow", "inflow_rate",
    "max_buy", "mean_buy",
    # breadth
    "unique_traders", "unique_buyers", "buyer_repeat_ratio", "buyer_concentration",
    # timing
    "time_to_first_trade", "burst_1s", "burst_3s", "trade_rate", "gap_cv",
    # price / curve
    "price_change", "curve_progress", "market_cap_sol",
    # dev
    "dev_buy_sol", "dev_share", "dev_sold", "dev_sold_frac",
    # history
    "creator_launches", "creator_rug_rate", "creator_median_peak", "creator_is_new",
]


@dataclass
class CreatorHistory:
    """Causal record of what each creator wallet has done before.

    The trap this avoids: computing "this dev rugs 80% of the time" from the
    full dataset means the number is partly derived from the very token you are
    about to score.  The model then appears to predict rugs brilliantly and
    collapses in production.

    Usage is therefore strictly ordered - walk tokens oldest-first, call
    ``features_for`` to score, then ``record`` once the outcome is known.  A
    creator's stats always reflect only strictly-earlier launches.
    """

    launches: dict[str, list[float]] = field(default_factory=dict)   # creator -> peak multiples
    rugs: dict[str, int] = field(default_factory=dict)               # creator -> rug count
    last_seen: dict[str, float] = field(default_factory=dict)

    def record(self, creator: str, created_at: float, peak_multiple: float, rugged: bool) -> None:
        if not creator:
            return
        self.launches.setdefault(creator, []).append(peak_multiple)
        if rugged:
            self.rugs[creator] = self.rugs.get(creator, 0) + 1
        self.last_seen[creator] = created_at

    def stats(self, creator: str) -> tuple[int, float, float]:
        """``(prior_launches, rug_rate, median_peak)`` from earlier launches only."""
        peaks = self.launches.get(creator, [])
        if not peaks:
            return 0, 0.0, 0.0
        n = len(peaks)
        rug_rate = self.rugs.get(creator, 0) / n
        ordered = sorted(peaks)
        median = ordered[n // 2] if n % 2 else (ordered[n // 2 - 1] + ordered[n // 2]) / 2
        return n, rug_rate, median


def _herfindahl(shares: list[float]) -> float:
    """Herfindahl concentration of buy volume across wallets, in [0, 1].

    1.0 means a single wallet supplied all the buying - the classic signature of
    a token being walked up by its own creator.  Near 0 means broad
    participation.
    """
    total = sum(shares)
    if total <= 0:
        return 0.0
    return sum((s / total) ** 2 for s in shares)


def extract(
    timeline: TokenTimeline,
    decision_age: float,
    history: CreatorHistory | None = None,
) -> dict[str, float]:
    """Feature dict for a decision taken ``decision_age`` seconds after launch.

    Reads only what the collector had received by then.
    """
    events = timeline.observable_at(decision_age)
    created = timeline.created_at
    creator = timeline.creator
    open_state = timeline.open_state()

    trades = [e for e in events if e.event_type is not EventType.CREATE]
    buys = [e for e in trades if e.event_type is EventType.BUY]
    sells = [e for e in trades if e.event_type is EventType.SELL]

    create_event = timeline.create
    dev_buy = (create_event.sol_amount if create_event else 0) / LAMPORTS_PER_SOL
    dev_tokens = create_event.token_amount if create_event else 0

    sol_in = sum(e.sol_amount for e in buys) / LAMPORTS_PER_SOL
    sol_out = sum(e.sol_amount for e in sells) / LAMPORTS_PER_SOL
    buy_sizes = [e.sol_amount / LAMPORTS_PER_SOL for e in buys]

    # Latest curve state we had actually received.
    state = open_state
    for e in reversed(events):
        if e.virtual_sol and e.virtual_tokens:
            state = state_from_reserves(e.virtual_sol, e.virtual_tokens)
            break

    buyers: dict[str, float] = {}
    for e in buys:
        if e.trader:
            buyers[e.trader] = buyers.get(e.trader, 0.0) + e.sol_amount / LAMPORTS_PER_SOL

    ages = [e.block_time - created for e in trades]
    gaps = [b - a for a, b in zip(ages, ages[1:])] if len(ages) > 1 else []

    # Dev exit: tokens the creator has sold back, relative to what they bought.
    dev_sold_tokens = sum(e.token_amount for e in sells if e.trader == creator and creator)
    dev_sold_frac = (dev_sold_tokens / dev_tokens) if dev_tokens > 0 else 0.0

    n_prior, rug_rate, median_peak = (history.stats(creator) if history else (0, 0.0, 0.0))

    f: dict[str, float] = {
        "n_trades": float(len(trades)),
        "n_buys": float(len(buys)),
        "n_sells": float(len(sells)),
        "buy_ratio": len(buys) / len(trades) if trades else 0.0,
        "sol_in": sol_in,
        "sol_out": sol_out,
        "net_inflow": sol_in - sol_out,
        "inflow_rate": (sol_in - sol_out) / decision_age if decision_age > 0 else 0.0,
        "max_buy": max(buy_sizes) if buy_sizes else 0.0,
        "mean_buy": mean(buy_sizes) if buy_sizes else 0.0,

        "unique_traders": float(len({e.trader for e in trades if e.trader})),
        "unique_buyers": float(len(buyers)),
        # >1 means wallets are buying repeatedly; combined with high
        # concentration it is a strong tell for a self-funded pump.
        "buyer_repeat_ratio": len(buys) / len(buyers) if buyers else 0.0,
        "buyer_concentration": _herfindahl(list(buyers.values())),

        "time_to_first_trade": ages[0] if ages else decision_age,
        "burst_1s": float(sum(1 for a in ages if a <= 1.0)),
        "burst_3s": float(sum(1 for a in ages if a <= 3.0)),
        "trade_rate": len(trades) / decision_age if decision_age > 0 else 0.0,
        # Coefficient of variation of inter-trade gaps.  Bot bundles fire at
        # near-constant spacing (low CV); humans arrive in clumps (high CV).
        "gap_cv": (pstdev(gaps) / mean(gaps)) if len(gaps) > 1 and mean(gaps) > 0 else 0.0,

        "price_change": (state.price_sol / open_state.price_sol) if open_state.price_sol else 1.0,
        "curve_progress": state.progress,
        "market_cap_sol": state.market_cap_sol,

        "dev_buy_sol": dev_buy,
        "dev_share": (dev_tokens / (dev_tokens + sum(e.token_amount for e in buys))) if (dev_tokens + sum(e.token_amount for e in buys)) > 0 else 0.0,
        "dev_sold": 1.0 if dev_sold_tokens > 0 else 0.0,
        "dev_sold_frac": min(1.0, dev_sold_frac),

        "creator_launches": float(n_prior),
        "creator_rug_rate": rug_rate,
        "creator_median_peak": median_peak,
        "creator_is_new": 1.0 if n_prior == 0 else 0.0,
    }

    # Guard against NaN/inf reaching a model, which turns a training run into a
    # silent garbage-in problem rather than a loud crash.
    for k, v in f.items():
        if not math.isfinite(v):
            f[k] = 0.0
    return f


def to_vector(features: dict[str, float]) -> list[float]:
    """Dict -> fixed-order list, for anything that wants a matrix."""
    return [features.get(name, 0.0) for name in FEATURE_NAMES]
