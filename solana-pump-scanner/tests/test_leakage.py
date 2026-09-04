"""The guarantees that make the backtest worth running.

If any test in this file fails, every performance number the project produces
is void - not slightly optimistic, void.  A feature that can see one second
into the future in a market whose whole edge lives in the first ten seconds is
not a small bug.
"""

from pumpscan.features import CreatorHistory, extract
from pumpscan.reconstruct import iter_timelines
from pumpscan.sources.simulator import SimConfig, Simulator
from pumpscan.validation import leakage_audit


def _timelines(n=200, seed=3, signal=1.0):
    sim = Simulator(SimConfig(n_tokens=n, seed=seed, signal_strength=signal))
    return list(iter_timelines(sim.generate()))


def test_features_are_identical_when_the_future_is_deleted():
    """The structural proof: delete what we could not see, get the same answer."""
    report = leakage_audit(_timelines(), decision_age=10.0)
    assert report.clean, report.summary()
    assert report.checked > 100


def test_observable_never_exceeds_what_is_on_chain():
    """We can never have received an event that has not happened."""
    for tl in _timelines(80, seed=9):
        for age in (0.5, 1, 3, 10, 30, 120):
            assert len(tl.observable_at(age)) <= len(tl.chain_at(age))


def test_latency_actually_hides_events():
    """If nothing is ever hidden, the observability filter is not doing its job.

    A pipeline could pass every other leak test simply because its test data
    has zero latency, so this asserts the fixture is adversarial enough to make
    the other tests meaningful.
    """
    hidden = sum(
        len(tl.chain_at(age)) - len(tl.observable_at(age))
        for tl in _timelines(200, seed=4)
        for age in (1, 3, 10)
    )
    assert hidden > 0


def test_creator_history_only_sees_earlier_launches():
    """A dev's reputation must never be built from the token being scored."""
    history = CreatorHistory()
    history.record("devA", created_at=100.0, peak_multiple=5.0, rugged=True)
    history.record("devA", created_at=200.0, peak_multiple=1.0, rugged=False)

    n, rug_rate, median = history.stats("devA")
    assert n == 2
    assert rug_rate == 0.5
    assert median == 3.0

    # A creator we have never seen contributes nothing rather than a default
    # that would leak the population average into an individual prediction.
    assert history.stats("unknown") == (0, 0.0, 0.0)


def test_features_of_an_unseen_creator_are_marked_new():
    tl = _timelines(20, seed=1)[0]
    f = extract(tl, 10.0, CreatorHistory())
    assert f["creator_is_new"] == 1.0
    assert f["creator_launches"] == 0.0
    assert f["creator_rug_rate"] == 0.0


def test_decision_window_is_respected_for_every_age():
    """Widening the window may add information but must never remove it."""
    for tl in _timelines(40, seed=6):
        previous = 0
        for age in (1, 2, 5, 10, 20, 60):
            count = len(tl.observable_at(age))
            assert count >= previous
            previous = count


def test_timeline_without_creation_is_dropped():
    """Mints whose launch we missed have unknowable ages and must be excluded."""
    sim = Simulator(SimConfig(n_tokens=20, seed=2))
    events = [e for e in sim.generate() if e.event_type.value != "create"]
    assert list(iter_timelines(events)) == []


def test_after_and_between_partition_the_timeline():
    """Feature territory and label territory must not overlap or lose events."""
    for tl in _timelines(30, seed=8):
        cut = 10.0
        before = tl.between(0.0, cut)
        after = tl.after(cut)
        create = 1 if tl.create is not None else 0
        assert len(before) + len(after) + create == len(tl.events)
        assert not (set(map(id, before)) & set(map(id, after)))
