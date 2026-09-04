"""Replay a stored capture as if it were live.

This is what makes results reproducible.  A backtest reads the same events in
the same order every run, so a change in the numbers means a change in the
strategy - never a different sample of the market.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterable, Iterator

from ..models import TokenEvent
from ..storage import RawLog
from .base import EventSource


class ReplaySource(EventSource):
    """Replay events from a raw log or any iterable.

    ``speed`` controls pacing: ``0`` (the default) runs flat out, which is what
    a backtest wants.  A positive value sleeps between events scaled to their
    real spacing, which is useful for exercising the live collector path
    against recorded data.
    """

    name = "replay"

    def __init__(
        self,
        events: Iterable[TokenEvent] | None = None,
        log_dir: str | None = None,
        speed: float = 0.0,
        sort: bool = True,
    ):
        if events is None and log_dir is None:
            raise ValueError("replay needs either events or a log_dir")
        self._events = events
        self._log_dir = log_dir
        self.speed = speed
        self.sort = sort

    def _iter(self) -> Iterator[TokenEvent]:
        src = RawLog(self._log_dir).read_all() if self._log_dir else iter(self._events or ())
        if not self.sort:
            yield from src
            return
        # Sorting by (block_time, mint) makes cross-token ordering total and
        # deterministic even when two chains of events share a timestamp.
        yield from sorted(src, key=lambda e: (e.block_time, e.mint))

    async def stream(self) -> AsyncIterator[TokenEvent]:
        previous: float | None = None
        for event in self._iter():
            if self.speed > 0 and previous is not None:
                gap = (event.block_time - previous) / self.speed
                if gap > 0:
                    await asyncio.sleep(min(gap, 5.0))
            previous = event.block_time
            yield event

    def events(self) -> list[TokenEvent]:
        """Materialise the whole capture - the synchronous path for backtests."""
        return list(self._iter())
