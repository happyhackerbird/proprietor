"""Per-request cost metering.

A ``CostMeter`` is threaded through a single enrichment request. Every
search call increments the search count; every LLM call increments the
call count and accumulates the returned token total. ``breakdown``
prices the accumulated counts into a ``CostBreakdown``; ``zero_cost``
provides the all-zero breakdown reported on a cache hit.
"""

from dataclasses import dataclass

from app.models import CostBreakdown


@dataclass
class CostMeter:
    tavily_searches: int = 0
    nebius_calls: int = 0
    nebius_tokens: int = 0

    def record_search(self) -> None:
        self.tavily_searches += 1

    def record_llm(self, total_tokens: int) -> None:
        self.nebius_calls += 1
        self.nebius_tokens += total_tokens

    def breakdown(
        self, tavily_unit_usd: float, nebius_usd_per_token: float
    ) -> CostBreakdown:
        return CostBreakdown(
            tavily_searches=self.tavily_searches,
            nebius_calls=self.nebius_calls,
            nebius_tokens=self.nebius_tokens,
            est_usd=self.tavily_searches * tavily_unit_usd
            + self.nebius_tokens * nebius_usd_per_token,
        )


def zero_cost() -> CostBreakdown:
    return CostBreakdown(
        tavily_searches=0, nebius_calls=0, nebius_tokens=0, est_usd=0.0
    )
