"""Turning a backtest into an answer you can act on.

The metric that decides everything here is **expectancy**: average profit per
trade, in SOL, after every cost.  Not win rate - a strategy that wins 80% of
the time and gives it all back on the other 20% is a losing strategy with good
optics.  Not total return - that is one path through one sample, and it is
dominated by whichever two trades happened to land.

Where a distribution is this skewed, the median trade and the mean trade say
opposite things, and both are reported.  If the mean is positive only because
of the single best trade, you do not have a strategy; you have a lottery ticket
that already paid out once.
"""

from __future__ import annotations

import statistics as stats
from collections import Counter
from dataclasses import dataclass, field

from .backtest.engine import BacktestResult, Trade


@dataclass
class Metrics:
    strategy: str = ""
    n_considered: int = 0
    n_attempted: int = 0
    n_filled: int = 0
    fill_rate: float = 0.0

    total_pnl_sol: float = 0.0
    expectancy_sol: float = 0.0
    median_pnl_sol: float = 0.0
    win_rate: float = 0.0

    mean_multiple: float = 0.0
    median_multiple: float = 0.0
    best_multiple: float = 0.0
    worst_multiple: float = 0.0

    return_pct: float = 0.0
    max_drawdown_pct: float = 0.0

    # How much of the profit rests on the single best trade.  Above ~0.5 the
    # result is an anecdote, however large the total.
    top_trade_share: float = 0.0
    profit_factor: float = 0.0

    exit_reasons: dict[str, int] = field(default_factory=dict)
    by_archetype: dict[str, dict[str, float]] = field(default_factory=dict)
    skipped: dict[str, int] = field(default_factory=dict)

    def summary(self) -> str:
        lines = [
            f"strategy            : {self.strategy}",
            f"considered / traded : {self.n_considered} / {self.n_filled} "
            f"(fill rate {100 * self.fill_rate:.0f}%)",
            f"total P&L           : {self.total_pnl_sol:+.4f} SOL ({self.return_pct:+.1f}% on capital)",
            f"expectancy          : {self.expectancy_sol:+.5f} SOL per trade   <- the number that matters",
            f"median trade        : {self.median_pnl_sol:+.5f} SOL",
            f"win rate            : {100 * self.win_rate:.1f}%",
            f"multiple            : median {self.median_multiple:.2f}x, mean {self.mean_multiple:.2f}x, "
            f"best {self.best_multiple:.2f}x, worst {self.worst_multiple:.2f}x",
            f"profit factor       : {self.profit_factor:.2f}",
            f"max drawdown        : {100 * self.max_drawdown_pct:.1f}%",
            f"best trade's share  : {100 * self.top_trade_share:.0f}% of gross profit",
        ]
        if self.exit_reasons:
            reasons = ", ".join(f"{k} {v}" for k, v in sorted(self.exit_reasons.items(), key=lambda x: -x[1]))
            lines.append(f"exits               : {reasons}")
        if self.skipped:
            skips = ", ".join(f"{k} {v}" for k, v in self.skipped.items() if v)
            if skips:
                lines.append(f"skipped             : {skips}")
        if self.by_archetype:
            lines.append("by archetype        :")
            for name, m in sorted(self.by_archetype.items()):
                lines.append(
                    f"    {name:10s} n={int(m['n']):3d}  P&L {m['pnl']:+.4f} SOL  "
                    f"median {m['median_multiple']:.2f}x"
                )
        return "\n".join(lines)


def _drawdown(trades: list[Trade], starting: float) -> float:
    """Worst peak-to-trough decline of the equity curve, as a fraction."""
    equity, peak, worst = starting, starting, 0.0
    for t in sorted(trades, key=lambda x: x.decision_at):
        equity += t.pnl_sol
        peak = max(peak, equity)
        if peak > 0:
            worst = max(worst, (peak - equity) / peak)
    return worst


def analyse(result: BacktestResult, strategy_name: str = "") -> Metrics:
    """Reduce a backtest to the numbers worth arguing about."""
    filled = result.filled_trades
    m = Metrics(
        strategy=strategy_name,
        n_considered=result.considered,
        n_attempted=len(result.trades),
        n_filled=len(filled),
        fill_rate=len(filled) / len(result.trades) if result.trades else 0.0,
        skipped={
            "no_capital": result.skipped_no_capital,
            "no_slot": result.skipped_no_slot,
            "too_thin": result.skipped_too_thin,
            "rejected": result.rejected_by_strategy,
        },
    )

    # Failed entries cost real money and belong in the P&L, even though they
    # never became positions.  Counting only fills flatters every strategy that
    # chases fast launches, which is exactly the kind that fails to land.
    all_pnl = [t.pnl_sol for t in result.trades]
    m.total_pnl_sol = sum(all_pnl)
    m.return_pct = (
        100 * m.total_pnl_sol / result.starting_capital if result.starting_capital else 0.0
    )
    m.max_drawdown_pct = _drawdown(result.trades, result.starting_capital)

    if not filled:
        return m

    pnl = [t.pnl_sol for t in filled]
    multiples = [t.multiple for t in filled]

    m.expectancy_sol = m.total_pnl_sol / len(result.trades) if result.trades else 0.0
    m.median_pnl_sol = stats.median(pnl)
    m.win_rate = sum(1 for p in pnl if p > 0) / len(pnl)
    m.mean_multiple = stats.mean(multiples)
    m.median_multiple = stats.median(multiples)
    m.best_multiple = max(multiples)
    m.worst_multiple = min(multiples)

    gains = [p for p in pnl if p > 0]
    losses = [-p for p in pnl if p < 0]
    m.profit_factor = (sum(gains) / sum(losses)) if losses else float("inf")
    m.top_trade_share = (max(gains) / sum(gains)) if gains else 0.0

    m.exit_reasons = dict(Counter(t.exit_reason for t in result.trades))

    by_arch: dict[str, list[Trade]] = {}
    for t in filled:
        if t.archetype:
            by_arch.setdefault(t.archetype, []).append(t)
    for name, group in by_arch.items():
        m.by_archetype[name] = {
            "n": float(len(group)),
            "pnl": sum(t.pnl_sol for t in group),
            "median_multiple": stats.median([t.multiple for t in group]),
        }
    return m


def compare(results: dict[str, BacktestResult]) -> str:
    """Rank strategies side by side against the do-nothing and buy-all bars.

    A strategy is only interesting if it beats *both*: buying nothing risks no
    capital, and buying everything requires no insight.  Anything that fails to
    clear those two has not earned the complexity it costs.
    """
    metrics = {name: analyse(res, name) for name, res in results.items()}
    baseline = metrics.get("buy_everything")

    header = (
        f"{'strategy':<18}{'trades':>7}{'P&L SOL':>11}{'expectancy':>12}"
        f"{'win%':>7}{'median x':>10}{'maxDD%':>8}"
    )
    lines = [header, "-" * len(header)]
    for name, m in sorted(metrics.items(), key=lambda kv: -kv[1].total_pnl_sol):
        lines.append(
            f"{name:<18}{m.n_filled:>7}{m.total_pnl_sol:>+11.4f}{m.expectancy_sol:>+12.5f}"
            f"{100 * m.win_rate:>7.1f}{m.median_multiple:>10.2f}{100 * m.max_drawdown_pct:>8.1f}"
        )

    if baseline is not None:
        lines.append("")
        for name, m in metrics.items():
            if name in ("buy_everything", "buy_nothing"):
                continue
            edge = m.expectancy_sol - baseline.expectancy_sol
            verdict = "beats" if edge > 0 else "LOSES TO"
            lines.append(
                f"  {name}: {verdict} buy-everything by {edge:+.5f} SOL/trade"
            )
    return "\n".join(lines)
