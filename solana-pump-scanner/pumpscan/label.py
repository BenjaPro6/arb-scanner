"""What actually happened to each token, after the decision point.

This module answers "was buying this a good idea?" - and the answer it gives is
deliberately not the one that feels best.

The tempting label is the peak: "it went 8x, so it was a winner."  That label
is a lie, because nobody sells at the peak.  It is also *the* lie that ruins
sniper bots: train on peaks, and the model learns to find tokens that spike for
four seconds and round-trip to zero, which is precisely the pattern that pays
the pumper and costs you.  The peak is kept here as a diagnostic and is never
used as a training target.

The honest label is ``realizable_multiple``: what a mechanical exit rule, one
you could actually run, would have got out - reacting on a delay, selling into
the curve it is itself pushing down, paying fees on the way out.  That is the
number the strategy is scored on.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any

from .curve import LAMPORTS_PER_SOL, state_from_reserves
from .execution import ExecutionModel, ExitPolicy, attempt_entry, simulate_exit
from .models import EventType
from .reconstruct import TokenTimeline

# A token whose price falls this far below its post-decision peak, having
# risen meaningfully first, is treated as having dumped.
DUMP_DRAWDOWN = 0.65
# ...and a "rug" additionally requires a large holder dumping into it.
RUG_SELL_SHARE = 0.35


@dataclass
class TokenOutcome:
    """Ground truth for one token, measured strictly after the decision age."""

    mint: str
    created_at: float
    decision_age: float

    # Diagnostics.  Informative, not training targets.
    peak_multiple: float = 1.0
    time_to_peak: float = 0.0
    final_multiple: float = 1.0
    max_drawdown: float = 0.0

    # The honest target: what a real exit policy would have realised.
    realizable_multiple: float = 1.0
    exit_reason: str = "none"
    time_to_exit: float = 0.0

    # Classification
    rugged: bool = False
    dumped: bool = False
    graduated: bool = False
    n_trades_after: int = 0
    liquidity_sol: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def label(
    timeline: TokenTimeline,
    decision_age: float = 10.0,
    policy: ExitPolicy | None = None,
    position_sol: float = 0.25,
    model: ExecutionModel | None = None,
) -> TokenOutcome:
    """Measure the outcome of buying ``position_sol`` at ``decision_age``.

    Entry and exit run through the same ``execution`` machinery the backtester
    uses, so a label and a backtested trade on the same token cannot disagree
    about what was achievable.  That shared path is the point: two independent
    implementations of "what would this have returned" drift, and the day they
    disagree is the day you stop being able to trust either.
    """
    policy = policy or ExitPolicy()
    # Labels must be reproducible, so the label-time execution model is
    # deterministic and frictionless in its *random* components: we want the
    # achievable outcome, not one particular unlucky draw of failed sends.
    model = model or ExecutionModel(
        entry_failure_rate=0.0, exit_failure_rate=0.0, delay_jitter=0.0, seed=0
    )
    out = TokenOutcome(
        mint=timeline.mint,
        created_at=timeline.created_at,
        decision_age=decision_age,
    )

    entry_state = timeline.state_at(decision_age)
    entry_price = entry_state.price_sol
    after = timeline.after(decision_age)
    out.n_trades_after = len(after)
    out.liquidity_sol = entry_state.real_sol / LAMPORTS_PER_SOL

    if entry_price <= 0:
        return out

    # -- diagnostics: the theoretical path -------------------------------
    peak_price, peak_age, last_price = entry_price, decision_age, entry_price
    trough_after_peak = entry_price
    for e in after:
        if not (e.virtual_sol and e.virtual_tokens):
            continue
        price = state_from_reserves(e.virtual_sol, e.virtual_tokens).price_sol
        age = e.block_time - timeline.created_at
        if price > peak_price:
            peak_price, peak_age = price, age
            trough_after_peak = price
        trough_after_peak = min(trough_after_peak, price)
        last_price = price

    out.peak_multiple = peak_price / entry_price
    out.time_to_peak = peak_age - decision_age
    out.final_multiple = last_price / entry_price
    out.max_drawdown = 1.0 - (trough_after_peak / peak_price) if peak_price > 0 else 0.0
    out.graduated = timeline.state_at(decision_age + policy.max_hold).complete

    # A "dump" is a real rise followed by giving most of it back.  Requiring the
    # rise first keeps tokens that merely bled out from being counted as pumps
    # that dumped - a distinction that matters when measuring whether the exit
    # rule is earning its keep.
    out.dumped = out.peak_multiple >= 1.5 and out.max_drawdown >= DUMP_DRAWDOWN

    # A rug is a dump driven by one wallet unloading a large share of volume.
    sells_after = [e for e in after if e.event_type is EventType.SELL]
    if sells_after and out.dumped:
        by_wallet: dict[str, int] = {}
        for e in sells_after:
            by_wallet[e.trader] = by_wallet.get(e.trader, 0) + e.sol_amount
        total_sold = sum(by_wallet.values())
        if total_sold > 0 and max(by_wallet.values()) / total_sold >= RUG_SELL_SHARE:
            out.rugged = True

    # -- the honest label ------------------------------------------------
    fill = attempt_entry(timeline, decision_age, position_sol, model, max_slippage=float("inf"))
    if not fill.filled or fill.cost <= 0:
        return out

    exit_result = simulate_exit(timeline, fill, policy, model)
    out.realizable_multiple = exit_result.proceeds / fill.cost
    out.exit_reason = exit_result.reason
    out.time_to_exit = exit_result.age - decision_age
    return out


def label_all(
    timelines: list[TokenTimeline],
    decision_age: float = 10.0,
    policy: ExitPolicy | None = None,
    position_sol: float = 0.25,
    model: ExecutionModel | None = None,
) -> dict[str, TokenOutcome]:
    """Label a whole capture, keyed by mint."""
    return {tl.mint: label(tl, decision_age, policy, position_sol, model) for tl in timelines}
