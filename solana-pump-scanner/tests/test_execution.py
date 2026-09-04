"""Execution frictions.

Each test here pins down a cost that a naive backtest sets to zero.  Together
they are the difference between a simulated edge and a real one.
"""

from pumpscan.execution import (
    ExecutionModel,
    ExitPolicy,
    attempt_entry,
    simulate_exit,
)
from pumpscan.reconstruct import iter_timelines
from pumpscan.sources.simulator import SimConfig, Simulator


def _timelines(n=120, seed=5):
    return list(iter_timelines(Simulator(SimConfig(n_tokens=n, seed=seed)).generate()))


def test_failed_entry_still_costs_money():
    """A transaction that does not land has still paid its fee."""
    model = ExecutionModel(entry_failure_rate=1.0, seed=1)
    tl = _timelines(10)[0]
    fill = attempt_entry(tl, 10.0, 0.25, model)
    assert not fill.filled
    assert fill.cost == model.fixed_entry_cost
    assert fill.cost > 0


def test_entry_delay_means_we_do_not_fill_at_the_decision_price():
    model = ExecutionModel(entry_failure_rate=0.0, entry_delay=3.0, delay_jitter=0.0, seed=2)
    moved = 0
    for tl in _timelines(120):
        decision_price = tl.state_at(10.0).price_sol
        fill = attempt_entry(tl, 10.0, 0.25, model, max_slippage=float("inf"))
        if fill.filled and abs(fill.price - decision_price) / decision_price > 1e-6:
            moved += 1
    assert moved > 0, "with a 3s delay some fills must land at a different price"


def test_slippage_guard_rejects_runaway_launches():
    """A tight guard must reject more entries than a loose one."""
    model = ExecutionModel(entry_failure_rate=0.0, entry_delay=3.0, delay_jitter=0.0, seed=3)
    timelines = _timelines(200)
    tight = sum(attempt_entry(tl, 10.0, 0.25, model, 0.02).filled for tl in timelines)
    model.reset()
    loose = sum(attempt_entry(tl, 10.0, 0.25, model, 10.0).filled for tl in timelines)
    assert tight < loose


def test_bigger_positions_fill_at_worse_prices():
    model = ExecutionModel(entry_failure_rate=0.0, delay_jitter=0.0, seed=4)
    for tl in _timelines(60):
        model.reset()
        small = attempt_entry(tl, 10.0, 0.05, model, max_slippage=float("inf"))
        model.reset()
        large = attempt_entry(tl, 10.0, 2.0, model, max_slippage=float("inf"))
        if small.filled and large.filled:
            assert large.price >= small.price


def test_stop_loss_does_not_return_the_stop_level():
    """The reaction delay is why a -45% stop does not lose 45%.

    A backtest that fills stops at the trigger price is claiming a reflex no
    network allows, and it flatters exactly the fast-collapsing tokens that
    hurt most in production.
    """
    instant = ExecutionModel(entry_failure_rate=0.0, exit_failure_rate=0.0,
                             exit_delay=0.0, delay_jitter=0.0, seed=5)
    delayed = ExecutionModel(entry_failure_rate=0.0, exit_failure_rate=0.0,
                             exit_delay=5.0, delay_jitter=0.0, seed=5)
    policy = ExitPolicy()

    worse = 0
    for tl in _timelines(200, seed=7):
        fill = attempt_entry(tl, 10.0, 0.25, instant, max_slippage=float("inf"))
        if not fill.filled:
            continue
        a = simulate_exit(tl, fill, policy, instant)
        b = simulate_exit(tl, fill, policy, delayed)
        if a.reason == "stop_loss" and b.proceeds < a.proceeds:
            worse += 1
    assert worse > 0, "a slower exit must sometimes realise less on a falling token"


def test_exit_retries_are_bounded():
    model = ExecutionModel(entry_failure_rate=0.0, exit_failure_rate=1.0, seed=6)
    policy = ExitPolicy()
    for tl in _timelines(40):
        fill = attempt_entry(tl, 10.0, 0.25, model, max_slippage=float("inf"))
        if fill.filled:
            assert simulate_exit(tl, fill, policy, model).retries <= model.max_exit_retries


def test_no_position_means_no_proceeds():
    model = ExecutionModel(entry_failure_rate=1.0, seed=7)
    tl = _timelines(5)[0]
    fill = attempt_entry(tl, 10.0, 0.25, model)
    assert simulate_exit(tl, fill, ExitPolicy(), model).proceeds == 0


def test_model_is_reproducible_after_reset():
    model = ExecutionModel(seed=11)
    first = [model.sample_entry_delay() for _ in range(20)]
    model.reset()
    assert [model.sample_entry_delay() for _ in range(20)] == first


def test_trailing_stop_locks_in_gains_on_tokens_that_run():
    """Where the trailing stop actually earns its keep.

    Not, as one might assume, by escaping rugs - see the test below for why it
    cannot - but by banking the gains on tokens that rise and then fade.  A
    token that runs 3x and drifts back to 1.2x pays nothing to a holder and
    pays well to a trailing stop.
    """
    model = ExecutionModel(entry_failure_rate=0.0, exit_failure_rate=0.0,
                           delay_jitter=0.0, seed=9)
    trailing = ExitPolicy(trailing_stop=0.3, take_profit=100.0, stop_loss=0.0, max_hold=300.0)
    hold = ExitPolicy(trailing_stop=1.0, take_profit=1e9, stop_loss=0.0, max_hold=300.0)

    with_trail = without = 0
    for tl in _timelines(600, seed=11):
        fill = attempt_entry(tl, 10.0, 0.25, model, max_slippage=float("inf"))
        if not fill.filled:
            continue
        with_trail += simulate_exit(tl, fill, trailing, model).proceeds
        without += simulate_exit(tl, fill, hold, model).proceeds

    assert with_trail > without, (
        f"trailing stop realised {with_trail} vs {without} holding"
    )


def test_an_atomic_rug_cannot_be_escaped():
    """A limitation worth pinning down, so nobody later mistakes it for a bug.

    When a creator empties their bag inside a single second, the trailing stop
    fires and the sell still lands after the collapse, because the reaction
    delay is longer than the dump.  The realised outcome is then identical to
    having no exit rule at all.

    This is not a modelling artefact - it is the actual risk of the venue, and
    the reason position sizing and *entry* filtering matter more than any exit
    rule.  If a change ever makes this test fail by making the exit look
    effective, suspect the change.
    """
    from pumpscan.label import label

    model = ExecutionModel(entry_failure_rate=0.0, exit_failure_rate=0.0,
                           delay_jitter=0.0, exit_delay=1.2, seed=9)
    trailing = ExitPolicy(trailing_stop=0.3, take_profit=100.0, stop_loss=0.0, max_hold=300.0)
    hold = ExitPolicy(trailing_stop=1.0, take_profit=1e9, stop_loss=0.0, max_hold=300.0)

    checked = identical = 0
    for tl in _timelines(600, seed=11):
        if not label(tl, 10.0).rugged:
            continue
        fill = attempt_entry(tl, 10.0, 0.25, model, max_slippage=float("inf"))
        if not fill.filled:
            continue
        checked += 1
        if simulate_exit(tl, fill, trailing, model).proceeds == simulate_exit(
            tl, fill, hold, model
        ).proceeds:
            identical += 1

    assert checked > 10, "need rugged tokens to make this meaningful"
    assert identical / checked > 0.8, (
        f"only {identical}/{checked} rugs were unescapable; the simulator's dumps "
        "may no longer be atomic"
    )


def test_speed_only_pays_on_the_way_down():
    """Latency is not uniformly expensive, which is worth knowing before tuning.

    On exits triggered by a *falling* position - stop loss, trailing stop -
    reacting sooner keeps materially more, because every extra second is spent
    in a market moving against the position.  On a take-profit the sign flips:
    the position is still climbing when the trigger fires, so a slower fill
    catches more of the run.

    Asserting the aggregate "faster is better" would therefore be false, and an
    earlier version of this test asserted exactly that and failed.  The useful
    claim is the conditional one.
    """
    fast = ExecutionModel(entry_failure_rate=0.0, exit_failure_rate=0.0,
                          exit_delay=0.1, delay_jitter=0.0, seed=3)
    slow = ExecutionModel(entry_failure_rate=0.0, exit_failure_rate=0.0,
                          exit_delay=8.0, delay_jitter=0.0, seed=3)
    policy = ExitPolicy()

    quick = patient = n = 0
    for tl in _timelines(400, seed=13):
        fill = attempt_entry(tl, 10.0, 0.25, fast, max_slippage=float("inf"))
        if not fill.filled:
            continue
        a = simulate_exit(tl, fill, policy, fast)
        if a.reason not in ("stop_loss", "trailing_stop"):
            continue
        n += 1
        quick += a.proceeds
        patient += simulate_exit(tl, fill, policy, slow).proceeds

    assert n > 20, "need enough downside exits for the comparison to mean anything"
    assert quick > patient, f"fast {quick} vs slow {patient} on downside exits"
