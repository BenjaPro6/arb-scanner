"""Normalised event model.

Every data source - the live websocket, a replayed capture, the simulator -
produces these types and nothing else.  Downstream code (features, labels,
backtest) never sees a provider-specific payload, so swapping Helius in for
PumpPortal later is a change in one file rather than a rewrite.

Timestamps are float UNIX seconds, always UTC.  Two of them are kept and they
mean different things:

``block_time``  when the trade landed on chain.  This is the objective
                ordering of events and the only clock a backtest may use.
``recv_time``   when *our process* saw it.  The gap between the two is the
                latency we are exposed to, and pretending it is zero is the
                single most common way a sniper backtest fools its author.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class EventType(str, Enum):
    CREATE = "create"
    BUY = "buy"
    SELL = "sell"

    def __str__(self) -> str:  # keeps f-strings and JSON readable
        return self.value


@dataclass(slots=True)
class TokenEvent:
    """A single on-chain action against one pump.fun token."""

    mint: str
    event_type: EventType
    block_time: float
    recv_time: float
    signature: str = ""
    trader: str = ""

    # Trade economics, in base units.  Zero for CREATE events that carry no
    # dev buy.
    sol_amount: int = 0
    token_amount: int = 0

    # Post-trade curve reserves as reported by the source.  These pin down the
    # exact price after this event; see curve.state_from_reserves.
    virtual_sol: int = 0
    virtual_tokens: int = 0

    # Only populated on CREATE.
    name: str = ""
    symbol: str = ""
    uri: str = ""
    creator: str = ""

    # Anything the source gave us that we have not modelled.  Kept so a capture
    # made today can still be re-parsed after we learn what a field means.
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def latency(self) -> float:
        """Seconds between the trade landing and us hearing about it."""
        return max(0.0, self.recv_time - self.block_time)

    def to_json(self) -> str:
        d = asdict(self)
        d["event_type"] = self.event_type.value
        return json.dumps(d, separators=(",", ":"))

    @classmethod
    def from_json(cls, line: str) -> "TokenEvent":
        d = json.loads(line)
        d["event_type"] = EventType(d["event_type"])
        return cls(**d)


@dataclass(slots=True)
class TokenSnapshot:
    """What we know about a token at a moment in time.

    Built by the reconstructor by folding events in ``block_time`` order.
    """

    mint: str
    created_at: float
    creator: str = ""
    name: str = ""
    symbol: str = ""

    virtual_sol: int = 0
    virtual_tokens: int = 0
    real_sol: int = 0

    buy_count: int = 0
    sell_count: int = 0
    sol_bought: int = 0
    sol_sold: int = 0
    unique_buyers: int = 0
    graduated: bool = False
    last_event_at: float = 0.0

    @property
    def age(self) -> float:
        return max(0.0, self.last_event_at - self.created_at)

    @property
    def net_inflow(self) -> int:
        return self.sol_bought - self.sol_sold
