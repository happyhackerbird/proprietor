"""Cost-meter accuracy: counts match the fake call counts, est_usd matches.

(spec:114) The meter's ``tavily_searches``/``nebius_calls``/``nebius_tokens``
must equal the number of fake search/LLM calls (and their token total), and
``est_usd`` must equal the pricing formula applied to those counts.
"""

import pytest


async def test_meter_counts_match_fake_calls(researcher_factory):
    built = researcher_factory()
    await built.researcher.enrich("Acme", "standard")

    assert built.meter.tavily_searches == built.search.call_count
    assert built.meter.nebius_calls == built.llm.call_count
    assert built.meter.nebius_tokens == built.llm.call_count * built.llm.tokens_per_call


async def test_est_usd_matches_formula(researcher_factory):
    built = researcher_factory()
    await built.researcher.enrich("Acme", "comprehensive")

    tavily_unit_usd = 0.01
    nebius_usd_per_token = 0.000001
    breakdown = built.meter.breakdown(tavily_unit_usd, nebius_usd_per_token)

    expected = (
        built.meter.tavily_searches * tavily_unit_usd
        + built.meter.nebius_tokens * nebius_usd_per_token
    )
    assert breakdown.est_usd == pytest.approx(expected)
    # And the breakdown counts mirror the meter exactly.
    assert breakdown.tavily_searches == built.meter.tavily_searches
    assert breakdown.nebius_calls == built.meter.nebius_calls
    assert breakdown.nebius_tokens == built.meter.nebius_tokens
