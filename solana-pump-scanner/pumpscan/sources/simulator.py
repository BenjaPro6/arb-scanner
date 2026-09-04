"""A synthetic pump.fun market.

Why this exists.  You cannot write a trustworthy backtester by pointing it at
live data and squinting at the output: when the answer comes back "you would
have made 3x", there is no way to tell a real edge from a bug.  The simulator
gives us a market whose ground truth we *know*, so the pipeline can be checked
against it:

  * feed it launches with a genuine, known signal -> the backtest must find it
  * feed it launches with no signal at all -> the backtest must report nothing

The second test is the important one.  A backtester that finds profit in pure
noise is worse than useless, and that failure mode is invisible on real data.

The model is deliberately simple but structurally honest: every trade is pushed
through the real bonding curve from ``curve.py``, so prices, slippage and
graduation behave exactly as they do on chain.  What is synthetic is *who
trades and when*, not the arithmetic.

Archetypes, with roughly the frequencies the live market showed when this was
written.  Treat them as a scaffold to test code against, not as a forecast:
recalibrate from your own capture before drawing conclusions about strategy.
"""

from __future__ import annotations

import random
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from enum import Enum

from ..curve import CurveState, lamports, quote_buy, quote_sell
from ..models import EventType, TokenEvent
from .base import EventSource


class Archetype(str, Enum):
    DUD = "dud"                # never gets traction, bleeds out
    RUG = "rug"                # dev accumulates, invites buyers, dumps
    BUNDLE = "bundle"          # correlated wallets buy at t=0, exit into retail
    ORGANIC = "organic"        # real interest, sustained, may graduate

    def __str__(self) -> str:
        return self.value


# Population mix.  Duds dominate; that lopsidedness is the point.
DEFAULT_MIX = {
    Archetype.DUD: 0.68,
    Archetype.RUG: 0.16,
    Archetype.BUNDLE: 0.10,
    Archetype.ORGANIC: 0.06,
}


@dataclass
class SimConfig:
    """Knobs for the synthetic market."""

    n_tokens: int = 500
    start_time: float = 1_700_000_000.0
    launch_interval: float = 12.0        # mean seconds between launches
    mix: dict[Archetype, float] = field(default_factory=lambda: dict(DEFAULT_MIX))
    seed: int = 7

    # How strongly the observable early behaviour reveals the archetype.
    # 1.0 = archetypes behave very differently in their first seconds.
    # 0.0 = every archetype opens identically, so no early signal exists and
    #       an honest backtest must come back empty-handed.
    signal_strength: float = 1.0

    # Latency the collector experiences, in seconds.
    latency_mean: float = 0.35
    latency_jitter: float = 0.25


@dataclass
class SimToken:
    """Ground truth for one simulated token, for scoring the pipeline."""

    mint: str
    archetype: Archetype
    creator: str
    created_at: float
    peak_multiple: float = 1.0
    time_to_peak: float = 0.0
    graduated: bool = False


class Simulator:
    """Generates event streams plus the ground truth behind them."""

    def __init__(self, config: SimConfig | None = None):
        self.cfg = config or SimConfig()
        self.rng = random.Random(self.cfg.seed)
        self.truth: dict[str, SimToken] = {}
        # A pool of dev wallets, so creator history is a real, learnable signal:
        # serial ruggers reuse wallets, and the feature layer should notice.
        self._devs = [f"dev{i:04d}" for i in range(max(8, self.cfg.n_tokens // 6))]
        self._dev_bias: dict[str, float] = {
            d: self.rng.betavariate(2, 5) for d in self._devs
        }

    # -- helpers ---------------------------------------------------------

    def _pick_archetype(self, dev: float) -> Archetype:
        """Choose an archetype, tilted by the dev wallet's disposition.

        A wallet that rugged before is likelier to rug again.  This is the
        latent structure the creator-history features are meant to recover.
        """
        weights = dict(self.cfg.mix)
        tilt = self.cfg.signal_strength * dev
        weights[Archetype.RUG] *= 1.0 + 2.0 * tilt
        weights[Archetype.ORGANIC] *= max(0.15, 1.0 - 0.8 * tilt)
        total = sum(weights.values())
        r = self.rng.random() * total
        acc = 0.0
        for arch, w in weights.items():
            acc += w
            if r <= acc:
                return arch
        return Archetype.DUD

    def _latency(self) -> float:
        return max(0.02, self.rng.gauss(self.cfg.latency_mean, self.cfg.latency_jitter))

    def _trade_plan(self, arch: Archetype) -> list[tuple[float, float, bool, str]]:
        """Build (offset_seconds, sol_size, is_buy, actor) for one token's life.

        The actor label matters: a rug is only a rug because *the same wallet*
        that accumulated is the one that dumps, and a bundle only unwinds
        because the wallets that sniped are the wallets that exit.  Assigning
        traders at random would scatter those sells across wallets holding
        nothing, and the pattern the whole project is meant to detect would
        quietly never happen.

        ``signal_strength`` interpolates each archetype's early behaviour
        toward a common baseline.  At 0 the opening seconds of a rug and an
        organic run are indistinguishable, which is exactly the null case the
        backtester has to survive.
        """
        s = self.cfg.signal_strength
        plan: list[tuple[float, float, bool, str]] = []

        def blend(distinct: float, baseline: float) -> float:
            return baseline + s * (distinct - baseline)

        # Shared neutral parameters.  At signal_strength=0 every archetype
        # draws its *observable* early behaviour - how many trades, how big,
        # how fast, how much the dev opened with - from these identical
        # numbers, so nothing visible in the first seconds carries information
        # about which archetype a token is.  Only the late behaviour (the dump,
        # the unwind) still differs, which is what makes outcomes diverge
        # without any early tell.  Blending only the *timing* while leaving
        # trade counts archetype-specific, as an earlier version of this did,
        # leaves a gaping tell: a token with 200 early trades was obviously not
        # a dud, and the "no signal" test silently measured nothing.
        n_neutral = self.rng.randint(6, 40)
        spacing_neutral = 6.0
        size_neutral_lo, size_neutral_hi = 0.1, 1.2
        dev_neutral = self.rng.uniform(0.2, 1.5)

        def blend_count(distinct: int) -> int:
            return max(1, int(round(blend(float(distinct), float(n_neutral)))))

        def blend_size(lo: float, hi: float) -> float:
            return self.rng.uniform(blend(lo, size_neutral_lo), blend(hi, size_neutral_hi))

        if arch is Archetype.DUD:
            # A dud does not simply stall - the handful of wallets that opened
            # it give up and take their SOL back out, so it ends *below* where
            # it started.  Modelling duds as flat would make "buy everything"
            # look survivable, and it very much is not.
            n = blend_count(self.rng.randint(2, 9))
            t = 0.0
            for i in range(n):
                t += self.rng.expovariate(1 / blend(25.0, spacing_neutral))
                plan.append((t, blend_size(0.05, 0.6), self.rng.random() > 0.35, f"retail{i % 6}"))
            for i in range(6):
                t += self.rng.expovariate(1 / 20.0)
                plan.append((t, 0.0, False, f"retail{i}"))

        elif arch is Archetype.BUNDLE:
            # A cluster of near-simultaneous buys in the first second, then the
            # same size flowing back out once retail has arrived.
            n_snipers = blend_count(self.rng.randint(6, 16))
            for i in range(n_snipers):
                plan.append(
                    (self.rng.uniform(0.0, blend(1.2, 12.0)), blend_size(0.4, 2.2), True, f"sniper{i}")
                )
            t = blend(8.0, 30.0)
            for i in range(blend_count(self.rng.randint(4, 14))):
                t += self.rng.expovariate(1 / spacing_neutral)
                plan.append((t, blend_size(0.1, 1.0), self.rng.random() > 0.3, f"retail{i % 8}"))
            # The same snipers unwind into whoever showed up.
            t = blend(25.0, 90.0)
            for i in range(n_snipers):
                plan.append((t + i * 0.4, 0.0, False, f"sniper{i}"))

        elif arch is Archetype.RUG:
            # A real rug is an accumulation, not a single opening buy: the dev
            # (through their own wallet cluster) keeps adding while retail
            # arrives, ending up holding a dominant share of the float, and
            # only then empties it.  Modelling the dev as a one-shot buyer
            # produces a gentle retracement instead of a collapse, and a
            # labeller calibrated on that would never learn what a rug is.
            dev_size = blend(self.rng.uniform(1.5, 4.0), dev_neutral)
            plan.append((self.rng.uniform(0.0, 0.5), dev_size, True, "dev"))
            t = 0.0
            n_retail = blend_count(self.rng.randint(10, 40))
            for i in range(n_retail):
                t += self.rng.expovariate(1 / blend(3.5, spacing_neutral))
                plan.append((t, blend_size(0.1, 1.5), self.rng.random() > 0.25, f"retail{i % 10}"))
                # Dev tops up alongside the crowd, in its own wallets.
                if s > 0.3 and i % max(3, int(8 - 5 * s)) == 0:
                    plan.append(
                        (t + 0.2, dev_size * self.rng.uniform(0.4, 1.1), True, f"devalt{i % 3}")
                    )
            dump_at = t + blend(self.rng.uniform(2, 20), self.rng.uniform(40, 200))
            # The whole cluster exits within a couple of seconds of each other.
            plan.append((dump_at, 0.0, False, "dev"))
            for j in range(3):
                plan.append((dump_at + 0.3 * (j + 1), 0.0, False, f"devalt{j}"))

        else:  # ORGANIC
            t = 0.0
            rate = blend(1.6, spacing_neutral)
            for i in range(blend_count(self.rng.randint(60, 240))):
                t += self.rng.expovariate(1 / rate)
                plan.append((t, blend_size(0.2, 4.0), self.rng.random() > 0.2, f"retail{i % 30}"))

        plan.sort(key=lambda p: p[0])
        return plan

    # -- generation ------------------------------------------------------

    def generate(self) -> Iterator[TokenEvent]:
        """Yield every event of the simulated market in chain order."""
        events: list[TokenEvent] = []
        now = self.cfg.start_time

        for i in range(self.cfg.n_tokens):
            now += self.rng.expovariate(1 / self.cfg.launch_interval)
            mint = f"SIM{i:06d}"
            dev = self.rng.choice(self._devs)
            arch = self._pick_archetype(self._dev_bias[dev])
            truth = SimToken(mint=mint, archetype=arch, creator=dev, created_at=now)
            self.truth[mint] = truth

            state = CurveState()
            dev_buy = self.rng.uniform(0.0, 1.5) if self.rng.random() < 0.7 else 0.0
            tokens_out = 0
            if dev_buy > 0:
                res = quote_buy(state, lamports(dev_buy))
                state, tokens_out = res.state, res.tokens_out

            events.append(
                TokenEvent(
                    mint=mint,
                    event_type=EventType.CREATE,
                    block_time=now,
                    recv_time=now + self._latency(),
                    signature=f"sig-{mint}-create",
                    trader=dev,
                    creator=dev,
                    sol_amount=lamports(dev_buy),
                    token_amount=tokens_out,
                    virtual_sol=state.virtual_sol,
                    virtual_tokens=state.virtual_tokens,
                    name=f"Sim {i}",
                    symbol=f"S{i:04d}",
                )
            )

            open_price = state.price_sol
            peak_price = open_price
            peak_at = 0.0
            # Track holdings so a seller can only sell what it actually owns -
            # otherwise the simulated curve drifts away from anything possible.
            holdings: dict[str, int] = {dev: tokens_out}

            for seq, (offset, size_sol, is_buy, actor) in enumerate(self._trade_plan(arch)):
                if state.complete:
                    truth.graduated = True
                    break
                ts = now + offset
                trader = dev if actor == "dev" else f"{mint[-4:]}{actor}"

                if is_buy:
                    res = quote_buy(state, lamports(size_sol))
                    holdings[trader] = holdings.get(trader, 0) + res.tokens_out
                    state = res.state
                    sol_amt, tok_amt = res.sol_in_net + res.fee, res.tokens_out
                else:
                    have = holdings.get(trader, 0)
                    if have <= 0:
                        continue
                    # size 0.0 means "dump the whole bag"; otherwise sell a slice.
                    want = have if size_sol == 0.0 else min(have, max(1, int(have * self.rng.uniform(0.4, 1.0))))
                    res = quote_sell(state, want)
                    holdings[trader] = have - want
                    state = res.state
                    sol_amt, tok_amt = res.sol_out_net, want

                if state.price_sol > peak_price:
                    peak_price, peak_at = state.price_sol, offset

                events.append(
                    TokenEvent(
                        mint=mint,
                        event_type=EventType.BUY if is_buy else EventType.SELL,
                        block_time=ts,
                        recv_time=ts + self._latency(),
                        signature=f"sig-{mint}-{seq}",
                        trader=trader,
                        sol_amount=sol_amt,
                        token_amount=tok_amt,
                        virtual_sol=state.virtual_sol,
                        virtual_tokens=state.virtual_tokens,
                    )
                )

            truth.peak_multiple = peak_price / open_price if open_price else 1.0
            truth.time_to_peak = peak_at
            truth.graduated = truth.graduated or state.complete

        events.sort(key=lambda e: (e.block_time, e.mint))
        yield from events

    def ground_truth(self) -> dict[str, SimToken]:
        """Archetype and realised outcome per mint.  Only for validating code."""
        return self.truth


class SimulatorSource(EventSource):
    """``EventSource`` wrapper so the simulator drops into any pipeline."""

    name = "simulator"

    def __init__(self, config: SimConfig | None = None):
        self.sim = Simulator(config)

    async def stream(self) -> AsyncIterator[TokenEvent]:
        for event in self.sim.generate():
            yield event

    def ground_truth(self) -> dict[str, SimToken]:
        return self.sim.ground_truth()
