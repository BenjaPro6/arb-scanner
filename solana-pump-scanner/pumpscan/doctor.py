"""Connectivity check against the live venue.

The point of this module is trust.  Everything else in the project is only
worth running if the collector can actually reach pump.fun, and "it should
work" is not something you should have to take on faith.  So this connects to
the real feed, prints real launches as they arrive, and tells you plainly
whether the machine you are on can do the job.

It writes nothing and decides nothing.  Run it first, watch a few real Solana
tokens scroll past, then run the collector for real.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field

from .curve import LAMPORTS_PER_SOL, state_from_reserves
from .sources.pumpportal import WS_URL, parse_message


@dataclass
class DoctorReport:
    connected: bool = False
    error: str = ""
    frames: int = 0
    launches: list[tuple[str, str, float, float]] = field(default_factory=list)
    trades: int = 0
    elapsed: float = 0.0
    first_frame_latency: float = 0.0

    @property
    def healthy(self) -> bool:
        return self.connected and self.frames > 0

    def summary(self) -> str:
        if not self.connected:
            return (
                f"CANNOT REACH THE LIVE FEED\n"
                f"  {self.error}\n\n"
                "  This is a network problem on this machine, not a problem with the\n"
                "  code. Check: an outbound proxy or firewall blocking wss://, a VPN,\n"
                "  or a corporate/sandbox egress policy. The collector needs plain\n"
                "  outbound HTTPS/WSS to pumpportal.fun."
            )
        if self.frames == 0:
            return (
                "CONNECTED, BUT NO DATA ARRIVED\n"
                "  The socket opened and then stayed silent. Either the venue is quiet\n"
                "  right now (unlikely) or the subscription was rejected. Try a longer\n"
                "  --seconds before concluding anything."
            )
        rate = self.launches and len(self.launches) / self.elapsed * 60 or 0.0
        return (
            f"LIVE FEED OK\n"
            f"  connected in       : {self.first_frame_latency:.2f}s\n"
            f"  window             : {self.elapsed:.0f}s\n"
            f"  frames received    : {self.frames}\n"
            f"  new launches seen  : {len(self.launches)} (~{rate:.0f}/min)\n"
            f"  trades seen        : {self.trades}\n\n"
            "  This is real pump.fun data. `pumpscan collect` will record it."
        )


async def check(seconds: float = 30.0, show: int = 10, url: str = WS_URL) -> DoctorReport:
    """Open the live feed, watch it for a while, report what came back."""
    report = DoctorReport()
    started = time.time()

    try:
        import websockets
    except ImportError:
        report.error = "the `websockets` package is not installed (pip install -r requirements.txt)"
        return report

    ws_logger = logging.getLogger("websockets")
    previous_level = ws_logger.level
    ws_logger.setLevel(logging.CRITICAL)

    try:
        async with websockets.connect(url, ping_interval=20, open_timeout=15) as ws:
            report.connected = True
            await ws.send(json.dumps({"method": "subscribeNewToken"}))

            deadline = started + seconds
            while time.time() < deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=max(1.0, deadline - time.time()))
                except asyncio.TimeoutError:
                    break

                if not report.frames:
                    report.first_frame_latency = time.time() - started
                report.frames += 1

                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(payload, dict):
                    continue

                event = parse_message(payload)
                if event is None:
                    continue

                if event.event_type.value == "create":
                    mcap = 0.0
                    if event.virtual_sol and event.virtual_tokens:
                        mcap = state_from_reserves(
                            event.virtual_sol, event.virtual_tokens
                        ).market_cap_sol
                    report.launches.append(
                        (
                            event.mint,
                            event.symbol or "?",
                            event.sol_amount / LAMPORTS_PER_SOL,
                            mcap,
                        )
                    )
                    if len(report.launches) <= show:
                        yield_line = (
                            f"  {event.symbol or '?':<10} {event.mint[:16]}...  "
                            f"dev buy {event.sol_amount / LAMPORTS_PER_SOL:6.3f} SOL  "
                            f"mcap {mcap:7.2f} SOL"
                        )
                        print(yield_line, flush=True)
                else:
                    report.trades += 1

    except Exception as exc:
        report.error = f"{type(exc).__name__}: {exc}"
    finally:
        ws_logger.setLevel(previous_level)

    report.elapsed = time.time() - started
    return report


def run_check(seconds: float = 30.0, show: int = 10, url: str = WS_URL) -> DoctorReport:
    """Run ``check`` on a loop that keeps its own failures quiet.

    When a proxy refuses the connection, the error surfaces twice: once as the
    exception we catch and explain, and again from a transport callback that
    fires as the loop shuts down - *after* the coroutine has returned.  So
    suppressing it inside ``check`` cannot work; by the time the second one
    lands, any handler restored in a ``finally`` is back in place and prints a
    wall of internal frames on top of the clear diagnosis.

    Owning the loop here is what actually fixes it: the handler stays quiet for
    the loop's whole life, and the loop is discarded straight after.
    """
    loop = asyncio.new_event_loop()
    loop.set_exception_handler(lambda _loop, _context: None)
    try:
        return loop.run_until_complete(check(seconds, show, url))
    finally:
        loop.close()
