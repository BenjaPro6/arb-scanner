"""The strategy interface.

A strategy sees a feature dict and returns a decision.  It is deliberately
given no access to the timeline, the event stream or the clock - if a strategy
cannot reach the raw data, it cannot accidentally read the future, and the
anti-leak guarantee holds by construction rather than by discipline.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass


@dataclass
class Decision:
    """Whether to buy, how much, and why."""

    enter: bool
    score: float = 0.0
    size_sol: float = 0.0
    reason: str = ""


class Strategy(abc.ABC):
    name: str = "strategy"

    @abc.abstractmethod
    def decide(self, features: dict[str, float], mint: str = "") -> Decision:
        raise NotImplementedError


class BuyEverything(Strategy):
    """The baseline that matters.

    Any strategy that cannot beat indiscriminate buying is not a strategy - it
    is an expensive way to pay fees.  Every reported result is compared against
    this, because "made money" and "beat doing nothing clever" are very
    different claims.
    """

    name = "buy_everything"

    def __init__(self, size_sol: float = 0.25):
        self.size_sol = size_sol

    def decide(self, features: dict[str, float], mint: str = "") -> Decision:
        return Decision(enter=True, score=1.0, size_sol=self.size_sol, reason="baseline")


class BuyNothing(Strategy):
    """Control group: the return of not playing is exactly zero."""

    name = "buy_nothing"

    def decide(self, features: dict[str, float], mint: str = "") -> Decision:
        return Decision(enter=False, reason="control")
