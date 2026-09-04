"""The contract every data source honours."""

from __future__ import annotations

import abc
from collections.abc import AsyncIterator

from ..models import TokenEvent


class EventSource(abc.ABC):
    """An async stream of normalised token events.

    Implementations must not filter, deduplicate or reorder: emit what you saw,
    when you saw it, and leave judgement to the layers above.  A source that
    quietly drops "uninteresting" events destroys the ability to ask new
    questions of an old capture.
    """

    name: str = "source"

    @abc.abstractmethod
    def stream(self) -> AsyncIterator[TokenEvent]:
        """Yield events until the source is exhausted or cancelled."""
        raise NotImplementedError

    async def watch(self, mint: str) -> None:
        """Ask the source for trade events on ``mint``.

        Sources that always deliver everything can leave this as a no-op.
        """
        return None

    async def unwatch(self, mint: str) -> None:
        return None

    async def close(self) -> None:
        return None
