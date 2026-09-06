"""The paper trader: the real bot, against the real venue, with fake money.

This is the same decision loop a live executor runs.  It listens to actual
pump.fun launches, waits out the decision window, extracts the same features
the backtest used, asks the same strategy object, opens a position, and manages
the exit against real incoming trades.  The only thing it does not do is sign
a transaction.

That distinction is the entire value of this module.  A backtest can be wrong
in ways nothing inside it can detect - a feature that is cheap to compute over
a stored file and too slow to compute in the 200ms you actually have, a feed
that drops the trades you needed, a decision window that looked fine in
hindsight and is unreachable in practice.  Running the real loop against the
real market surfaces all of it, and the bill for finding out is zero.

Three properties are deliberate:

**No wallet, no keys, no signing.**  There is no code path from here to a
transaction.  The safety is structural, not a flag someone can flip by
accident.

**Fills are simulated pessimistically.**  Entry latency, the position's own
impact on the curve, protocol and priority fees, and a failure rate all apply,
using the same ``ExecutionModel`` the backtest uses.  A paper run that ignored
these would be a demo, not a measurement.

**Every event is still recorded.**  A paper session doubles as a collection
session, so the capture is there afterwards to backtest against - including
the launches the strategy declined, which are most of the information.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..curve import LAMPORTS_PER_SOL, quote_buy, sell_value, state_from_reserves
from ..execution import ExecutionModel, ExitPolicy
from ..features import CreatorHistory, extract
from ..models import EventType, TokenEvent
from ..reconstruct import TokenTimeline
from ..sources.base import EventSource
from ..storage import EventStore, RawLog
from ..strategy.base import Strategy
from .portfolio import ClosedTrade, LivePortfolio, LivePosition

log = logging.getLogger(__name__)


@dataclass
class TraderConfig:
    decision_age: float = 10.0
    starting_capital_sol: float = 10.0
    position_sol: float = 0.25
    max_concurrent: int = 3
    max_pool_share: float = 0.15
    max_slippage: float = 0.35

    log_dir: str = "data/paper"
    db_path: str = "data/paper.db"
    trades_path: str = "data/paper_trades.jsonl"

    # How long a token stays in memory after launch.  Anything still held past
    # this is closed by the time stop anyway.
    track_seconds: float = 900.0
    # How often to sweep for positions whose exit depends on the clock rather
    # than on a trade arriving - the dead ones, which are the majority.
    sweep_interval: float = 1.0

    paper: bool = True


@dataclass
class TraderStats:
    """Counters for the session.

    Carries the trader's clock rather than reading ``time.time`` itself, so a
    session driven by a virtual clock reports coherent numbers instead of an
    uptime measured against a wall clock it never used.
    """

    started_at: float = field(default_factory=time.time)
    events: int = 0
    launches: int = 0
    decisions: int = 0
    clock: object = time.time

    @property
    def now(self) -> float:
        return self.clock()

    @property
    def uptime(self) -> float:
        return max(0.0, self.clock() - self.started_at)


class PaperTrader:
    """Consumes a live source, decides, and manages simulated positions."""

    def __init__(
        self,
        source: EventSource,
        strategy: Strategy,
        config: TraderConfig | None = None,
        policy: ExitPolicy | None = None,
        model: ExecutionModel | None = None,
        clock=time.time,
    ):
        self.source = source
        self.strategy = strategy
        self.cfg = config or TraderConfig()
        self.policy = policy or ExitPolicy()
        self.execution = model or ExecutionModel()
        # Injectable so tests can drive a whole session in milliseconds without
        # the trader knowing it is not in real time.
        self.clock = clock

        if not self.cfg.paper:
            raise NotImplementedError(
                "live execution is not implemented; this module cannot sign transactions"
            )

        self.portfolio = LivePortfolio(
            starting_capital=self.cfg.starting_capital_sol,
            max_concurrent=self.cfg.max_concurrent,
            position_sol=self.cfg.position_sol,
        )
        self.stats = TraderStats(started_at=clock(), clock=clock)
        self.history = CreatorHistory()

        self.raw = RawLog(self.cfg.log_dir)
        self.store = EventStore(self.cfg.db_path)
        self._trades_file = Path(self.cfg.trades_path)
        self._trades_file.parent.mkdir(parents=True, exist_ok=True)

        # Per-mint event buffers, for tokens young enough to still matter.
        self._tracked: dict[str, list[TokenEvent]] = {}
        self._launched_at: dict[str, float] = {}
        self._symbols: dict[str, str] = {}
        self._pending: dict[str, float] = {}     # mint -> when to decide
        self._decided: set[str] = set()
        self._buffer: list[TokenEvent] = []
        self._stop = asyncio.Event()
        self.on_trade = None                      # optional callback for the UI

    # -- lifecycle -------------------------------------------------------

    async def run(self) -> LivePortfolio:
        """Consume the feed until stopped, then flatten the book on paper."""
        sweeper = asyncio.create_task(self._sweep_loop())
        try:
            async for event in self.source.stream():
                if self._stop.is_set():
                    break
                await self._on_event(event)
        except asyncio.CancelledError:
            pass
        finally:
            sweeper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sweeper
            self._close_all("session_end")
            self._flush()
            self.raw.close()
            await self.source.close()
        return self.portfolio

    def stop(self) -> None:
        self._stop.set()

    # -- event handling --------------------------------------------------

    async def _on_event(self, event: TokenEvent) -> None:
        self.raw.append(event)
        self._buffer.append(event)
        self.stats.events += 1
        if len(self._buffer) >= 400:
            self._flush()

        now = self.clock()

        if event.event_type is EventType.CREATE:
            self.stats.launches += 1
            self._tracked[event.mint] = [event]
            self._launched_at[event.mint] = event.block_time
            self._symbols[event.mint] = event.symbol or "?"
            self._pending[event.mint] = event.block_time + self.cfg.decision_age
            await self.source.watch(event.mint)
            return

        buffer = self._tracked.get(event.mint)
        if buffer is not None:
            buffer.append(event)

        # A trade on a token we hold re-marks the position immediately; this is
        # the fast path that decides whether an exit fires.
        position = self.portfolio.positions.get(event.mint)
        if position is not None and event.virtual_sol and event.virtual_tokens:
            state = state_from_reserves(event.virtual_sol, event.virtual_tokens)
            position.mark(state, now)
            self._maybe_exit(event.mint, now)

    async def _sweep_loop(self) -> None:
        """Drive everything that depends on the clock rather than on a trade.

        Two jobs that no incoming event will ever trigger: making a decision on
        a token whose window has elapsed in silence, and closing a position in
        a token that has simply stopped trading.  Without this the bot would
        hold dead tokens forever and never buy a quiet launch.
        """
        while not self._stop.is_set():
            try:
                await asyncio.sleep(self.cfg.sweep_interval)
                now = self.clock()
                self._decide_due(now)
                self._settle_due(now)
                self._retire(now)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("sweep failed; continuing")

    def _decide_due(self, now: float) -> None:
        for mint, due in list(self._pending.items()):
            if due <= now:
                self._pending.pop(mint, None)
                self._decide(mint, now)

    def _settle_due(self, now: float) -> None:
        for mint, position in list(self.portfolio.positions.items()):
            if position.trigger_reason and position.execute_at <= now:
                self._execute_exit(mint, now)
            elif not position.trigger_reason:
                # Re-check the time stop for tokens with no incoming trades.
                reason = position.check_exit(self.policy, now)
                if reason:
                    self._trigger(position, reason, now)

    def _retire(self, now: float) -> None:
        for mint, launched in list(self._launched_at.items()):
            if now - launched < self.cfg.track_seconds:
                continue
            if mint in self.portfolio.positions:
                continue
            self._launched_at.pop(mint, None)
            self._tracked.pop(mint, None)
            self._symbols.pop(mint, None)
            self._decided.discard(mint)

    # -- decisions -------------------------------------------------------

    def _decide(self, mint: str, now: float) -> None:
        """Score a launch whose decision window has elapsed, and maybe buy."""
        if mint in self._decided:
            return
        self._decided.add(mint)

        events = self._tracked.get(mint)
        if not events:
            return

        timeline = TokenTimeline(mint=mint, events=list(events))
        if timeline.create is None:
            return

        self.stats.decisions += 1
        self.portfolio.considered += 1
        features = extract(timeline, self.cfg.decision_age, self.history)

        # The creator's record updates from what we can see now.  Live there is
        # no future to wait for, so a launch contributes its own early peak -
        # partial information, but strictly causal, which is what matters.
        state_now = timeline.state_at(self.cfg.decision_age)
        open_state = timeline.open_state()
        early_peak = (
            state_now.price_sol / open_state.price_sol if open_state.price_sol else 1.0
        )
        self.history.record(timeline.creator, timeline.created_at, early_peak, False)

        decision = self.strategy.decide(features, mint)
        if not decision.enter:
            self.portfolio.rejected += 1
            return

        size = decision.size_sol or self.cfg.position_sol
        allowed, why = self.portfolio.can_open(size)
        if not allowed:
            if why == "no_slot":
                self.portfolio.skipped_no_slot += 1
            else:
                self.portfolio.skipped_no_capital += 1
            return

        # Never take a position we could not get back out of.
        pool_sol = state_now.real_sol / LAMPORTS_PER_SOL
        if pool_sol <= 0 or size / pool_sol > self.cfg.max_pool_share:
            self.portfolio.skipped_too_thin += 1
            return

        self._open(timeline, state_now, size, decision.score, now)

    def _open(self, timeline: TokenTimeline, state, size_sol: float,
              score: float, now: float) -> None:
        """Simulate the buy, with the same frictions the backtest applies."""
        self.portfolio.entries_attempted += 1
        fixed = self.execution.fixed_entry_cost

        if self.execution.entry_failed():
            self.portfolio.entries_failed += 1
            self.portfolio.charge(fixed)
            return

        if state.complete or state.price_sol <= 0:
            self.portfolio.entries_failed += 1
            self.portfolio.charge(fixed)
            return

        try:
            fill = quote_buy(state, int(size_sol * LAMPORTS_PER_SOL), self.execution.fee_bps)
        except Exception:
            self.portfolio.entries_failed += 1
            self.portfolio.charge(fixed)
            return

        position = LivePosition(
            mint=timeline.mint,
            symbol=self._symbols.get(timeline.mint, "?"),
            opened_at=now,
            entry_age=self.cfg.decision_age,
            tokens=fill.tokens_out,
            cost_lamports=int(size_sol * LAMPORTS_PER_SOL) + fixed,
            entry_price=fill.avg_price_sol,
            score=score,
            entry_value=fill.state.value_of(fill.tokens_out),
        )
        self.portfolio.open(position)
        log.info(
            "BUY  %-10s %s  %.3f SOL  score %.2f",
            position.symbol, timeline.mint[:12], size_sol, score,
        )

    # -- exits -----------------------------------------------------------

    def _maybe_exit(self, mint: str, now: float) -> None:
        position = self.portfolio.positions.get(mint)
        if position is None or position.trigger_reason:
            return
        reason = position.check_exit(self.policy, now)
        if reason:
            self._trigger(position, reason, now)

    def _trigger(self, position: LivePosition, reason: str, now: float) -> None:
        """Arm the sell; it lands after the reaction delay, not instantly."""
        position.trigger_reason = reason
        position.trigger_at = now
        position.execute_at = now + self.execution.sample_exit_delay()

    def _execute_exit(self, mint: str, now: float) -> ClosedTrade | None:
        position = self.portfolio.positions.get(mint)
        if position is None:
            return None

        # Sell into the most recent curve state we have seen for this token.
        state = self._latest_state(mint)
        if state is None:
            proceeds, exit_price = position.last_value, 0.0
        else:
            if self.execution.exit_failed():
                position.execute_at = now + self.execution.exit_retry_delay
                return None
            # Same valuation the backtester uses, graduation included, so a
            # paper trade and a backtested trade on the same token can never
            # disagree about what it was worth.
            proceeds = max(
                0, sell_value(state, position.tokens, self.policy.fee_bps)
                - self.execution.fixed_exit_cost
            )
            exit_price = state.price_sol

        trade = self.portfolio.close(mint, proceeds, position.trigger_reason, exit_price, now)
        if trade is not None:
            self._record_trade(trade)
            log.info(
                "SELL %-10s %s  %+.4f SOL  %.2fx  (%s)",
                trade.symbol, mint[:12], trade.pnl_sol, trade.multiple, trade.exit_reason,
            )
            if self.on_trade is not None:
                self.on_trade(trade)
        return trade

    def _latest_state(self, mint: str):
        for event in reversed(self._tracked.get(mint, [])):
            if event.virtual_sol and event.virtual_tokens:
                return state_from_reserves(event.virtual_sol, event.virtual_tokens)
        return None

    def _close_all(self, reason: str) -> None:
        """Flatten the book when the session ends, so nothing is left unmarked."""
        now = self.clock()
        for mint in list(self.portfolio.positions):
            position = self.portfolio.positions[mint]
            position.trigger_reason = position.trigger_reason or reason
            position.execute_at = now
            self._execute_exit(mint, now)

    # -- persistence -----------------------------------------------------

    def _record_trade(self, trade: ClosedTrade) -> None:
        with open(self._trades_file, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(trade.to_dict(), separators=(",", ":")) + "\n")

    def _flush(self) -> None:
        if not self._buffer:
            return
        try:
            self.store.insert_events(self._buffer)
        except Exception:
            log.exception("index write failed; the raw log is intact, reindex later")
        finally:
            self._buffer.clear()


async def run_paper_session(
    source: EventSource,
    strategy: Strategy,
    config: TraderConfig | None = None,
    policy: ExitPolicy | None = None,
    model: ExecutionModel | None = None,
    duration: float | None = None,
    clock=time.time,
) -> LivePortfolio:
    """Run a paper session, stopping after ``duration`` or on Ctrl-C."""
    import signal

    trader = PaperTrader(source, strategy, config, policy, model, clock)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, trader.stop)
        except (NotImplementedError, RuntimeError):
            pass

    task = asyncio.create_task(trader.run())
    if duration is not None:
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout=duration)
        except asyncio.TimeoutError:
            trader.stop()
            return await task
    return await task
