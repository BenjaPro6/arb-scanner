"""Portfolio-level backtest.

Scoring tokens one at a time and adding up the returns overstates what a real
bot achieves, because a real bot is constrained in ways a spreadsheet is not:

* **Capital is finite.**  Six good launches in the same minute is five you
  cannot take.  Skipped-because-full is a real cost and it lands hardest on the
  busiest, most opportunity-rich periods.
* **Slots are finite.**  Positions occupy attention and RPC budget.
* **A trade ties capital up.**  SOL in a position that grinds sideways for five
  minutes is SOL unavailable for the launch that mattered.

So the engine walks the whole capture in wall-clock order, holds a portfolio
with real constraints, and reports what that portfolio did - including the
opportunities it had to decline.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..curve import LAMPORTS_PER_SOL
from ..execution import ExecutionModel, ExitPolicy, attempt_entry, simulate_exit
from ..features import CreatorHistory, extract
from ..label import label
from ..reconstruct import TokenTimeline
from ..strategy.base import Strategy


@dataclass
class Trade:
    """One round trip, with everything needed to audit it afterwards."""

    mint: str
    decision_at: float
    score: float
    size_sol: float
    filled: bool
    entry_age: float = 0.0
    exit_age: float = 0.0
    entry_price: float = 0.0
    cost_lamports: int = 0
    proceeds_lamports: int = 0
    exit_reason: str = "none"
    archetype: str = ""

    @property
    def pnl_sol(self) -> float:
        return (self.proceeds_lamports - self.cost_lamports) / LAMPORTS_PER_SOL

    @property
    def multiple(self) -> float:
        return self.proceeds_lamports / self.cost_lamports if self.cost_lamports else 0.0


@dataclass
class BacktestConfig:
    decision_age: float = 10.0
    starting_capital_sol: float = 10.0
    position_sol: float = 0.25
    max_concurrent: int = 3
    max_slippage: float = 0.35
    # Refuse to enter a curve too thin to exit: a position larger than this
    # fraction of the curve's real SOL cannot be sold without destroying the
    # price it is marked at.
    max_pool_share: float = 0.15


@dataclass
class BacktestResult:
    trades: list[Trade] = field(default_factory=list)
    skipped_no_capital: int = 0
    skipped_no_slot: int = 0
    skipped_too_thin: int = 0
    rejected_by_strategy: int = 0
    starting_capital: float = 0.0
    ending_capital: float = 0.0
    peak_capital: float = 0.0
    min_capital: float = 0.0

    @property
    def filled_trades(self) -> list[Trade]:
        return [t for t in self.trades if t.filled]

    @property
    def considered(self) -> int:
        return (
            len(self.trades)
            + self.rejected_by_strategy
            + self.skipped_no_capital
            + self.skipped_no_slot
            + self.skipped_too_thin
        )


def run_backtest(
    timelines: list[TokenTimeline],
    strategy: Strategy,
    config: BacktestConfig | None = None,
    policy: ExitPolicy | None = None,
    model: ExecutionModel | None = None,
    ground_truth: dict | None = None,
) -> BacktestResult:
    """Replay a capture through a strategy and a constrained portfolio.

    Tokens are processed in launch order, which is the order the information
    arrived.  ``CreatorHistory`` is updated only *after* each token has been
    scored and resolved, so a creator's reputation at decision time reflects
    strictly earlier launches - the causality guarantee the feature layer
    depends on.
    """
    config = config or BacktestConfig()
    policy = policy or ExitPolicy()
    model = model or ExecutionModel()
    model.reset()

    result = BacktestResult(starting_capital=config.starting_capital_sol)
    capital = config.starting_capital_sol
    result.peak_capital = result.min_capital = capital

    history = CreatorHistory()
    # (exit_wallclock, mint) for positions still open; the portfolio can only
    # take a new slot once one of these has closed.
    open_positions: list[tuple[float, str]] = []

    for timeline in sorted(timelines, key=lambda t: t.created_at):
        decision_time = timeline.created_at + config.decision_age

        # Release positions that closed before this decision.
        open_positions = [(t, m) for t, m in open_positions if t > decision_time]

        features = extract(timeline, config.decision_age, history)

        # Resolve the outcome regardless of whether we trade, so creator
        # history stays complete: what a dev did on a token we skipped is still
        # evidence about that dev.
        outcome = label(timeline, config.decision_age, policy, config.position_sol)

        def remember() -> None:
            history.record(
                timeline.creator, timeline.created_at, outcome.peak_multiple, outcome.rugged
            )

        decision = strategy.decide(features, timeline.mint)
        if not decision.enter:
            result.rejected_by_strategy += 1
            remember()
            continue

        if len(open_positions) >= config.max_concurrent:
            result.skipped_no_slot += 1
            remember()
            continue

        size = min(decision.size_sol or config.position_sol, capital)
        if size <= 0 or capital < size:
            result.skipped_no_capital += 1
            remember()
            continue

        # Liquidity gate: never take a position we could not get back out of.
        entry_state = timeline.state_at(config.decision_age)
        pool_sol = entry_state.real_sol / LAMPORTS_PER_SOL
        if pool_sol <= 0 or size / pool_sol > config.max_pool_share:
            result.skipped_too_thin += 1
            remember()
            continue

        # Ground truth, when we have it, is carried on the trade purely so the
        # report can break results down by archetype.  It is attached after the
        # decision and never reaches the strategy.
        archetype = ""
        if ground_truth is not None:
            truth = ground_truth.get(timeline.mint)
            if truth is not None:
                archetype = str(getattr(truth, "archetype", ""))

        fill = attempt_entry(timeline, config.decision_age, size, model, config.max_slippage)
        trade = Trade(
            mint=timeline.mint,
            decision_at=decision_time,
            score=decision.score,
            size_sol=size,
            filled=fill.filled,
            entry_age=fill.age,
            entry_price=fill.price,
            cost_lamports=fill.cost,
            archetype=archetype,
        )

        if not fill.filled:
            # A failed entry still burns the fee.
            capital -= fill.cost / LAMPORTS_PER_SOL
            trade.exit_reason = "entry_failed"
            result.trades.append(trade)
            result.min_capital = min(result.min_capital, capital)
            remember()
            continue

        exit_result = simulate_exit(timeline, fill, policy, model)
        trade.proceeds_lamports = exit_result.proceeds
        trade.exit_reason = exit_result.reason
        trade.exit_age = exit_result.age

        capital += trade.pnl_sol
        result.trades.append(trade)
        open_positions.append((timeline.created_at + exit_result.age, timeline.mint))
        result.peak_capital = max(result.peak_capital, capital)
        result.min_capital = min(result.min_capital, capital)
        remember()

    result.ending_capital = capital
    return result
