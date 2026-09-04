"""Exact pump.fun bonding-curve math.

The on-chain program works in unsigned integers (lamports for SOL, base units
for the token) and truncates on every division.  Reproducing that here matters:
a float approximation drifts by a few basis points per trade, and after a few
hundred trades the reconstructed price of a token is simply wrong.  A backtest
built on a wrong price is a backtest that lies.

Reference launch parameters (pump.fun defaults):

    virtual SOL reserves     30.000000000 SOL   =  30_000_000_000 lamports
    virtual token reserves   1_073_000_191 tok  =  1_073_000_191_000_000 base
    real token reserves        793_100_000 tok  =    793_100_000_000_000 base
    total supply             1_000_000_000 tok
    token decimals           6

The invariant is a constant product over the *virtual* reserves:

    k = virtual_sol * virtual_tokens

A buy of ``dx`` lamports moves the pool to ``virtual_sol + dx`` and hands the
buyer the token delta.  Algebraically that delta simplifies to

    tokens_out = virtual_tokens * dx / (virtual_sol + dx)

which is what the program actually computes: one multiply, one floor-divide.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

LAMPORTS_PER_SOL = 1_000_000_000
TOKEN_DECIMALS = 6
TOKEN_UNITS = 10**TOKEN_DECIMALS

# pump.fun launch defaults, in base units.
INIT_VIRTUAL_SOL = 30_000_000_000
INIT_VIRTUAL_TOKENS = 1_073_000_191_000_000
INIT_REAL_TOKENS = 793_100_000_000_000
TOTAL_SUPPLY = 1_000_000_000_000_000

# A curve "graduates" to a real AMM once this much real SOL has accumulated.
GRADUATION_REAL_SOL = 85_000_000_000

# Trade fee charged by the protocol, in basis points.
DEFAULT_FEE_BPS = 100


class CurveError(ValueError):
    """Raised when a trade cannot be executed against the curve."""


@dataclass(frozen=True)
class CurveState:
    """Immutable snapshot of a bonding curve.

    All quantities are integers in base units (lamports / token base units),
    mirroring the on-chain account layout.
    """

    virtual_sol: int = INIT_VIRTUAL_SOL
    virtual_tokens: int = INIT_VIRTUAL_TOKENS
    real_sol: int = 0
    real_tokens: int = INIT_REAL_TOKENS
    complete: bool = False

    @property
    def k(self) -> int:
        return self.virtual_sol * self.virtual_tokens

    @property
    def price_lamports_per_token(self) -> float:
        """Marginal price of one whole token, in lamports."""
        return self.virtual_sol / self.virtual_tokens * TOKEN_UNITS

    @property
    def price_sol(self) -> float:
        """Marginal price of one whole token, in SOL."""
        return self.price_lamports_per_token / LAMPORTS_PER_SOL

    @property
    def market_cap_sol(self) -> float:
        """Fully-diluted market cap in SOL, the number pump.fun's UI shows."""
        return self.price_sol * (TOTAL_SUPPLY / TOKEN_UNITS)

    @property
    def progress(self) -> float:
        """Fraction of the way to graduation, clamped to [0, 1]."""
        return min(1.0, max(0.0, self.real_sol / GRADUATION_REAL_SOL))

    def value_of(self, token_amount: int) -> int:
        """Lamports received for dumping ``token_amount`` right now, pre-fee.

        This is the honest mark-to-market of a position: not ``amount * price``
        but what the curve would actually pay, which is strictly less because
        selling walks the price down.
        """
        if token_amount <= 0:
            return 0
        return quote_sell(self, token_amount).sol_out_gross


@dataclass(frozen=True)
class TradeResult:
    """Outcome of applying a trade to a curve."""

    state: CurveState
    sol_in_net: int = 0
    sol_out_gross: int = 0
    sol_out_net: int = 0
    tokens_out: int = 0
    tokens_in: int = 0
    fee: int = 0

    @property
    def avg_price_sol(self) -> float:
        """Realised average price per whole token, in SOL."""
        if self.tokens_out:
            gross = self.sol_in_net + self.fee
            return gross / self.tokens_out * TOKEN_UNITS / LAMPORTS_PER_SOL
        if self.tokens_in:
            return self.sol_out_net / self.tokens_in * TOKEN_UNITS / LAMPORTS_PER_SOL
        return 0.0


def _fee(amount: int, fee_bps: int) -> int:
    """Protocol fee, floored - the program never rounds a fee in your favour."""
    return amount * fee_bps // 10_000


def quote_buy(state: CurveState, sol_in: int, fee_bps: int = DEFAULT_FEE_BPS) -> TradeResult:
    """Quote spending ``sol_in`` lamports (fee inclusive) on the curve.

    The fee comes off the top, so the amount that actually reaches the curve
    is ``sol_in - fee``.
    """
    if sol_in <= 0:
        raise CurveError(f"buy amount must be positive, got {sol_in}")
    if state.complete:
        raise CurveError("curve has already graduated; trade on the AMM instead")

    fee = _fee(sol_in, fee_bps)
    net = sol_in - fee
    tokens_out = state.virtual_tokens * net // (state.virtual_sol + net)

    # The curve can only hand out the tokens it still holds.  A buy large enough
    # to clear the shelf gets capped, and the excess SOL is refunded by the
    # program rather than silently kept.
    if tokens_out >= state.real_tokens:
        tokens_out = state.real_tokens
        net = _sol_needed_for(state, tokens_out)
        fee = _fee_from_net(net, fee_bps)

    new_state = replace(
        state,
        virtual_sol=state.virtual_sol + net,
        virtual_tokens=state.virtual_tokens - tokens_out,
        real_sol=state.real_sol + net,
        real_tokens=state.real_tokens - tokens_out,
    )
    if new_state.real_sol >= GRADUATION_REAL_SOL or new_state.real_tokens == 0:
        new_state = replace(new_state, complete=True)

    return TradeResult(state=new_state, sol_in_net=net, tokens_out=tokens_out, fee=fee)


def quote_sell(state: CurveState, tokens_in: int, fee_bps: int = DEFAULT_FEE_BPS) -> TradeResult:
    """Quote selling ``tokens_in`` base units back into the curve."""
    if tokens_in <= 0:
        raise CurveError(f"sell amount must be positive, got {tokens_in}")
    if state.complete:
        raise CurveError("curve has already graduated; trade on the AMM instead")

    sol_out_gross = state.virtual_sol * tokens_in // (state.virtual_tokens + tokens_in)
    # You cannot extract more real SOL than the curve is actually holding.
    sol_out_gross = min(sol_out_gross, state.real_sol)
    fee = _fee(sol_out_gross, fee_bps)

    new_state = replace(
        state,
        virtual_sol=state.virtual_sol - sol_out_gross,
        virtual_tokens=state.virtual_tokens + tokens_in,
        real_sol=state.real_sol - sol_out_gross,
        real_tokens=state.real_tokens + tokens_in,
    )
    return TradeResult(
        state=new_state,
        sol_out_gross=sol_out_gross,
        sol_out_net=sol_out_gross - fee,
        tokens_in=tokens_in,
        fee=fee,
    )


def _sol_needed_for(state: CurveState, tokens_out: int) -> int:
    """Net lamports required to buy exactly ``tokens_out`` from the curve.

    Inverse of the buy formula, rounded up so nobody gets the last token free.
    """
    denom = state.virtual_tokens - tokens_out
    if denom <= 0:
        raise CurveError("cannot buy the entire virtual token reserve")
    return -(-state.virtual_sol * tokens_out // denom)


def _fee_from_net(net: int, fee_bps: int) -> int:
    """Recover the fee given the post-fee amount, for capped buys."""
    if fee_bps <= 0:
        return 0
    gross = -(-net * 10_000 // (10_000 - fee_bps))
    return gross - net


def state_from_reserves(virtual_sol: int, virtual_tokens: int) -> CurveState:
    """Rebuild a curve from the two reserve figures a trade feed reports.

    PumpPortal (and the on-chain logs) publish ``vSolInBondingCurve`` and
    ``vTokensInBondingCurve`` after every trade.  Those two numbers pin the
    curve down completely: the real reserves follow from the launch constants,
    so we never accumulate deltas and never drift.
    """
    real_tokens = max(0, virtual_tokens - (INIT_VIRTUAL_TOKENS - INIT_REAL_TOKENS))
    real_sol = max(0, virtual_sol - INIT_VIRTUAL_SOL)
    return CurveState(
        virtual_sol=virtual_sol,
        virtual_tokens=virtual_tokens,
        real_sol=real_sol,
        real_tokens=real_tokens,
        complete=real_sol >= GRADUATION_REAL_SOL or real_tokens == 0,
    )


def sol(lamports_amount: int) -> float:
    """Lamports -> SOL, for display."""
    return lamports_amount / LAMPORTS_PER_SOL


def lamports(sol_amount: float) -> int:
    """SOL -> lamports, for input."""
    return int(round(sol_amount * LAMPORTS_PER_SOL))


def tokens(base_units: int) -> float:
    """Base units -> whole tokens, for display."""
    return base_units / TOKEN_UNITS
