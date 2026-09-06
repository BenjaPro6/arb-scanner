"""The paper trader, driven end to end on a virtual clock.

A live trading loop is mostly a scheduling problem - decide at T+10s, exit when
a trade arrives *or* when nothing arrives for long enough - and scheduling bugs
do not show up in unit tests of the pieces.  So these run the real engine, with
the real strategy interface and the real execution model, over a whole
simulated session compressed into milliseconds.

The clock is injected rather than mocked globally: the trader is handed a
callable and cannot tell it is not in real time, so what is under test is the
production path and not a test-only branch.
"""

import asyncio
import json
from collections.abc import AsyncIterator

import pytest

from pumpscan.execution import ExecutionModel, ExitPolicy
from pumpscan.live.trader import PaperTrader, TraderConfig
from pumpscan.models import TokenEvent
from pumpscan.sources.base import EventSource
from pumpscan.sources.simulator import SimConfig, Simulator
from pumpscan.strategy.base import BuyEverything, BuyNothing, Decision, Strategy


class VirtualClock:
    """A clock the event stream drives, so a session runs as fast as the CPU."""

    def __init__(self, start: float):
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance_to(self, when: float) -> None:
        self.now = max(self.now, when)


class PacedSource(EventSource):
    """Replays events, moving the clock to each one and yielding to the loop.

    The yield matters: without it the async generator would run to completion
    without ever letting the trader's sweep task execute, and every
    clock-driven code path - decisions on quiet launches, time-stop exits -
    would go untested.
    """

    name = "paced"

    def __init__(self, events: list[TokenEvent], clock: VirtualClock):
        self.events = events
        self.clock = clock
        self.watched: list[str] = []

    async def stream(self) -> AsyncIterator[TokenEvent]:
        for event in self.events:
            self.clock.advance_to(event.recv_time)
            await asyncio.sleep(0)
            yield event
        # Let the clock run past the end so time stops can fire on the book.
        for _ in range(50):
            self.clock.advance_to(self.clock.now + 30)
            await asyncio.sleep(0)

    async def watch(self, mint: str) -> None:
        self.watched.append(mint)


def _session(tmp_path, strategy: Strategy, n_tokens=200, seed=31, **overrides):
    sim = Simulator(SimConfig(n_tokens=n_tokens, seed=seed))
    events = list(sim.generate())
    clock = VirtualClock(events[0].block_time - 1)

    config = TraderConfig(
        log_dir=str(tmp_path / "raw"),
        db_path=str(tmp_path / "paper.db"),
        trades_path=str(tmp_path / "trades.jsonl"),
        sweep_interval=0,
        **overrides,
    )
    trader = PaperTrader(
        PacedSource(events, clock),
        strategy,
        config,
        ExitPolicy(),
        ExecutionModel(seed=5),
        clock=clock,
    )
    portfolio = asyncio.run(trader.run())
    return trader, portfolio, sim


def test_a_session_opens_and_closes_positions(tmp_path):
    trader, portfolio, _ = _session(tmp_path, BuyEverything(0.25))

    assert trader.stats.launches == 200
    assert trader.stats.decisions > 0
    assert portfolio.entries_attempted > 0
    assert portfolio.closed, "no position was ever closed"
    # The book must be flat when the session ends.
    assert portfolio.positions == {}


def test_buying_nothing_leaves_capital_untouched(tmp_path):
    _, portfolio, _ = _session(tmp_path, BuyNothing())
    assert portfolio.closed == []
    assert portfolio.capital == portfolio.starting_capital
    assert portfolio.rejected == portfolio.considered > 0


def test_slot_limit_is_enforced_live(tmp_path):
    """The live path must respect concurrency, not just the backtester."""
    _, tight, _ = _session(tmp_path / "a", BuyEverything(0.25), max_concurrent=1)
    _, loose, _ = _session(tmp_path / "b", BuyEverything(0.25), max_concurrent=8)

    assert len(tight.closed) < len(loose.closed)
    assert tight.skipped_no_slot > loose.skipped_no_slot


def test_capital_is_never_overdrawn(tmp_path):
    """Small capital must throttle trading rather than go negative."""
    _, portfolio, _ = _session(
        tmp_path, BuyEverything(0.25), starting_capital_sol=1.0, max_concurrent=10
    )
    assert portfolio.skipped_no_capital > 0
    assert portfolio.capital >= -1e-9


def test_decisions_happen_only_after_the_window_has_elapsed(tmp_path):
    """No decision may be taken before its window is up.

    Deciding early is the live equivalent of a lookahead bug: the features
    would be computed over less data than the backtest assumed, and the two
    would silently stop being comparable.  So this checks the clock at the
    moment of each decision against that token's launch time.
    """
    sim = Simulator(SimConfig(n_tokens=150, seed=31))
    events = list(sim.generate())
    clock = VirtualClock(events[0].block_time - 1)
    launched = {e.mint: e.block_time for e in events if e.event_type.value == "create"}

    class ClockWatchingStrategy(Strategy):
        name = "clock_watcher"

        def __init__(self):
            self.at: list[tuple[str, float]] = []

        def decide(self, features, mint=""):
            self.at.append((mint, clock()))
            return Decision(enter=False, reason="watching")

    strategy = ClockWatchingStrategy()
    trader = PaperTrader(
        PacedSource(events, clock),
        strategy,
        TraderConfig(
            log_dir=str(tmp_path / "raw"),
            db_path=str(tmp_path / "p.db"),
            trades_path=str(tmp_path / "t.jsonl"),
            sweep_interval=0,
            decision_age=10.0,
        ),
        ExitPolicy(),
        ExecutionModel(seed=5),
        clock=clock,
    )
    asyncio.run(trader.run())

    assert len(strategy.at) > 50
    for mint, when in strategy.at:
        assert when >= launched[mint] + 10.0, (
            f"{mint} was decided {launched[mint] + 10.0 - when:.2f}s early"
        )
    # Each token is decided exactly once, however many trades it prints.
    assert len({mint for mint, _ in strategy.at}) == len(strategy.at)


def test_every_trade_is_written_to_disk(tmp_path):
    trader, portfolio, _ = _session(tmp_path, BuyEverything(0.25))
    path = tmp_path / "trades.jsonl"
    assert path.exists()

    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    assert len(rows) == len(portfolio.closed)
    for row in rows:
        assert {"mint", "pnl_sol", "multiple", "exit_reason", "held_for"} <= row.keys()
        assert row["cost_lamports"] > 0


def test_a_paper_session_also_produces_a_capture(tmp_path):
    """Paper trading doubles as collection, including the declined launches."""
    from pumpscan.reconstruct import iter_timelines
    from pumpscan.storage import RawLog

    trader, _, _ = _session(tmp_path, BuyNothing())
    events = list(RawLog(str(tmp_path / "raw")).read_all())
    assert len(events) == trader.stats.events

    timelines = list(iter_timelines(events))
    assert len(timelines) == 200, "declined launches must still be recorded"


def test_accounting_reconciles(tmp_path):
    """Capital must equal starting capital plus realised P&L, minus burnt fees."""
    _, portfolio, _ = _session(tmp_path, BuyEverything(0.25))

    burnt = portfolio.entries_failed * ExecutionModel().fixed_entry_cost / 1e9
    expected = portfolio.starting_capital + portfolio.realised_pnl - burnt
    assert portfolio.capital == pytest.approx(expected, abs=1e-6)
    # With a flat book, equity is just capital.
    assert portfolio.equity == pytest.approx(portfolio.capital, abs=1e-9)


def test_exit_reasons_are_all_legitimate(tmp_path):
    _, portfolio, _ = _session(tmp_path, BuyEverything(0.25))
    allowed = {
        "take_profit", "stop_loss", "trailing_stop", "max_hold", "session_end", "graduated",
    }
    assert {t.exit_reason for t in portfolio.closed} <= allowed


def test_live_execution_is_refused(tmp_path):
    """The safety is structural: there is no code path to signing."""
    with pytest.raises(NotImplementedError, match="cannot sign"):
        PaperTrader(
            PacedSource([], VirtualClock(0)),
            BuyEverything(),
            TraderConfig(paper=False),
        )


def test_no_wallet_or_signing_code_exists():
    """Guard against a future change quietly adding a way to spend real money."""
    import pathlib

    package = pathlib.Path(__file__).resolve().parent.parent / "pumpscan"
    forbidden = ("Keypair", "sign_transaction", "send_transaction", "PRIVATE_KEY", "secret_key")
    for path in package.rglob("*.py"):
        text = path.read_text()
        for token in forbidden:
            assert token not in text, f"{path.name} references {token}"


def test_display_uses_the_traders_clock_not_the_wall_clock(tmp_path):
    """Ages in the view must come from the session's own clock.

    Reading ``time.time()`` inside the renderer produced position ages of
    "1478431 minutes" for any session not running in real time - and, more to
    the point, made the view impossible to test at all.
    """
    from pumpscan.live.display import render

    sim = Simulator(SimConfig(n_tokens=120, seed=77))
    events = list(sim.generate())
    clock = VirtualClock(events[0].block_time - 1)

    trader = PaperTrader(
        PacedSource(events, clock),
        BuyEverything(0.25),
        TraderConfig(
            log_dir=str(tmp_path / "raw"),
            db_path=str(tmp_path / "p.db"),
            trades_path=str(tmp_path / "t.jsonl"),
            sweep_interval=0,
            max_concurrent=4,
        ),
        ExitPolicy(),
        ExecutionModel(seed=3),
        clock=clock,
    )

    async def go():
        task = asyncio.create_task(trader.run())
        for _ in range(400):
            await asyncio.sleep(0)
        frame = render(trader.portfolio, trader.stats)
        trader.stop()
        await task
        return frame

    frame = asyncio.run(go())

    # Uptime is bounded by the span of the capture, not by the epoch.
    assert trader.stats.uptime < 86_400
    assert "PAPER SESSION" in frame
    # No age may run into the millions of minutes.
    import re

    for value in re.findall(r"(\d+(?:\.\d+)?)m\b", frame):
        assert float(value) < 10_000, f"implausible age in the view: {value}m"
