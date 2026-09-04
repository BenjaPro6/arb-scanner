"""Rebuild each token's history from the raw event stream.

The one rule this module exists to enforce: **you may only look at what you
could actually have seen.**

At the moment you decide whether to buy, the information you hold is not "every
trade that had happened on chain" - it is "every trade whose notification had
reached your process".  Those differ by the network latency, and in a market
where the whole edge is measured in seconds, the difference is the entire game.
A backtest that filters on ``block_time`` is quietly reading a few hundred
milliseconds into the future on every single decision, which is more than
enough to manufacture an edge that does not exist.

So ``TokenTimeline.observable_at`` filters on ``recv_time``, and the feature
layer is given no other way to reach the events.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field

from .curve import CurveState, state_from_reserves
from .models import EventType, TokenEvent


@dataclass
class TokenTimeline:
    """Every event for one mint, in chain order, with time-sliced views."""

    mint: str
    events: list[TokenEvent] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.events.sort(key=lambda e: (e.block_time, e.event_type is not EventType.CREATE))
        self._recv_sorted = sorted(self.events, key=lambda e: e.recv_time)
        self._recv_keys = [e.recv_time for e in self._recv_sorted]
        self._block_keys = [e.block_time for e in self.events]

    # -- identity --------------------------------------------------------

    @property
    def create(self) -> TokenEvent | None:
        for e in self.events:
            if e.event_type is EventType.CREATE:
                return e
        return None

    @property
    def created_at(self) -> float:
        c = self.create
        return c.block_time if c else (self.events[0].block_time if self.events else 0.0)

    @property
    def creator(self) -> str:
        c = self.create
        return (c.creator or c.trader) if c else ""

    @property
    def trades(self) -> list[TokenEvent]:
        return [e for e in self.events if e.event_type is not EventType.CREATE]

    # -- time slicing ----------------------------------------------------

    def observable_at(self, age: float) -> list[TokenEvent]:
        """Events our process had received by ``age`` seconds after launch.

        This is the honest information set for a decision taken at that age,
        and the only slice the feature layer is allowed to use.
        """
        cutoff = self.created_at + age
        return self._recv_sorted[: bisect_right(self._recv_keys, cutoff)]

    def after(self, age: float) -> list[TokenEvent]:
        """Events that landed on chain strictly after ``age``.

        Outcome territory: labels are computed here, features never are.
        Ordered by ``block_time`` because once we are measuring what happened,
        chain order is the truth - our own latency no longer matters.
        """
        cutoff = self.created_at + age
        return self.events[bisect_right(self._block_keys, cutoff):]

    def between(self, start_age: float, end_age: float) -> list[TokenEvent]:
        """Chain events in the half-open window ``(start_age, end_age]``.

        Open at the low end to match ``after``, so that ``between(0, t)`` and
        ``after(t)`` partition everything that happened *after* creation
        without double-counting the launch event itself.  Use ``chain_at`` when
        you want the launch included.
        """
        lo = self.created_at + start_age
        hi = self.created_at + end_age
        return self.events[bisect_right(self._block_keys, lo): bisect_right(self._block_keys, hi)]

    def chain_at(self, age: float) -> list[TokenEvent]:
        """Everything on chain by ``age``, launch event included.

        The counterpart to ``observable_at``: same instant, but omniscient.
        Comparing the two is how you measure what latency actually costs you.
        """
        return self.events[: bisect_right(self._block_keys, self.created_at + age)]

    # -- curve state -----------------------------------------------------

    def state_at(self, age: float, observable: bool = False) -> CurveState:
        """Curve state at a given age.

        ``observable=True`` restricts to what we had received - use it for
        anything feeding a decision.  The default reads chain state, which is
        what the outcome/label side wants.
        """
        pool = self.observable_at(age) if observable else self.events[
            : bisect_right(self._block_keys, self.created_at + age)
        ]
        for e in reversed(pool):
            if e.virtual_sol and e.virtual_tokens:
                return state_from_reserves(e.virtual_sol, e.virtual_tokens)
        return CurveState()

    def open_state(self) -> CurveState:
        """Curve state immediately after creation, including any dev buy."""
        c = self.create
        if c and c.virtual_sol and c.virtual_tokens:
            return state_from_reserves(c.virtual_sol, c.virtual_tokens)
        return CurveState()

    def price_series(self, start_age: float = 0.0, end_age: float = float("inf")) -> list[tuple[float, float]]:
        """``(age_seconds, price_sol)`` after each trade in the window.

        Prices come from the reserves each event reports rather than from
        ``sol_amount / token_amount``: the reported reserves are exact
        post-trade state, while the ratio is an average over the trade's own
        slippage and would smear the peak we are trying to measure.
        """
        out: list[tuple[float, float]] = []
        base = self.created_at
        for e in self.events:
            age = e.block_time - base
            if age < start_age or age > end_age:
                continue
            if e.virtual_sol and e.virtual_tokens:
                out.append((age, state_from_reserves(e.virtual_sol, e.virtual_tokens).price_sol))
        return out

    @property
    def lifespan(self) -> float:
        return (self.events[-1].block_time - self.created_at) if self.events else 0.0


def group_by_mint(events: Iterable[TokenEvent]) -> dict[str, TokenTimeline]:
    """Fold a flat event stream into one timeline per mint."""
    buckets: dict[str, list[TokenEvent]] = {}
    for e in events:
        buckets.setdefault(e.mint, []).append(e)
    return {m: TokenTimeline(mint=m, events=evs) for m, evs in buckets.items()}


def iter_timelines(events: Iterable[TokenEvent], require_create: bool = True) -> Iterator[TokenTimeline]:
    """Yield timelines in launch order.

    ``require_create`` drops mints whose creation we missed.  Those are traps:
    if the collector started mid-life, the "age" of every event is unknown, and
    an unknowable age silently corrupts every time-based feature.
    """
    timelines = group_by_mint(events)
    for tl in sorted(timelines.values(), key=lambda t: t.created_at):
        if require_create and tl.create is None:
            continue
        yield tl
