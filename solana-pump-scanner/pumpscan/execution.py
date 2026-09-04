"""What it costs to actually be in the trade.

A backtest that assumes you buy at the price on screen, instantly, every time,
is not modelling a market - it is modelling a wish.  Five separate frictions
stand between a signal and a filled position, and on sub-minute memecoin trades
each one is large relative to the edge:

1. **Latency.**  You hear about the trade, you decide, you sign, the validator
   includes you.  Hundreds of milliseconds minimum, and the price moves.
2. **Your own impact.**  The curve you are buying into is thin.  A 1 SOL buy
   into a curve holding 4 SOL moves the price ~25% against you as it fills.
   The exit is worse, because you sell into a curve you are draining.
3. **Protocol fee.**  1% each way, charged on notional, indifferent to profit.
4. **Priority fee / tip.**  To land in the block you want, on a launch other
   bots also want, you bid.  That bid is paid whether or not the trade works.
5. **Failure.**  Slippage limits get exceeded, blockhashes expire, the block is
   full.  A failed buy still costs the fee; a failed *sell* is far worse,
   because you keep holding through the move you were trying to escape.

All five are modelled here.  The defaults are deliberately pessimistic: it is
much cheaper to be pleasantly surprised in production than in a spreadsheet.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from .curve import (
    DEFAULT_FEE_BPS,
    LAMPORTS_PER_SOL,
    CurveState,
    quote_buy,
    quote_sell,
    state_from_reserves,
)
from .reconstruct import TokenTimeline


@dataclass
class ExecutionModel:
    """Frictions applied to every simulated order."""

    # Seconds from seeing a trigger to our transaction landing on chain.
    entry_delay: float = 1.0
    exit_delay: float = 1.2
    delay_jitter: float = 0.4

    # Paid per transaction regardless of outcome, in SOL.
    priority_fee_sol: float = 0.0015
    # Solana base fee, plus ATA creation on the first buy of a new mint.
    base_fee_sol: float = 0.000005
    ata_rent_sol: float = 0.00204

    # Protocol trade fee, basis points, each way.
    fee_bps: int = DEFAULT_FEE_BPS

    # Probability a transaction simply does not land.
    entry_failure_rate: float = 0.12
    exit_failure_rate: float = 0.06
    # If a sell fails we retry after this long, at whatever price then prevails.
    exit_retry_delay: float = 1.5
    max_exit_retries: int = 3

    seed: int = 0

    def __post_init__(self) -> None:
        self._rng = random.Random(self.seed)

    def reset(self, seed: int | None = None) -> None:
        """Re-seed so a backtest is reproducible run to run."""
        self._rng = random.Random(self.seed if seed is None else seed)

    def sample_entry_delay(self) -> float:
        return max(0.05, self._rng.gauss(self.entry_delay, self.delay_jitter))

    def sample_exit_delay(self) -> float:
        return max(0.05, self._rng.gauss(self.exit_delay, self.delay_jitter))

    def entry_failed(self) -> bool:
        return self._rng.random() < self.entry_failure_rate

    def exit_failed(self) -> bool:
        return self._rng.random() < self.exit_failure_rate

    @property
    def fixed_entry_cost(self) -> int:
        """Lamports burned on an entry attempt, win or lose."""
        return int((self.priority_fee_sol + self.base_fee_sol + self.ata_rent_sol) * LAMPORTS_PER_SOL)

    @property
    def fixed_exit_cost(self) -> int:
        return int((self.priority_fee_sol + self.base_fee_sol) * LAMPORTS_PER_SOL)


@dataclass
class ExitPolicy:
    """A mechanical sell rule, simple enough to actually run live.

    The defaults aim at the stated goal - take the pump, refuse the dump:

    ``take_profit``    bank it once the position has multiplied this much
    ``stop_loss``      cut at this fraction of entry value
    ``trailing_stop``  once in profit, exit if value falls this far from its
                       running high.  This is the rule doing the real work on a
                       pump-and-dump: it never has to predict the top, only to
                       notice the roll-over.
    ``max_hold``       time stop - a token that has gone quiet is dead money
    ``trail_arm``      only arm the trail after this much gain, so noise right
                       after entry cannot shake us out before there is anything
                       worth protecting
    """

    take_profit: float = 3.0
    stop_loss: float = 0.55
    trailing_stop: float = 0.35
    max_hold: float = 300.0
    trail_arm: float = 1.4
    fee_bps: int = DEFAULT_FEE_BPS


@dataclass
class Fill:
    """Result of an attempted entry."""

    filled: bool
    tokens: int = 0
    cost: int = 0            # everything spent, fees and rent included
    price: float = 0.0       # realised average, SOL per whole token
    age: float = 0.0         # token age at fill
    state: CurveState | None = None


@dataclass
class ExitResult:
    proceeds: int = 0
    reason: str = "none"
    age: float = 0.0
    retries: int = 0


def attempt_entry(
    timeline: TokenTimeline,
    decision_age: float,
    size_sol: float,
    model: ExecutionModel,
    max_slippage: float = 0.35,
) -> Fill:
    """Try to buy ``size_sol`` after the decision, with delay and failure.

    ``max_slippage`` mirrors the guard a live bot sets: if the price ran away
    while our transaction was in flight, the order reverts rather than filling
    at any price.  Modelling this matters because it *systematically* removes
    the fastest-moving launches from our fills - the very ones a naive backtest
    counts as its biggest wins.
    """
    fixed = model.fixed_entry_cost

    if model.entry_failed():
        # Fees are spent even though nothing was bought.
        return Fill(filled=False, cost=fixed, age=decision_age)

    fill_age = decision_age + model.sample_entry_delay()
    decision_state = timeline.state_at(decision_age)
    fill_state = timeline.state_at(fill_age)
    if fill_state.price_sol <= 0 or decision_state.price_sol <= 0:
        return Fill(filled=False, cost=fixed, age=fill_age)

    # Slippage guard: compare the price we based the decision on against what
    # is on chain when we land.
    if fill_state.price_sol / decision_state.price_sol - 1.0 > max_slippage:
        return Fill(filled=False, cost=fixed, age=fill_age)

    if fill_state.complete:
        # Graduated to an AMM while we were in flight; this module only models
        # the bonding curve, so treat it as a miss rather than guess.
        return Fill(filled=False, cost=fixed, age=fill_age)

    try:
        result = quote_buy(fill_state, int(size_sol * LAMPORTS_PER_SOL), model.fee_bps)
    except Exception:
        return Fill(filled=False, cost=fixed, age=fill_age)

    return Fill(
        filled=True,
        tokens=result.tokens_out,
        cost=int(size_sol * LAMPORTS_PER_SOL) + fixed,
        price=result.avg_price_sol,
        age=fill_age,
        state=result.state,
    )


def simulate_exit(
    timeline: TokenTimeline,
    fill: Fill,
    policy: ExitPolicy,
    model: ExecutionModel,
) -> ExitResult:
    """Walk the tape after the fill and sell when the policy first says to.

    The position is marked against what the curve would *pay* for it, never
    against the quoted price: selling walks the price down, and for a real
    position that gap is most of what you lose on the way out.
    """
    if not fill.filled or fill.tokens <= 0 or fill.state is None:
        return ExitResult(proceeds=0, reason="no_position", age=fill.age)

    entry_value = fill.state.value_of(fill.tokens)
    if entry_value <= 0:
        return ExitResult(proceeds=0, reason="worthless", age=fill.age)

    high_water = entry_value
    trigger_age: float | None = None
    reason = "max_hold"
    execute_at: float | None = None
    retries = 0
    deadline = fill.age + policy.max_hold

    def settle(at_age: float) -> ExitResult:
        """Sell at the curve state prevailing at ``at_age``.

        Our order executes against the pool at the moment it lands, whether or
        not anyone else happens to trade then.  An earlier version only settled
        on event timestamps, so a sell triggered into a collapsing token - which
        by definition stops trading - was never filled and fell through to the
        time stop, marking out at the bottom.  That penalised the trailing stop
        precisely on the tokens it exists to escape, and made the exit rule look
        worthless when it was working.
        """
        return ExitResult(
            _sell(timeline.state_at(at_age), fill.tokens, policy.fee_bps, model),
            reason,
            at_age,
            retries,
        )

    for event in timeline.after(fill.age):
        if not (event.virtual_sol and event.virtual_tokens):
            continue
        age = event.block_time - timeline.created_at
        if age > deadline:
            break

        # A pending sell that came due before this trade lands first, at the
        # price that stood at the time - we do not wait for the next print.
        if execute_at is not None and execute_at <= age:
            if model.exit_failed() and retries < model.max_exit_retries:
                retries += 1
                execute_at = execute_at + model.exit_retry_delay
            else:
                return settle(execute_at)

        state = state_from_reserves(event.virtual_sol, event.virtual_tokens)
        if state.complete:
            # Graduation drains the curve into an AMM.  Stop here and mark out
            # at the last curve price rather than invent a pool we do not model.
            return ExitResult(
                _sell(state, fill.tokens, policy.fee_bps, model), "graduated", age, retries
            )

        value = state.value_of(fill.tokens)
        high_water = max(high_water, value)
        ratio = value / entry_value

        if trigger_age is None:
            if ratio >= policy.take_profit:
                trigger_age, reason = age, "take_profit"
            elif ratio <= policy.stop_loss:
                trigger_age, reason = age, "stop_loss"
            elif (
                high_water / entry_value >= policy.trail_arm
                and value <= high_water * (1 - policy.trailing_stop)
            ):
                trigger_age, reason = age, "trailing_stop"
            if trigger_age is not None:
                execute_at = trigger_age + model.sample_exit_delay()

    # The tape ended or the time stop hit.  A sell already in flight still
    # lands; otherwise this is the time stop closing the position.
    if execute_at is not None:
        return settle(min(execute_at, deadline))
    reason = "max_hold"
    return settle(deadline)


def _sell(state: CurveState, tokens: int, fee_bps: int, model: ExecutionModel) -> int:
    """Net lamports received, after protocol fee and transaction costs."""
    if state.complete:
        # Post-graduation we cannot quote the curve; treat the bag as
        # unrealisable here rather than inventing an AMM price.
        return 0
    try:
        gross = quote_sell(state, tokens, fee_bps).sol_out_net
    except Exception:
        return 0
    return max(0, gross - model.fixed_exit_cost)
