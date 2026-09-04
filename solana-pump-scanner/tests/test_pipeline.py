"""End-to-end: capture -> store -> reload -> label -> backtest.

These exercise the seams between modules, which is where data pipelines
actually break: a field that survives the websocket parser and dies in the
JSONL round trip, an index that silently drops duplicates it should keep.
"""

import asyncio

import pytest

from pumpscan.backtest.engine import BacktestConfig, run_backtest
from pumpscan.collect import CollectorConfig, collect
from pumpscan.label import label_all
from pumpscan.reconstruct import iter_timelines
from pumpscan.report import analyse, compare
from pumpscan.sources.pumpportal import parse_message
from pumpscan.sources.replay import ReplaySource
from pumpscan.sources.simulator import SimConfig, SimulatorSource
from pumpscan.storage import EventStore, RawLog, reindex
from pumpscan.strategy.base import BuyEverything, BuyNothing
from pumpscan.strategy.ml import ModelStrategy, build_samples, walk_forward
from pumpscan.strategy.rules import RuleStrategy


@pytest.fixture
def capture(tmp_path):
    """A collected synthetic session on disk, as the CLI would leave it."""
    cfg = CollectorConfig(
        log_dir=str(tmp_path / "raw"),
        db_path=str(tmp_path / "events.db"),
        flush_every=200,
    )
    source = SimulatorSource(SimConfig(n_tokens=300, seed=21))
    stats = asyncio.run(collect(source, cfg))
    return cfg, stats


def test_collect_persists_everything_it_saw(capture):
    cfg, stats = capture
    assert stats.creates == 300
    assert stats.events == stats.creates + stats.trades
    # Every event reached both the log and the index.
    assert len(list(RawLog(cfg.log_dir).read_all())) == stats.events
    assert EventStore(cfg.db_path).stats()["events"] == stats.events


def test_raw_log_round_trip_preserves_fields(capture):
    cfg, _ = capture
    events = list(RawLog(cfg.log_dir).read_all())
    create = next(e for e in events if e.event_type.value == "create")
    assert create.mint and create.creator and create.symbol
    assert create.virtual_sol > 0 and create.virtual_tokens > 0
    assert create.recv_time >= create.block_time


def test_reindex_is_idempotent(capture):
    cfg, stats = capture
    before = EventStore(cfg.db_path).stats()["events"]
    reindex(cfg.log_dir, cfg.db_path)
    reindex(cfg.log_dir, cfg.db_path)
    assert EventStore(cfg.db_path).stats()["events"] == before == stats.events


def test_replay_reproduces_the_capture_exactly(capture):
    cfg, stats = capture
    first = ReplaySource(log_dir=cfg.log_dir).events()
    second = ReplaySource(log_dir=cfg.log_dir).events()
    assert len(first) == stats.events
    assert [e.signature for e in first] == [e.signature for e in second]


def test_backtest_is_deterministic(capture):
    """Same inputs, same numbers - otherwise no result can be compared."""
    cfg, _ = capture
    timelines = list(iter_timelines(RawLog(cfg.log_dir).read_all()))
    a = run_backtest(timelines, BuyEverything(), BacktestConfig())
    b = run_backtest(timelines, BuyEverything(), BacktestConfig())
    assert a.ending_capital == b.ending_capital
    assert [t.mint for t in a.trades] == [t.mint for t in b.trades]


def test_portfolio_constraints_actually_bind(capture):
    """A single-slot portfolio must trade less than a three-slot one."""
    cfg, _ = capture
    timelines = list(iter_timelines(RawLog(cfg.log_dir).read_all()))
    tight = run_backtest(timelines, BuyEverything(), BacktestConfig(max_concurrent=1))
    loose = run_backtest(timelines, BuyEverything(), BacktestConfig(max_concurrent=10))
    assert len(tight.filled_trades) < len(loose.filled_trades)
    assert tight.skipped_no_slot > loose.skipped_no_slot


def test_buy_nothing_never_moves_capital(capture):
    cfg, _ = capture
    timelines = list(iter_timelines(RawLog(cfg.log_dir).read_all()))
    result = run_backtest(timelines, BuyNothing(), BacktestConfig())
    assert result.trades == []
    assert result.ending_capital == result.starting_capital


def test_full_pipeline_produces_a_comparable_report(capture):
    cfg, _ = capture
    timelines = list(iter_timelines(RawLog(cfg.log_dir).read_all()))

    samples = build_samples(timelines, 10.0)
    assert len(samples) == len(timelines)

    wf = walk_forward(samples, n_folds=3, min_train=50)
    assert wf.n_scored > 0
    # The seed block must be left unscored rather than scored in-sample.
    assert wf.n_scored < len(samples)

    results = {
        s.name: run_backtest(timelines, s, BacktestConfig())
        for s in (BuyNothing(), BuyEverything(), RuleStrategy(), ModelStrategy(wf.scores))
    }
    text = compare(results)
    assert "buy_everything" in text and "model" in text

    metrics = analyse(results["buy_everything"], "buy_everything")
    assert metrics.n_considered == len(timelines)
    # Fees make the accounting strict: P&L cannot be a rounding of zero.
    assert metrics.n_filled > 0


def test_labels_are_bounded_and_sane(capture):
    cfg, _ = capture
    timelines = list(iter_timelines(RawLog(cfg.log_dir).read_all()))
    outcomes = label_all(timelines, 10.0)
    for o in outcomes.values():
        assert o.realizable_multiple >= 0.0
        assert o.peak_multiple >= 1.0 or o.n_trades_after == 0
        # You cannot realise more than the theoretical peak.
        assert o.realizable_multiple <= o.peak_multiple * 1.05
        assert 0.0 <= o.max_drawdown <= 1.0


def test_pumpportal_frames_parse_into_events():
    """Guard the live parser against silent field drift."""
    create = parse_message(
        {
            "signature": "sig1",
            "mint": "MintAAA",
            "traderPublicKey": "DevWallet",
            "txType": "create",
            "initialBuy": 34_277_837.66,
            "solAmount": 1.0,
            "vTokensInBondingCurve": 1_038_722_353.34,
            "vSolInBondingCurve": 30.99,
            "name": "Test",
            "symbol": "TST",
            "pool": "pump",
        },
        recv_time=1000.0,
    )
    assert create is not None
    assert create.event_type.value == "create"
    assert create.creator == "DevWallet"
    assert create.sol_amount == 1_000_000_000
    assert create.virtual_sol == 30_990_000_000

    buy = parse_message(
        {
            "signature": "sig2",
            "mint": "MintAAA",
            "traderPublicKey": "Buyer",
            "txType": "buy",
            "solAmount": 0.5,
            "tokenAmount": 1_000_000.0,
            "vTokensInBondingCurve": 1_000_000_000.0,
            "vSolInBondingCurve": 31.5,
        },
        recv_time=1001.0,
    )
    assert buy is not None and buy.event_type.value == "buy"
    assert buy.creator == ""

    # Control frames and unknown transaction types must not become events.
    assert parse_message({"message": "Successfully subscribed"}) is None
    assert parse_message({"mint": "X", "txType": "migrate"}) is None
    assert parse_message({"txType": "buy"}) is None


def test_unknown_fields_are_preserved_for_later():
    """A field we do not understand today must survive to be understood later."""
    event = parse_message(
        {"signature": "s", "mint": "M", "txType": "buy", "someNewField": 42},
        recv_time=1.0,
    )
    assert event is not None
    assert event.extra["someNewField"] == 42
