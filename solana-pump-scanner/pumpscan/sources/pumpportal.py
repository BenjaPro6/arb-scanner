"""Live feed from PumpPortal's public websocket.

Free, no key, and it pushes both new launches and per-token trades.  That makes
it the right starting point; when a Helius or Birdeye key shows up it slots in
behind the same ``EventSource`` interface without touching anything downstream.

Payload shape (as documented by PumpPortal):

    {"signature": "...", "mint": "...", "traderPublicKey": "...",
     "txType": "create" | "buy" | "sell", "solAmount": 1.5,
     "tokenAmount": 34277837.6, "newTokenBalance": ...,
     "vTokensInBondingCurve": 1038722353.4, "vSolInBondingCurve": 31.0,
     "marketCapSol": 29.8, "name": "...", "symbol": "...", "pool": "pump"}

Note the units: PumpPortal reports SOL and token amounts as *decimal floats*,
not base units.  We convert on the way in and store integers, because float
lamports accumulate rounding error and we want the reconstructed curve to match
the chain exactly.

One caveat worth stating plainly: this feed has no block time.  Every event is
stamped with arrival time, so ``block_time == recv_time`` and the measured
latency is zero.  That is a limitation of the source, not a claim about
reality - the backtest applies its own latency model on top and never trusts
this field to be a true chain timestamp.  A Helius/geyser source, when you add
one, does carry real block times and should populate both fields.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator

from ..curve import LAMPORTS_PER_SOL, TOKEN_UNITS
from ..models import EventType, TokenEvent
from .base import EventSource

log = logging.getLogger(__name__)

WS_URL = "wss://pumpportal.fun/api/data"


def _to_lamports(value: object) -> int:
    try:
        return int(round(float(value or 0) * LAMPORTS_PER_SOL))
    except (TypeError, ValueError):
        return 0


def _to_base_units(value: object) -> int:
    try:
        return int(round(float(value or 0) * TOKEN_UNITS))
    except (TypeError, ValueError):
        return 0


def parse_message(payload: dict, recv_time: float | None = None) -> TokenEvent | None:
    """Turn one websocket frame into a ``TokenEvent``, or ``None`` if it is not one.

    Kept pure and importable so it can be unit-tested against captured frames
    without a network.
    """
    tx_type = payload.get("txType") or payload.get("tx_type")
    mint = payload.get("mint")
    if not tx_type or not mint:
        return None
    try:
        event_type = EventType(str(tx_type).lower())
    except ValueError:
        return None

    now = recv_time if recv_time is not None else time.time()
    trader = payload.get("traderPublicKey", "") or ""

    # On a create frame, solAmount is absent but initialBuy carries the dev's
    # own opening purchase - which is one of the more predictive fields we get,
    # so it must not be dropped.
    if event_type is EventType.CREATE:
        sol_amount = _to_lamports(payload.get("solAmount") or payload.get("initialBuy") or 0)
        token_amount = _to_base_units(payload.get("initialBuy") or 0)
    else:
        sol_amount = _to_lamports(payload.get("solAmount"))
        token_amount = _to_base_units(payload.get("tokenAmount"))

    known = {
        "signature", "mint", "traderPublicKey", "txType", "tx_type", "solAmount",
        "tokenAmount", "initialBuy", "vTokensInBondingCurve", "vSolInBondingCurve",
        "name", "symbol", "uri", "pool", "marketCapSol",
    }
    return TokenEvent(
        mint=str(mint),
        event_type=event_type,
        block_time=now,
        recv_time=now,
        signature=str(payload.get("signature", "")),
        trader=trader,
        sol_amount=sol_amount,
        token_amount=token_amount,
        virtual_sol=_to_lamports(payload.get("vSolInBondingCurve")),
        virtual_tokens=_to_base_units(payload.get("vTokensInBondingCurve")),
        name=str(payload.get("name", "")),
        symbol=str(payload.get("symbol", "")),
        uri=str(payload.get("uri", "")),
        creator=trader if event_type is EventType.CREATE else "",
        extra={k: v for k, v in payload.items() if k not in known},
    )


class PumpPortalSource(EventSource):
    """Websocket source with automatic reconnection and subscription replay."""

    name = "pumpportal"

    def __init__(self, url: str = WS_URL, max_watched: int = 400, ping_interval: float = 20.0):
        self.url = url
        self.max_watched = max_watched
        self.ping_interval = ping_interval
        self._watched: list[str] = []
        self._ws = None
        self._pending: asyncio.Queue[dict] = asyncio.Queue()

    async def _send(self, message: dict) -> None:
        """Send now if connected, otherwise queue for after the next connect."""
        if self._ws is not None:
            try:
                await self._ws.send(json.dumps(message))
                return
            except Exception:
                log.debug("send failed, queueing %s", message.get("method"))
        await self._pending.put(message)

    async def watch(self, mint: str) -> None:
        """Subscribe to trades on a mint, evicting the oldest past the budget.

        The server caps how many subscriptions one connection may hold, and an
        unbounded watch list silently stops delivering.  Tokens are interesting
        for minutes, not hours, so evicting oldest-first costs us nothing.
        """
        if mint in self._watched:
            return
        self._watched.append(mint)
        await self._send({"method": "subscribeTokenTrade", "keys": [mint]})
        while len(self._watched) > self.max_watched:
            await self.unwatch(self._watched[0])

    async def unwatch(self, mint: str) -> None:
        if mint in self._watched:
            self._watched.remove(mint)
            await self._send({"method": "unsubscribeTokenTrade", "keys": [mint]})

    async def stream(self) -> AsyncIterator[TokenEvent]:
        try:
            import websockets
        except ImportError as exc:  # pragma: no cover - dependency guard
            raise RuntimeError("pip install websockets to use the live source") from exc

        backoff = 1.0
        while True:
            try:
                async with websockets.connect(
                    self.url, ping_interval=self.ping_interval, max_queue=4096
                ) as ws:
                    self._ws = ws
                    backoff = 1.0
                    log.info("connected to %s", self.url)

                    await ws.send(json.dumps({"method": "subscribeNewToken"}))
                    # Re-arm every per-token subscription: a reconnect starts
                    # from a blank server-side state, and forgetting this is
                    # how a collector ends up recording launches with no trades.
                    if self._watched:
                        await ws.send(
                            json.dumps({"method": "subscribeTokenTrade", "keys": list(self._watched)})
                        )
                    while not self._pending.empty():
                        await ws.send(json.dumps(self._pending.get_nowait()))

                    async for raw in ws:
                        try:
                            payload = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(payload, dict):
                            continue
                        event = parse_message(payload)
                        if event is not None:
                            yield event

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("websocket dropped (%s); reconnecting in %.1fs", exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)
            finally:
                self._ws = None

    async def close(self) -> None:
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
            self._ws = None
