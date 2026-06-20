"""Depth gating (spec:115, R5 — HARD).

``basic`` performs zero Tavily searches; ``comprehensive`` performs strictly
more total provider calls than ``standard`` for identical input. The same fake
configuration is used for standard and comprehensive so the comparison is
apples-to-apples (comprehensive == standard pipeline + one validation call).
"""


async def test_basic_makes_zero_tavily_searches(researcher_factory):
    built = researcher_factory()
    await built.researcher.enrich("Acme", "basic")
    assert built.meter.tavily_searches == 0


async def test_comprehensive_total_exceeds_standard(researcher_factory):
    standard = researcher_factory()
    await standard.researcher.enrich("Acme", "standard")
    standard_total = standard.meter.nebius_calls + standard.meter.tavily_searches

    comprehensive = researcher_factory()
    await comprehensive.researcher.enrich("Acme", "comprehensive")
    comprehensive_total = (
        comprehensive.meter.nebius_calls + comprehensive.meter.tavily_searches
    )

    assert comprehensive_total > standard_total
