"""Response schema validation via the wired TestClient (spec:117).

A ``/enrich`` response must parse as ``EnrichResponse`` / ``CompanyProfile``:
``confidence`` is a float, list fields are lists, and an absent optional is
``None`` (not missing or garbage). ``depth_served`` echoes the request depth.
"""

from app.models import CompanyProfile, EnrichResponse


def test_enrich_response_validates_as_schema(harness):
    r = harness.client.post("/enrich", json={"company": "Acme", "depth": "basic"})
    assert r.status_code == 200
    body = r.json()

    # Whole envelope parses.
    response = EnrichResponse(**body)
    assert response.depth_served == "basic"
    assert body["depth_served"] == "basic"

    # Profile parses and field types are correct.
    profile = CompanyProfile(**body["profile"])
    assert isinstance(profile.confidence, float)

    # List fields are lists.
    assert isinstance(profile.basics.culture_keywords, list)
    assert isinstance(profile.product.tech_stack, list)
    assert isinstance(profile.funding.investors, list)
    assert isinstance(profile.hiring.open_roles, list)
    assert isinstance(profile.news.product_launches, list)

    # An absent optional resolves to None, not a missing key or garbage. On a
    # basic run no Tavily/news text is gathered, so news.summary is absent.
    assert profile.news.summary is None
    assert "summary" in body["profile"]["news"]
    assert body["profile"]["news"]["summary"] is None
