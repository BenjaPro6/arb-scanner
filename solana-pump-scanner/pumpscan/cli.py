"""Command line for the whole pipeline.

    pumpscan doctor       check this machine can reach the live venue  <- run this first
    pumpscan collect      capture the live market (run this on your own machine)
    pumpscan simulate     generate a synthetic capture, for development offline
    pumpscan reindex      rebuild the SQLite index from the raw log
    pumpscan stats        what is in the dataset
    pumpscan label        outcome distribution of a capture
    pumpscan validate     leakage audit + permutation test  <- run before believing anything
    pumpscan backtest     compare strategies on a capture
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import typer

from .backtest.engine import BacktestConfig, run_backtest
from .execution import ExecutionModel, ExitPolicy
from .reconstruct import iter_timelines
from .report import analyse, compare
from .storage import EventStore, RawLog
from .storage import reindex as do_reindex
from .strategy.base import BuyEverything, BuyNothing
from .strategy.ml import ModelStrategy, build_samples, walk_forward
from .strategy.rules import RuleStrategy

app = typer.Typer(add_completion=False, help="pump.fun launch scanner: collect, label, backtest.")


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def _load(log_dir: str) -> list:
    """Read a capture and rebuild timelines, or exit with something readable."""
    events = list(RawLog(log_dir).read_all())
    if not events:
        typer.secho(
            f"no events in {log_dir}. Run `pumpscan collect` (live) or "
            f"`pumpscan simulate` (offline) first.",
            fg=typer.colors.RED,
        )
        raise typer.Exit(1)
    timelines = list(iter_timelines(events))
    typer.echo(f"loaded {len(events)} events across {len(timelines)} tokens with a known launch")
    return timelines


@app.command()
def doctor(
    seconds: float = typer.Option(30.0, help="How long to watch the live feed."),
    show: int = typer.Option(10, help="How many launches to print as they arrive."),
) -> None:
    """Check this machine can reach the live pump.fun feed. Run this first."""
    from .doctor import run_check

    typer.echo(f"watching the live feed for {seconds:.0f}s; real launches appear below\n")
    report = run_check(seconds, show)
    colour = typer.colors.GREEN if report.healthy else typer.colors.RED
    typer.secho("\n" + report.summary(), fg=colour)
    if not report.healthy:
        raise typer.Exit(1)


@app.command()
def collect(
    log_dir: str = typer.Option("data/raw", help="Where the append-only event log goes."),
    db: str = typer.Option("data/events.db", help="SQLite index path."),
    minutes: float = typer.Option(0, help="Stop after this long; 0 runs until Ctrl-C."),
    watch_seconds: float = typer.Option(600.0, help="How long to follow each token."),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Capture the live pump.fun feed. Needs outbound network access."""
    from .collect import CollectorConfig, collect as run_collect
    from .sources.pumpportal import PumpPortalSource

    _setup_logging(verbose)
    cfg = CollectorConfig(log_dir=log_dir, db_path=db, watch_seconds=watch_seconds)
    source = PumpPortalSource(max_watched=cfg.max_watched)
    duration = minutes * 60 if minutes > 0 else None

    typer.echo("connecting to PumpPortal; Ctrl-C to stop cleanly")
    stats = asyncio.run(run_collect(source, cfg, duration))
    typer.secho(stats.line(), fg=typer.colors.GREEN)


@app.command()
def simulate(
    log_dir: str = typer.Option("data/sim", help="Where to write the synthetic capture."),
    db: str = typer.Option("data/sim.db"),
    tokens: int = typer.Option(1200, help="Number of launches to generate."),
    seed: int = typer.Option(7),
    signal: float = typer.Option(
        1.0,
        help="1.0 = archetypes are distinguishable early; 0.0 = no early signal exists.",
    ),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Generate a synthetic capture, so the pipeline can be exercised offline."""
    from .collect import CollectorConfig, collect as run_collect
    from .sources.simulator import SimConfig, SimulatorSource

    _setup_logging(verbose)
    source = SimulatorSource(SimConfig(n_tokens=tokens, seed=seed, signal_strength=signal))
    cfg = CollectorConfig(log_dir=log_dir, db_path=db)
    stats = asyncio.run(run_collect(source, cfg))
    typer.secho(stats.line(), fg=typer.colors.GREEN)
    if signal == 0.0:
        typer.secho(
            "signal=0: any edge a strategy reports on this capture is a bug.",
            fg=typer.colors.YELLOW,
        )


@app.command()
def reindex(
    log_dir: str = typer.Option("data/raw"),
    db: str = typer.Option("data/events.db"),
) -> None:
    """Rebuild the SQLite index from the raw log."""
    n = do_reindex(log_dir, db)
    typer.secho(f"reindexed {n} events into {db}", fg=typer.colors.GREEN)


@app.command()
def stats(db: str = typer.Option("data/events.db")) -> None:
    """Summarise what a dataset contains."""
    if not Path(db).exists():
        typer.secho(f"{db} does not exist; run collect or reindex first", fg=typer.colors.RED)
        raise typer.Exit(1)
    s = EventStore(db).stats()
    span = (s["last_ts"] - s["first_ts"]) / 3600 if s["events"] else 0
    typer.echo(f"tokens : {s['tokens']}")
    typer.echo(f"events : {s['events']}")
    typer.echo(f"span   : {span:.1f} hours")


@app.command()
def label(
    log_dir: str = typer.Option("data/raw"),
    decision_age: float = typer.Option(10.0, help="Seconds after launch when we decide."),
    position: float = typer.Option(0.25, help="Position size in SOL."),
) -> None:
    """Show what actually happened to the tokens in a capture."""
    import statistics as st

    from .label import label_all

    timelines = _load(log_dir)
    outcomes = label_all(timelines, decision_age, position_sol=position)
    values = list(outcomes.values())
    if not values:
        raise typer.Exit(1)

    realizable = sorted(o.realizable_multiple for o in values)
    peaks = sorted(o.peak_multiple for o in values)

    def pct(xs, q):
        return xs[min(len(xs) - 1, int(q * len(xs)))]

    typer.echo(f"\ndecision at {decision_age:.0f}s, position {position} SOL, {len(values)} tokens\n")
    typer.echo(f"{'':16s}{'median':>9}{'p75':>9}{'p90':>9}{'p99':>9}{'max':>9}")
    typer.echo(f"{'peak multiple':16s}{st.median(peaks):>9.2f}{pct(peaks,.75):>9.2f}"
               f"{pct(peaks,.90):>9.2f}{pct(peaks,.99):>9.2f}{peaks[-1]:>9.2f}")
    typer.echo(f"{'realizable':16s}{st.median(realizable):>9.2f}{pct(realizable,.75):>9.2f}"
               f"{pct(realizable,.90):>9.2f}{pct(realizable,.99):>9.2f}{realizable[-1]:>9.2f}")
    typer.echo(
        f"\nrugged {100 * sum(o.rugged for o in values) / len(values):.1f}%  |  "
        f"dumped {100 * sum(o.dumped for o in values) / len(values):.1f}%  |  "
        f"graduated {100 * sum(o.graduated for o in values) / len(values):.1f}%"
    )
    typer.secho(
        "\nthe gap between 'peak' and 'realizable' is what a mechanical exit costs you.\n"
        "train on realizable; peaks are unreachable.",
        fg=typer.colors.YELLOW,
    )


@app.command()
def validate(
    log_dir: str = typer.Option("data/raw"),
    decision_age: float = typer.Option(10.0),
    permutations: int = typer.Option(24, help="At least 19 are needed to reach p<=0.05."),
    folds: int = typer.Option(4),
) -> None:
    """Try to prove the pipeline wrong. Run this before believing any backtest."""
    from .validation import leakage_audit, permutation_test, sample_size_check

    timelines = _load(log_dir)

    typer.secho("\n[1/3] structural leakage audit", bold=True)
    leak = leakage_audit(timelines, decision_age)
    typer.secho(leak.summary(), fg=typer.colors.GREEN if leak.clean else typer.colors.RED)
    if not leak.clean:
        raise typer.Exit(1)

    typer.secho("\n[2/3] permutation test (shuffled outcomes must yield nothing)", bold=True)
    samples = build_samples(timelines, decision_age)
    perm = permutation_test(samples, n_permutations=permutations, n_folds=folds)
    colour = {
        "signal": typer.colors.GREEN,
        "noise": typer.colors.RED,
        "inconclusive": typer.colors.YELLOW,
    }[perm.verdict]
    typer.secho(perm.summary(), fg=colour)

    typer.secho("\n[3/3] sample size", bold=True)
    size = sample_size_check(samples, n_trades=len(samples))
    typer.secho(size.summary(), fg=typer.colors.GREEN if size.adequate else typer.colors.YELLOW)


@app.command()
def backtest(
    log_dir: str = typer.Option("data/raw"),
    decision_age: float = typer.Option(10.0),
    capital: float = typer.Option(10.0, help="Starting capital in SOL."),
    position: float = typer.Option(0.25, help="Position size in SOL."),
    max_concurrent: int = typer.Option(3),
    take_profit: float = typer.Option(3.0),
    stop_loss: float = typer.Option(0.55),
    trailing_stop: float = typer.Option(0.35),
    max_hold: float = typer.Option(300.0),
    threshold: float = typer.Option(0.5, help="Model score needed to enter."),
    folds: int = typer.Option(5),
    detail: bool = typer.Option(False, "--detail", help="Full metrics per strategy."),
) -> None:
    """Compare strategies on a capture, with realistic costs and constraints."""
    timelines = _load(log_dir)

    policy = ExitPolicy(
        take_profit=take_profit,
        stop_loss=stop_loss,
        trailing_stop=trailing_stop,
        max_hold=max_hold,
    )
    config = BacktestConfig(
        decision_age=decision_age,
        starting_capital_sol=capital,
        position_sol=position,
        max_concurrent=max_concurrent,
    )

    typer.echo("training walk-forward model (out-of-sample scores only)...")
    samples = build_samples(timelines, decision_age, policy, position)
    wf = walk_forward(samples, n_folds=folds)
    typer.echo(
        f"  folds AUC {[round(a, 3) for a in wf.fold_auc]} (mean {wf.mean_auc:.3f}), "
        f"{wf.n_scored} tokens scored, {100 * wf.positive_rate:.1f}% positive"
    )

    strategies = [
        BuyNothing(),
        BuyEverything(position),
        RuleStrategy(),
        ModelStrategy(wf.scores, threshold, position),
    ]
    results = {}
    for strategy in strategies:
        results[strategy.name] = run_backtest(
            timelines, strategy, config, policy, ExecutionModel()
        )

    typer.echo("\n" + compare(results))

    if detail:
        for name, result in results.items():
            typer.secho(f"\n--- {name} ---", bold=True)
            typer.echo(analyse(result, name).summary())

    if wf.feature_importance:
        top = sorted(wf.feature_importance.items(), key=lambda kv: -kv[1])[:10]
        typer.secho("\nmost-used features:", bold=True)
        for name, weight in top:
            typer.echo(f"  {name:24s} {weight:.3f}")

    typer.secho(
        "\nbefore acting on any of this, run `pumpscan validate`.",
        fg=typer.colors.YELLOW,
    )


def main() -> None:
    app()


if __name__ == "__main__":
    main()
