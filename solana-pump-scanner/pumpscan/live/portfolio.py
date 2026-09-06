"""Open positions, marked against the live curve.

The difference between this and the backtest portfolio is that here nothing is
known in advance.  A backtest can look at a token's whole tape and decide where
the exit lands; live, the exit condition is evaluated against each trade as it
arrives, and against a clock for the tokens that simply stop trading - which is
most of them, and the case a naive live bot forgets until it is holding forty
dead positions.

Paper mode and live mode share this class deliberately.  When the real executor
is added it swaps the fill functions and leaves the accounting alone, so the
two can never drift into disagreeing about what a position is worth.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from typing import Any

from ..curve import LAMPORTS_PER_SOL, CurveState
from ..execution import ExitPolicy


@dataclass
class LivePosition:
    """One open paper position, marked to what the curve would pay for it."""

    mint: str
    symbol: str
    opened_at: float
    entry_age: float
    tokens: int
    cost_lamports: int
    entry_price: float
    score: float

    entry_value: int = 0
    high_water: int = 0
    last_value: int = 0
    last_update: float = 0.0

    trigger_reason: str = ""
    trigger_at: float = 0.0
    execute_at: float = 0.0

    def __post_init__(self) -> None:
        if self.high_water == 0:
            self.high_water = self.entry_value
        if self.last_value == 0:
            self.last_value = self.entry_value
        if self.last_update == 0.0:
            self.last_update = self.opened_at

    @property
    def ratio(self) -> float:
        """Current value over entry value; 1.0 means flat."""
        return self.last_value / self.entry_value if self.entry_value else 0.0

    @property
    def unrealised_sol(self) -> float:
        return (self.last_value - self.cost_lamports) / LAMPORTS_PER_SOL

    @property
    def age(self) -> float:
        return time.time() - self.opened_at

    @property
    def armed(self) -> bool:
        """Whether the trailing stop is live yet."""
        return self.entry_value > 0 and self.high_water / self.entry_value >= 1.4

    def mark(self, state: CurveState, now: float | None = None) -> None:
        """Re-mark against a fresh curve state.

        Marked at what the curve would *pay* to take the whole position, not at
        the quoted price.  On a thin curve those differ by a lot, and a bot that
        reports the flattering one talks itself into holding.
        """
        self.last_value = state.value_of(self.tokens)
        self.high_water = max(self.high_water, self.last_value)
        self.last_update = now if now is not None else time.time()

    def check_exit(self, policy: ExitPolicy, now: float | None = None) -> str | None:
        """Return the exit reason if the policy says to sell, else ``None``.

        Only the *first* trigger counts: once a sell is pending, a further move
        must not restart the clock or relabel the reason, or a position sliding
        through several thresholds would keep deferring its own exit.
        """
        now = now if now is not None else time.time()
        if self.trigger_reason:
            return self.trigger_reason
        if not self.entry_value:
            return None

        ratio = self.ratio
        reason: str | None = None
        if ratio >= policy.take_profit:
            reason = "take_profit"
        elif ratio <= policy.stop_loss:
            reason = "stop_loss"
        elif (
            self.high_water / self.entry_value >= policy.trail_arm
            and self.last_value <= self.high_water * (1 - policy.trailing_stop)
        ):
            reason = "trailing_stop"
        elif now - self.opened_at >= policy.max_hold:
            reason = "max_hold"
        return reason


@dataclass
class ClosedTrade:
    """A completed round trip, in the shape the analysis tools expect."""

    mint: str
    symbol: str
    opened_at: float
    closed_at: float
    score: float
    size_sol: float
    tokens: int
    cost_lamports: int
    proceeds_lamports: int
    entry_price: float
    exit_price: float
    exit_reason: str
    peak_ratio: float
    paper: bool = True

    @property
    def pnl_sol(self) -> float:
        return (self.proceeds_lamports - self.cost_lamports) / LAMPORTS_PER_SOL

    @property
    def multiple(self) -> float:
        return self.proceeds_lamports / self.cost_lamports if self.cost_lamports else 0.0

    @property
    def held_for(self) -> float:
        return self.closed_at - self.opened_at

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["pnl_sol"] = self.pnl_sol
        d["multiple"] = self.multiple
        d["held_for"] = self.held_for
        return d


@dataclass
class LivePortfolio:
    """Capital, slots and the open book."""

    starting_capital: float
    max_concurrent: int = 3
    position_sol: float = 0.25

    capital: float = 0.0
    reserved: float = 0.0
    positions: dict[str, LivePosition] = field(default_factory=dict)
    closed: list[ClosedTrade] = field(default_factory=list)

    entries_attempted: int = 0
    entries_failed: int = 0
    skipped_no_slot: int = 0
    skipped_no_capital: int = 0
    skipped_too_thin: int = 0
    rejected: int = 0
    considered: int = 0

    def __post_init__(self) -> None:
        if self.capital == 0.0:
            self.capital = self.starting_capital

    # -- capacity --------------------------------------------------------

    @property
    def free_slots(self) -> int:
        return max(0, self.max_concurrent - len(self.positions))

    @property
    def available_capital(self) -> float:
        """Capital not already committed to a position awaiting its fill."""
        return self.capital - self.reserved

    def can_open(self, size_sol: float) -> tuple[bool, str]:
        if self.free_slots <= 0:
            return False, "no_slot"
        if self.available_capital < size_sol:
            return False, "no_capital"
        return True, ""

    # -- book ------------------------------------------------------------

    def open(self, position: LivePosition) -> None:
        self.positions[position.mint] = position
        self.capital -= position.cost_lamports / LAMPORTS_PER_SOL

    def close(self, mint: str, proceeds: int, reason: str, exit_price: float,
              now: float | None = None) -> ClosedTrade | None:
        position = self.positions.pop(mint, None)
        if position is None:
            return None
        self.capital += proceeds / LAMPORTS_PER_SOL
        trade = ClosedTrade(
            mint=position.mint,
            symbol=position.symbol,
            opened_at=position.opened_at,
            closed_at=now if now is not None else time.time(),
            score=position.score,
            size_sol=position.cost_lamports / LAMPORTS_PER_SOL,
            tokens=position.tokens,
            cost_lamports=position.cost_lamports,
            proceeds_lamports=proceeds,
            entry_price=position.entry_price,
            exit_price=exit_price,
            exit_reason=reason,
            peak_ratio=(
                position.high_water / position.entry_value if position.entry_value else 0.0
            ),
        )
        self.closed.append(trade)
        return trade

    def charge(self, lamports_amount: int) -> None:
        """Deduct a cost that bought nothing - a failed transaction's fee."""
        self.capital -= lamports_amount / LAMPORTS_PER_SOL

    # -- reporting -------------------------------------------------------

    @property
    def realised_pnl(self) -> float:
        return sum(t.pnl_sol for t in self.closed)

    @property
    def unrealised_pnl(self) -> float:
        return sum(p.unrealised_sol for p in self.positions.values())

    @property
    def equity(self) -> float:
        """Capital plus what the open book would fetch if closed right now."""
        return self.capital + sum(
            p.last_value / LAMPORTS_PER_SOL for p in self.positions.values()
        )

    @property
    def win_rate(self) -> float:
        if not self.closed:
            return 0.0
        return sum(1 for t in self.closed if t.pnl_sol > 0) / len(self.closed)

    @property
    def expectancy(self) -> float:
        """Average P&L per entry attempt, failures included.

        Per *attempt* rather than per fill: a strategy that chases launches it
        cannot land still pays the fees, and dividing by fills alone hides that.
        """
        if not self.entries_attempted:
            return 0.0
        return self.realised_pnl / self.entries_attempted
