"""Disambiguation (spec:119).

Ambiguous fake input yields >=2 choices; an unambiguous fake yields <=1; an
empty fake yields 0. Also exercised end-to-end via ``/preview``.
"""

from app.disambiguation import Disambiguator
from app.models import DisambiguationChoice
from tests.fakes import FakeLLMClient


async def test_ambiguous_yields_two_or_more_choices():
    disamb = Disambiguator(FakeLLMClient(disambiguation_count=2), model="fake-fast")
    choices = await disamb.preview("acme")
    assert len(choices) >= 2
    assert all(isinstance(c, DisambiguationChoice) for c in choices)


async def test_unambiguous_yields_at_most_one_choice():
    disamb = Disambiguator(FakeLLMClient(disambiguation_count=1), model="fake-fast")
    choices = await disamb.preview("acme")
    assert len(choices) <= 1


async def test_no_match_yields_zero_choices():
    disamb = Disambiguator(FakeLLMClient(disambiguation_count=0), model="fake-fast")
    choices = await disamb.preview("acme")
    assert len(choices) == 0


def test_preview_endpoint_returns_choices(harness):
    r = harness.client.post("/preview", json={"company": "acme"})
    assert r.status_code == 200
    body = r.json()
    assert len(body["disambiguation_choices"]) >= 2
    for choice in body["disambiguation_choices"]:
        assert "id" in choice
        assert "display_name" in choice
