"""Terminal view of a running paper session.

Kept strictly read-only: it renders whatever the portfolio currently says and
never touches it.  A display that could mutate state is a display that will
eventually be the reason a position closed.
"""

from __future__ import annotations

import time

from .portfolio import LivePortfolio


def _fmt_age(seconds: float) -> str:
    if seconds < 90:
        return f"{seconds:.0f}s"
    return f"{seconds / 60:.1f}m"


def render(portfolio: LivePortfolio, stats, width: int = 96, now: float | None = None) -> str:
    """One frame of the session, as plain text.

    ``now`` comes from the caller so the view uses the same clock the trader
    does.  Reading the wall clock here instead would make every age wrong for
    any session not running in real time - and untestable besides.
    """
    now = now if now is not None else getattr(stats, "now", None) or time.time()
    lines: list[str] = []
    equity = portfolio.equity
    pnl = equity - portfolio.starting_capital
    pct = 100 * pnl / portfolio.starting_capital if portfolio.starting_capital else 0.0

    lines.append("=" * width)
    lines.append(
        " PAPER SESSION - no wallet, no signing, no real orders".ljust(width - 1) + " "
    )
    lines.append("=" * width)
    lines.append(
        f" up {_fmt_age(stats.uptime):>6} | launches {stats.launches:5d} | "
        f"decisions {stats.decisions:5d} | events {stats.events:6d}"
    )
    lines.append(
        f" equity {equity:8.4f} SOL ({pnl:+.4f}, {pct:+.1f}%) | "
        f"cash {portfolio.capital:7.4f} | open {len(portfolio.positions)}"
        f"/{portfolio.max_concurrent}"
    )
    lines.append(
        f" closed {len(portfolio.closed):4d} | win rate {100 * portfolio.win_rate:5.1f}% | "
        f"expectancy {portfolio.expectancy:+.5f} SOL/attempt"
    )
    lines.append(
        f" skipped: rejected {portfolio.rejected} | no slot {portfolio.skipped_no_slot} | "
        f"no capital {portfolio.skipped_no_capital} | too thin {portfolio.skipped_too_thin} | "
        f"failed entries {portfolio.entries_failed}"
    )

    if portfolio.positions:
        lines.append("-" * width)
        lines.append(
            f" {'OPEN':<10}{'mint':<16}{'age':>7}{'ratio':>8}{'peak':>8}"
            f"{'unreal SOL':>12}{'armed':>7}"
        )
        for p in sorted(portfolio.positions.values(), key=lambda x: x.opened_at):
            peak = p.high_water / p.entry_value if p.entry_value else 0.0
            lines.append(
                f" {p.symbol[:9]:<10}{p.mint[:14]:<16}{_fmt_age(now - p.opened_at):>7}"
                f"{p.ratio:>8.2f}{peak:>8.2f}{p.unrealised_sol:>+12.4f}"
                f"{'yes' if p.armed else '-':>7}"
            )

    if portfolio.closed:
        lines.append("-" * width)
        lines.append(
            f" {'RECENT':<10}{'mint':<16}{'held':>7}{'mult':>8}"
            f"{'P&L SOL':>12}{'reason':>16}"
        )
        for t in portfolio.closed[-8:]:
            lines.append(
                f" {t.symbol[:9]:<10}{t.mint[:14]:<16}{_fmt_age(t.held_for):>7}"
                f"{t.multiple:>8.2f}{t.pnl_sol:>+12.4f}{t.exit_reason:>16}"
            )

    lines.append("=" * width)
    return "\n".join(lines)


def final_report(portfolio: LivePortfolio, stats) -> str:
    """What the session amounted to, with the caveats it needs."""
    from collections import Counter

    equity = portfolio.equity
    pnl = equity - portfolio.starting_capital
    lines = [
        "",
        "PAPER SESSION RESULT",
        f"  ran for            : {_fmt_age(stats.uptime)}",
        f"  launches seen      : {stats.launches}",
        f"  decisions taken    : {stats.decisions}",
        f"  entries attempted  : {portfolio.entries_attempted} "
        f"({portfolio.entries_failed} failed to land)",
        f"  trades closed      : {len(portfolio.closed)}",
        f"  capital            : {portfolio.starting_capital:.4f} -> {equity:.4f} SOL "
        f"({pnl:+.4f})",
        f"  win rate           : {100 * portfolio.win_rate:.1f}%",
        f"  expectancy         : {portfolio.expectancy:+.5f} SOL per attempt",
    ]

    if portfolio.closed:
        multiples = sorted(t.multiple for t in portfolio.closed)
        best = max(portfolio.closed, key=lambda t: t.pnl_sol)
        gains = [t.pnl_sol for t in portfolio.closed if t.pnl_sol > 0]
        lines.append(
            f"  median / best      : {multiples[len(multiples) // 2]:.2f}x / {max(multiples):.2f}x"
        )
        if gains:
            lines.append(
                f"  best trade's share : {100 * best.pnl_sol / sum(gains):.0f}% of gross profit"
            )
        reasons = Counter(t.exit_reason for t in portfolio.closed)
        lines.append(
            "  exits              : "
            + ", ".join(f"{k} {v}" for k, v in reasons.most_common())
        )

    lines.append("")
    if len(portfolio.closed) < 30:
        lines.append(
            "  Too few trades to mean anything yet. Run this for days, not minutes -"
        )
        lines.append(
            "  at this sample size the result is decided by one or two tokens."
        )
    else:
        lines.append(
            "  Paper results are optimistic in one specific way: your buys never"
        )
        lines.append(
            "  actually moved the curve, and never competed with anyone. Treat this"
        )
        lines.append("  as an upper bound, not a forecast.")
    return "\n".join(lines)
