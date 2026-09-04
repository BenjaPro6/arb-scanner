"""The live collector.

Its only job is to miss nothing and lose nothing.  It makes no decisions, forms
no opinions and computes no features - it writes down what happened, so that
every question we think to ask later can be asked of real data.

Two failure modes it is built against:

**Silent subscription loss.**  The feed caps how many per-token trade streams
one connection may hold.  Past that cap new subscriptions are quietly dropped:
launches keep arriving, trades stop, and you end up with a database full of
tokens that appear to have died at birth.  So the watch list is a bounded
window that actively retires tokens once they are too old to be interesting.

**Losing the session to a crash.**  Events are flushed to the raw log as they
arrive, and the SQLite index is written in batches.  Kill the process at any
moment and you lose at most the last partial batch from the index - never from
the log, which is the copy that matters.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import time
from dataclasses import dataclass, field

from .models import EventType, TokenEvent
from .sources.base import EventSource
from .storage import EventStore, RawLog

log = logging.getLogger(__name__)


@dataclass
class CollectorConfig:
    log_dir: str = "data/raw"
    db_path: str = "data/events.db"

    # How long to keep following a token after launch.  The decision window is
    # seconds and the outcome window is minutes; beyond this a token is either
    # dead or has graduated, and either way it is no longer our problem.
    watch_seconds: float = 600.0
    max_watched: int = 300

    flush_every: int = 500
    flush_interval: float = 10.0
    stats_interval: float = 60.0


@dataclass
class CollectorStats:
    started_at: float = field(default_factory=time.time)
    events: int = 0
    creates: int = 0
    trades: int = 0
    indexed: int = 0
    watching: int = 0
    dropped_unwatched: int = 0

    @property
    def uptime(self) -> float:
        return time.time() - self.started_at

    def line(self) -> str:
        rate = self.events / self.uptime if self.uptime > 0 else 0.0
        return (
            f"up {self.uptime / 60:.1f}m | {self.creates} launches, {self.trades} trades "
            f"({rate:.1f} ev/s) | watching {self.watching} | indexed {self.indexed}"
        )


class Collector:
    """Consumes a source, persists everything, manages the watch window."""

    def __init__(self, source: EventSource, config: CollectorConfig | None = None):
        self.source = source
        self.cfg = config or CollectorConfig()
        self.raw = RawLog(self.cfg.log_dir)
        self.store = EventStore(self.cfg.db_path)
        self.stats = CollectorStats()
        self._buffer: list[TokenEvent] = []
        self._watch_until: dict[str, float] = {}
        self._last_flush = time.time()
        self._last_stats = time.time()
        self._stop = asyncio.Event()

    async def run(self) -> CollectorStats:
        """Consume until stopped.  Always flushes on the way out."""
        log.info("collector starting; raw=%s db=%s", self.cfg.log_dir, self.cfg.db_path)
        try:
            async for event in self.source.stream():
                if self._stop.is_set():
                    break
                await self._handle(event)
        except asyncio.CancelledError:
            log.info("collector cancelled")
        finally:
            # Never leave the last batch unwritten; an interrupted session is
            # still a session worth having.
            self._flush()
            self.raw.close()
            await self.source.close()
            log.info("collector stopped: %s", self.stats.line())
        return self.stats

    async def _handle(self, event: TokenEvent) -> None:
        self.raw.append(event)
        self._buffer.append(event)
        self.stats.events += 1

        if event.event_type is EventType.CREATE:
            self.stats.creates += 1
            await self._watch(event)
        else:
            self.stats.trades += 1
            if event.mint not in self._watch_until:
                # A trade on something we never saw launch: keep it (the log is
                # append-only and never filtered) but count it, because a rising
                # number here means launches are being missed.
                self.stats.dropped_unwatched += 1

        now = time.time()
        if len(self._buffer) >= self.cfg.flush_every or now - self._last_flush >= self.cfg.flush_interval:
            self._flush()
        if now - self._last_stats >= self.cfg.stats_interval:
            self._last_stats = now
            self.stats.watching = len(self._watch_until)
            log.info("%s", self.stats.line())
        await self._retire(now)

    async def _watch(self, event: TokenEvent) -> None:
        self._watch_until[event.mint] = time.time() + self.cfg.watch_seconds
        await self.source.watch(event.mint)

    async def _retire(self, now: float) -> None:
        """Drop tokens past their watch window, oldest first if over budget."""
        expired = [m for m, until in self._watch_until.items() if until <= now]
        for mint in expired:
            self._watch_until.pop(mint, None)
            await self.source.unwatch(mint)

        # Hard cap as a backstop: if launches arrive faster than they expire,
        # shed the oldest rather than let the server silently stop delivering.
        while len(self._watch_until) > self.cfg.max_watched:
            oldest = min(self._watch_until, key=self._watch_until.get)
            self._watch_until.pop(oldest, None)
            await self.source.unwatch(oldest)

    def _flush(self) -> None:
        if not self._buffer:
            return
        try:
            self.stats.indexed += self.store.insert_events(self._buffer)
        except Exception:
            # The raw log already has these events, so an index failure is
            # recoverable with `pumpscan reindex`.  Never let it kill the run.
            log.exception("index write failed; raw log is intact, reindex later")
        finally:
            self._buffer.clear()
            self._last_flush = time.time()

    def stop(self) -> None:
        self._stop.set()


async def collect(source: EventSource, config: CollectorConfig | None = None,
                  duration: float | None = None) -> CollectorStats:
    """Run a collector, stopping on SIGINT/SIGTERM or after ``duration``."""
    collector = Collector(source, config)
    loop = asyncio.get_running_loop()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, collector.stop)
        except (NotImplementedError, RuntimeError):
            pass  # not available on every platform

    task = asyncio.create_task(collector.run())
    if duration is not None:
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout=duration)
        except asyncio.TimeoutError:
            collector.stop()
            return await task
    return await task
