"""Persistence: an append-only raw log plus a queryable index.

Two layers on purpose.

The **raw log** is newline-delimited JSON, one normalised event per line, never
rewritten and never interpreted.  It is the ground truth.  Every time I learn
that a feature was computed wrongly, or want to test a new idea against last
month's launches, I re-derive everything from this file.  If the only copy of
your data is a processed table, then every bug in the processing is permanent.

The **index** is SQLite, derived and disposable.  It exists so that "give me
the 500 tokens launched last Tuesday" is fast.  Deleting it costs nothing; the
`reindex` command rebuilds it from the log.
"""

from __future__ import annotations

import gzip
import json
import sqlite3
import threading
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path

from .models import EventType, TokenEvent

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY,
    mint          TEXT    NOT NULL,
    event_type    TEXT    NOT NULL,
    block_time    REAL    NOT NULL,
    recv_time     REAL    NOT NULL,
    signature     TEXT,
    trader        TEXT,
    sol_amount    INTEGER NOT NULL DEFAULT 0,
    token_amount  INTEGER NOT NULL DEFAULT 0,
    virtual_sol   INTEGER NOT NULL DEFAULT 0,
    virtual_tokens INTEGER NOT NULL DEFAULT 0,
    UNIQUE(signature, mint, event_type)
);
CREATE INDEX IF NOT EXISTS idx_events_mint_time ON events(mint, block_time);
CREATE INDEX IF NOT EXISTS idx_events_time      ON events(block_time);

CREATE TABLE IF NOT EXISTS tokens (
    mint        TEXT PRIMARY KEY,
    created_at  REAL NOT NULL,
    creator     TEXT,
    name        TEXT,
    symbol      TEXT,
    uri         TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_created ON tokens(created_at);
CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens(creator);
"""


class RawLog:
    """Append-only JSONL event log, rotated by size.

    Writes are line-buffered and flushed on every append.  A collector that
    dies mid-session loses at most the event it was writing, not the session.
    """

    def __init__(self, directory: str | Path, max_bytes: int = 256 * 1024 * 1024):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max_bytes
        self._fh = None
        self._path: Path | None = None
        self._lock = threading.Lock()

    def _open(self) -> None:
        existing = sorted(self.dir.glob("events-*.jsonl"))
        if existing and existing[-1].stat().st_size < self.max_bytes:
            self._path = existing[-1]
        else:
            self._path = self.dir / f"events-{len(existing):05d}.jsonl"
        self._fh = open(self._path, "a", buffering=1, encoding="utf-8")

    def append(self, event: TokenEvent) -> None:
        with self._lock:
            if self._fh is None:
                self._open()
            elif self._path is not None and self._path.stat().st_size >= self.max_bytes:
                self._fh.close()
                self._open()
            assert self._fh is not None
            self._fh.write(event.to_json() + "\n")

    def close(self) -> None:
        with self._lock:
            if self._fh is not None:
                self._fh.close()
                self._fh = None

    def __enter__(self) -> "RawLog":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def read_all(self) -> Iterator[TokenEvent]:
        """Stream every stored event in file order.

        Malformed lines are skipped rather than fatal: a log truncated by a
        hard kill should still yield the millions of events before the tear.
        """
        paths = sorted(self.dir.glob("events-*.jsonl")) + sorted(self.dir.glob("events-*.jsonl.gz"))
        for path in sorted(paths, key=lambda p: p.name):
            opener = gzip.open if path.suffix == ".gz" else open
            with opener(path, "rt", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield TokenEvent.from_json(line)
                    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                        continue


class EventStore:
    """SQLite index over the raw log."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    @property
    def conn(self) -> sqlite3.Connection:
        """One connection per thread; SQLite objects are not shareable."""
        c = getattr(self._local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=30.0)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
            self._local.conn = c
        return c

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = self.conn
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    def insert_events(self, events: Iterable[TokenEvent]) -> int:
        """Index a batch.  Re-indexing the same events is a no-op.

        Deduplication is by (signature, mint, event_type): a websocket that
        reconnects and replays its buffer, or two overlapping captures merged
        into one directory, must not double-count volume.
        """
        rows = []
        tokens = []
        for e in events:
            rows.append(
                (
                    e.mint,
                    e.event_type.value,
                    e.block_time,
                    e.recv_time,
                    e.signature,
                    e.trader,
                    e.sol_amount,
                    e.token_amount,
                    e.virtual_sol,
                    e.virtual_tokens,
                )
            )
            if e.event_type is EventType.CREATE:
                tokens.append((e.mint, e.block_time, e.creator or e.trader, e.name, e.symbol, e.uri))

        with self.connect() as conn:
            # Count the events insert on its own.  Measuring across both
            # statements would fold the `tokens` upserts into the tally and
            # report more events stored than exist, which is exactly the kind
            # of quietly wrong number that gets trusted for weeks.
            before = conn.total_changes
            conn.executemany(
                """INSERT OR IGNORE INTO events
                   (mint, event_type, block_time, recv_time, signature, trader,
                    sol_amount, token_amount, virtual_sol, virtual_tokens)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                rows,
            )
            inserted = conn.total_changes - before
            if tokens:
                conn.executemany(
                    """INSERT OR IGNORE INTO tokens
                       (mint, created_at, creator, name, symbol, uri)
                       VALUES (?,?,?,?,?,?)""",
                    tokens,
                )
            return inserted

    def mints(self, since: float = 0.0, until: float = float("inf"), limit: int | None = None) -> list[str]:
        """Mints created in a time window, oldest first."""
        q = "SELECT mint FROM tokens WHERE created_at >= ? AND created_at <= ? ORDER BY created_at"
        params: list = [since, until if until != float("inf") else 4102444800.0]
        if limit:
            q += " LIMIT ?"
            params.append(limit)
        return [r["mint"] for r in self.conn.execute(q, params)]

    def events_for(self, mint: str) -> list[TokenEvent]:
        """Every indexed event for one token, in chain order.

        Ordered by ``block_time`` then ``id`` so that trades sharing a block
        keep the order they were ingested in, which is the closest thing to
        intra-block ordering the feed gives us.
        """
        rows = self.conn.execute(
            "SELECT * FROM events WHERE mint = ? ORDER BY block_time, id", (mint,)
        ).fetchall()
        meta = self.conn.execute("SELECT * FROM tokens WHERE mint = ?", (mint,)).fetchone()
        out = []
        for r in rows:
            ev = TokenEvent(
                mint=r["mint"],
                event_type=EventType(r["event_type"]),
                block_time=r["block_time"],
                recv_time=r["recv_time"],
                signature=r["signature"] or "",
                trader=r["trader"] or "",
                sol_amount=r["sol_amount"],
                token_amount=r["token_amount"],
                virtual_sol=r["virtual_sol"],
                virtual_tokens=r["virtual_tokens"],
            )
            if ev.event_type is EventType.CREATE and meta:
                ev.name = meta["name"] or ""
                ev.symbol = meta["symbol"] or ""
                ev.creator = meta["creator"] or ""
                ev.uri = meta["uri"] or ""
            out.append(ev)
        return out

    def creator_history(self, creator: str, before: float) -> list[str]:
        """Mints this wallet launched *strictly before* a moment in time.

        The time bound is not decoration.  Asking "has this dev rugged before"
        with the full table would let a token's own future leak into its
        features, and the model would learn to read the answer sheet.
        """
        return [
            r["mint"]
            for r in self.conn.execute(
                "SELECT mint FROM tokens WHERE creator = ? AND created_at < ? ORDER BY created_at",
                (creator, before),
            )
        ]

    def stats(self) -> dict[str, int | float]:
        row = self.conn.execute(
            """SELECT (SELECT COUNT(*) FROM tokens) AS tokens,
                      (SELECT COUNT(*) FROM events) AS events,
                      (SELECT MIN(block_time) FROM events) AS first_ts,
                      (SELECT MAX(block_time) FROM events) AS last_ts"""
        ).fetchone()
        return {
            "tokens": row["tokens"] or 0,
            "events": row["events"] or 0,
            "first_ts": row["first_ts"] or 0.0,
            "last_ts": row["last_ts"] or 0.0,
        }

    def close(self) -> None:
        c = getattr(self._local, "conn", None)
        if c is not None:
            c.close()
            self._local.conn = None


def reindex(log_dir: str | Path, db_path: str | Path, batch: int = 20_000) -> int:
    """Rebuild the SQLite index from the raw log.  Safe to run any time."""
    log = RawLog(log_dir)
    store = EventStore(db_path)
    total, buf = 0, []
    for ev in log.read_all():
        buf.append(ev)
        if len(buf) >= batch:
            store.insert_events(buf)
            total += len(buf)
            buf.clear()
    if buf:
        store.insert_events(buf)
        total += len(buf)
    return total
