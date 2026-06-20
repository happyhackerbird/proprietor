"""Regression test for F17 — Tavily rejects queries over 400 characters.

The live pipeline failed with ``BadRequestError: Query is too long. Max query
length is 400 characters.`` because LLM-generated gap *questions* were passed to
Tavily verbatim as follow-up search queries. D15 clamps every query to 400 chars
at the single ``Researcher._search`` gateway. These tests reproduce the failure
offline (the fakes never enforced the length contract) and prove the clamp.
"""

from __future__ import annotations

from app.cost_meter import CostMeter
from app.researcher import Researcher
from tests.fakes import FakeLLMClient, FakeSearchClient

TAVILY_MAX_QUERY_LEN = 400


async def test_search_gateway_clamps_overlong_query() -> None:
    """Directly: a >400-char query reaches the client truncated to <= 400."""
    search = FakeSearchClient()
    researcher = Researcher(
        FakeLLMClient(),
        search,
        model="fake-model",
        fast_model="fake-fast-model",
        meter=CostMeter(),
    )

    await researcher._search("x" * 500, max_results=5)

    assert search.queries, "the search client should have recorded the query"
    assert len(search.queries[-1]) <= TAVILY_MAX_QUERY_LEN


class _LongGapLLMClient(FakeLLMClient):
    """A fake LLM whose gap-id response yields a question longer than 400 chars.

    This is what the real model returned in the live run (F17): a gap question
    that, used verbatim as a Tavily follow-up query, exceeds the 400-char limit.
    """

    async def complete(self, **kwargs):
        if "gaps" in kwargs["prompt"]:
            from app.clients import LLMResult

            self.call_count += 1
            self.total_tokens += self.tokens_per_call
            long_question = "1. " + "why " * 200 + "?"
            assert len(long_question) > TAVILY_MAX_QUERY_LEN
            return LLMResult(text=long_question, total_tokens=self.tokens_per_call)
        return await super().complete(**kwargs)


async def test_enrich_clamps_overlong_gap_questions() -> None:
    """End-to-end: every query the search client sees is <= 400 chars.

    Reproduces F17 offline: the gap-id step emits a >400-char question that the
    follow-up step would otherwise pass straight to Tavily.
    """
    search = FakeSearchClient()
    researcher = Researcher(
        _LongGapLLMClient(),
        search,
        model="fake-model",
        fast_model="fake-fast-model",
        meter=CostMeter(),
    )

    await researcher.enrich("Acme", "standard")

    assert search.queries, "the standard pipeline should run web searches"
    assert all(len(q) <= TAVILY_MAX_QUERY_LEN for q in search.queries)
    # And the overlong gap question must actually have been exercised as a query.
    assert any("why" in q for q in search.queries)
