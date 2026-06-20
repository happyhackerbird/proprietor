"""Env-gated live integration test (spec:120, R15).

Skipped unless ``RUN_LIVE_TESTS`` is set with real provider keys, so the offline
suite stays green and network-free by default. When enabled it constructs the
real provider clients from settings, runs one ``/enrich``-equivalent enrichment,
and asserts a real ``CompanyProfile`` came back with both providers exercised.
"""

import os

import pytest

pytestmark = pytest.mark.skipif(
    not os.getenv("RUN_LIVE_TESTS"),
    reason="set RUN_LIVE_TESTS=1 and real keys to run",
)


async def test_live_enrich_hits_real_providers():
    from app.clients import NebiusLLMClient, TavilySearchClient
    from app.cost_meter import CostMeter
    from app.models import CompanyProfile
    from app.researcher import Researcher
    from app.settings import get_settings

    s = get_settings()
    llm = NebiusLLMClient(api_key=s.nebius_api_key, base_url=s.nebius_base_url)
    search = TavilySearchClient(api_key=s.tavily_api_key)
    meter = CostMeter()
    researcher = Researcher(
        llm,
        search,
        model=s.nebius_model,
        fast_model=(s.nebius_fast_model or s.nebius_model),
        meter=meter,
    )

    profile = await researcher.enrich("stripe.com", "standard")

    assert isinstance(profile, CompanyProfile)
    assert meter.nebius_calls > 0
    assert meter.tavily_searches > 0
