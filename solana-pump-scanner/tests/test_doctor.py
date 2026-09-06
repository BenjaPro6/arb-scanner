"""The connectivity check, against a local stand-in for the venue.

This command exists to be believed: it is the first thing anyone runs, and its
verdict decides whether they trust the rest.  So the *success* path cannot ship
untested just because the real venue is unreachable from CI - a stand-in server
speaking the same frames exercises it end to end.
"""

import asyncio
import json

import pytest

from pumpscan.doctor import check, run_check

websockets = pytest.importorskip("websockets")


LAUNCH = {
    "signature": "sig-create-1",
    "mint": "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "traderPublicKey": "DevWallet1111111111111111111111111111111",
    "txType": "create",
    "initialBuy": 34_277_837.66,
    "solAmount": 1.0,
    "vTokensInBondingCurve": 1_038_722_353.34,
    "vSolInBondingCurve": 30.99,
    "marketCapSol": 29.83,
    "name": "Doctor Test",
    "symbol": "DOCT",
    "pool": "pump",
}

TRADE = {
    "signature": "sig-buy-1",
    "mint": LAUNCH["mint"],
    "traderPublicKey": "Buyer111111111111111111111111111111111111",
    "txType": "buy",
    "solAmount": 0.4,
    "tokenAmount": 12_000_000.0,
    "vTokensInBondingCurve": 1_026_000_000.0,
    "vSolInBondingCurve": 31.38,
}


async def _serve(websocket):
    """Stand in for the venue: accept the subscription, push a few frames."""
    await websocket.recv()  # the subscribeNewToken message
    await websocket.send(json.dumps({"message": "Successfully subscribed"}))
    await websocket.send(json.dumps(LAUNCH))
    await websocket.send(json.dumps(TRADE))
    second = dict(LAUNCH, signature="sig-create-2", mint="MintBBB", symbol="DOC2")
    await websocket.send(json.dumps(second))
    await asyncio.sleep(5)


async def _run_against_server(seconds: float):
    async with websockets.serve(_serve, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        return await check(seconds=seconds, show=5, url=f"ws://127.0.0.1:{port}")


def test_reports_healthy_against_a_live_looking_feed():
    report = asyncio.run(_run_against_server(2.0))
    assert report.connected
    assert report.healthy
    assert report.frames >= 4          # subscription ack + three events
    assert len(report.launches) == 2
    assert report.trades == 1

    symbol, mint = report.launches[0][1], report.launches[0][0]
    assert symbol == "DOCT"
    assert mint == LAUNCH["mint"]

    # The dev's opening buy and the implied market cap must survive parsing.
    assert report.launches[0][2] == pytest.approx(1.0)
    assert 25.0 < report.launches[0][3] < 35.0

    text = report.summary()
    assert "LIVE FEED OK" in text
    assert "new launches seen  : 2" in text


def test_reports_unreachable_without_pretending_otherwise():
    """A refused connection must fail loudly and blame the network, not guess."""
    report = run_check(seconds=2.0, show=1, url="ws://127.0.0.1:1")
    assert not report.connected
    assert not report.healthy
    assert report.error
    assert "CANNOT REACH THE LIVE FEED" in report.summary()
    assert "network problem on this machine" in report.summary()


def test_connected_but_silent_is_distinguished_from_broken():
    """Three states, not two: reachable-and-quiet is not the same as unreachable."""

    async def silent(websocket):
        await websocket.recv()
        await asyncio.sleep(3)

    async def go():
        async with websockets.serve(silent, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            return await check(seconds=1.0, show=1, url=f"ws://127.0.0.1:{port}")

    report = asyncio.run(go())
    assert report.connected
    assert report.frames == 0
    assert not report.healthy
    assert "NO DATA ARRIVED" in report.summary()
