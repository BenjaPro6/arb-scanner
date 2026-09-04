"""Bonding-curve arithmetic.

These are the tests that matter most, because everything downstream inherits
whatever the curve gets wrong: a price that drifts by a fraction of a percent
per trade turns into a fictional P&L after a few hundred trades.
"""

import pytest

from pumpscan.curve import (
    GRADUATION_REAL_SOL,
    CurveError,
    CurveState,
    lamports,
    quote_buy,
    quote_sell,
    sol,
    state_from_reserves,
    tokens,
)


def test_initial_state_matches_pumpfun_launch():
    s = CurveState()
    # ~28 SOL fully-diluted at launch is the number the venue's UI shows.
    assert 27.5 < s.market_cap_sol < 28.5
    assert s.real_sol == 0
    assert not s.complete


def test_buy_moves_price_up_and_sell_moves_it_down():
    s = CurveState()
    after_buy = quote_buy(s, lamports(1.0)).state
    assert after_buy.price_sol > s.price_sol

    bought = quote_buy(s, lamports(1.0))
    after_sell = quote_sell(bought.state, bought.tokens_out).state
    assert after_sell.price_sol < bought.state.price_sol


def test_constant_product_is_preserved_within_rounding():
    """k must not drift: integer truncation may only ever favour the pool."""
    s = CurveState()
    k0 = s.k
    for _ in range(200):
        s = quote_buy(s, lamports(0.1), fee_bps=0).state
    # Truncation adds dust to the pool, so k grows very slightly, never shrinks.
    assert s.k >= k0
    assert (s.k - k0) / k0 < 1e-6


def test_round_trip_loses_exactly_the_fee():
    """Buy then immediately sell: the loss is fees plus one unit of dust."""
    s = CurveState()
    spend = lamports(1.0)
    buy = quote_buy(s, spend, fee_bps=100)
    back = quote_sell(buy.state, buy.tokens_out, fee_bps=100)
    # 1% in, 1% out => keep ~98%.
    assert 0.975 < back.sol_out_net / spend < 0.99


def test_zero_fee_round_trip_is_nearly_lossless():
    s = CurveState()
    spend = lamports(1.0)
    buy = quote_buy(s, spend, fee_bps=0)
    back = quote_sell(buy.state, buy.tokens_out, fee_bps=0)
    assert back.sol_out_net <= spend                  # never profit from nothing
    assert back.sol_out_net > spend * 0.9999          # and lose only dust


def test_larger_buys_get_worse_average_prices():
    """Slippage must be monotonic; this is what makes position sizing matter."""
    s = CurveState()
    small = quote_buy(s, lamports(0.1))
    large = quote_buy(s, lamports(5.0))
    assert large.avg_price_sol > small.avg_price_sol


def test_graduation_triggers_at_the_threshold():
    s = CurveState()
    while not s.complete:
        s = quote_buy(s, lamports(1.0)).state
    assert s.real_sol >= GRADUATION_REAL_SOL or s.real_tokens == 0


def test_trading_a_graduated_curve_is_refused():
    s = CurveState(complete=True)
    with pytest.raises(CurveError):
        quote_buy(s, lamports(1.0))
    with pytest.raises(CurveError):
        quote_sell(s, 1_000_000)


def test_buy_cannot_exceed_real_token_inventory():
    """A buy larger than the curve holds is capped, not fabricated."""
    s = CurveState()
    result = quote_buy(s, lamports(10_000.0))
    assert result.tokens_out <= CurveState().real_tokens
    assert result.state.complete


def test_non_positive_amounts_are_rejected():
    s = CurveState()
    for bad in (0, -1):
        with pytest.raises(CurveError):
            quote_buy(s, bad)
        with pytest.raises(CurveError):
            quote_sell(s, bad)


def test_state_from_reserves_round_trips():
    """Rebuilding from reported reserves must reproduce the curve exactly."""
    s = CurveState()
    for _ in range(50):
        s = quote_buy(s, lamports(0.3)).state
    rebuilt = state_from_reserves(s.virtual_sol, s.virtual_tokens)
    assert rebuilt.virtual_sol == s.virtual_sol
    assert rebuilt.virtual_tokens == s.virtual_tokens
    assert rebuilt.real_tokens == s.real_tokens
    assert abs(rebuilt.real_sol - s.real_sol) <= 1
    assert rebuilt.price_sol == pytest.approx(s.price_sol)


def test_value_of_is_below_naive_mark_to_market():
    """Marking a bag at spot overstates it; selling walks the price down."""
    s = quote_buy(CurveState(), lamports(5.0))
    naive = s.tokens_out / 10**6 * s.state.price_sol
    honest = sol(s.state.value_of(s.tokens_out))
    assert honest < naive


def test_selling_cannot_drain_more_than_the_pool_holds():
    s = quote_buy(CurveState(), lamports(2.0))
    huge = s.tokens_out * 1000
    result = quote_sell(s.state, huge)
    assert result.sol_out_gross <= s.state.real_sol


def test_unit_helpers_round_trip():
    assert sol(lamports(1.5)) == pytest.approx(1.5)
    assert tokens(10**6) == pytest.approx(1.0)
