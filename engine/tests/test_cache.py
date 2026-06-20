"""Cache behaviour via the wired TestClient (spec:116).

Miss → 200 with ``cache_hit=False`` and non-zero cost; identical repeat →
``cache_hit=True`` with an all-zero cost and no new fake calls; ``force_refresh``
→ bypasses the read, re-runs the pipeline, and reports non-zero cost again.
"""


def test_cache_miss_then_hit_then_force_refresh(harness):
    client = harness.client

    # First request — cache miss: pipeline runs, cost is non-zero.
    r1 = client.post("/enrich", json={"company": "Stripe", "depth": "standard"})
    assert r1.status_code == 200
    body1 = r1.json()
    assert body1["cache_hit"] is False
    assert body1["cost"]["nebius_calls"] > 0

    llm_after_miss = harness.llm.call_count
    search_after_miss = harness.search.call_count
    assert llm_after_miss > 0

    # Second identical request — cache hit: zero cost, no new fake calls.
    r2 = client.post("/enrich", json={"company": "Stripe", "depth": "standard"})
    assert r2.status_code == 200
    body2 = r2.json()
    assert body2["cache_hit"] is True
    assert body2["cost"]["tavily_searches"] == 0
    assert body2["cost"]["nebius_calls"] == 0
    assert body2["cost"]["nebius_tokens"] == 0
    assert body2["cost"]["est_usd"] == 0.0
    assert harness.llm.call_count == llm_after_miss
    assert harness.search.call_count == search_after_miss

    # Third request with force_refresh — bypasses read, re-runs, non-zero cost.
    r3 = client.post(
        "/enrich",
        json={"company": "Stripe", "depth": "standard", "force_refresh": True},
    )
    assert r3.status_code == 200
    body3 = r3.json()
    assert body3["cache_hit"] is False
    assert body3["cost"]["nebius_calls"] > 0
    assert harness.llm.call_count > llm_after_miss
    assert harness.search.call_count > search_after_miss
