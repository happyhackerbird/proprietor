"""Offline fakes for the provider clients.

These satisfy the ``LLMClient`` / ``SearchClient`` Protocols from
``app.clients`` and make zero network calls, so the whole engine is testable
offline. The fake LLM branches on the prompt wording the real prompts use
(``"JSON array"`` for disambiguation, ``"JSON object"`` for extraction/
validation, ``"gaps"`` for gap identification, prose otherwise) and returns
canned responses with deterministic token counts. Both fakes track their call
counts so tests can assert metering accuracy.
"""

from __future__ import annotations

from app.clients import LLMResult, SearchResult

# A JSON object covering product + funding + basics keys, returned for any
# "JSON object" extraction/validation prompt.
_EXTRACTION_JSON = (
    '{"description":"A payments-free company profiler",'
    '"tech_stack":["python","fastapi"],'
    '"target_market":"developers",'
    '"recent_updates":["v1"],'
    '"stage":"Series A",'
    '"latest_round":"$10M",'
    '"total_funding":"$15M",'
    '"investors":["Acme Ventures"],'
    '"runway_estimate":"24 months",'
    '"team_size":"50",'
    '"location":"San Francisco",'
    '"mission":"profile companies",'
    '"culture_keywords":["remote"]}'
)

# Two distinct companies sharing the "acme" name, for any "JSON array"
# disambiguation prompt. Sliced per ``disambiguation_count``.
_DISAMBIGUATION_COMPANIES = [
    '{"name":"Acme Robotics","description":"industrial robots","domain":"acmerobotics.com"}',
    '{"name":"Acme Foods","description":"snack foods","domain":"acmefoods.com"}',
]

_GAPS_TEXT = (
    "1. What is the funding stage?\n"
    "2. What is the team size?\n"
    "3. What is the product?"
)

_PROSE_TEXT = (
    "The company is based in San Francisco with 50 employees and a strong "
    "engineering culture."
)


class FakeLLMClient:
    """A scripted, offline ``LLMClient``.

    Branches on the prompt to return JSON or prose, and counts calls + tokens.
    """

    def __init__(self, *, disambiguation_count: int = 2, tokens_per_call: int = 100) -> None:
        self.disambiguation_count = disambiguation_count
        self.tokens_per_call = tokens_per_call
        self.call_count = 0
        self.total_tokens = 0
        self.calls: list[dict] = []

    async def complete(
        self,
        *,
        system: str,
        prompt: str,
        model: str,
        temperature: float = 0.1,
        max_tokens: int = 2000,
    ) -> LLMResult:
        self.call_count += 1
        self.total_tokens += self.tokens_per_call
        self.calls.append(
            {
                "system": system,
                "prompt": prompt,
                "model": model,
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
        )

        if "JSON array" in prompt:
            n = max(0, self.disambiguation_count)
            text = "[" + ",".join(_DISAMBIGUATION_COMPANIES[:n]) + "]"
        elif "JSON object" in prompt:
            text = _EXTRACTION_JSON
        elif "gaps" in prompt:
            text = _GAPS_TEXT
        else:
            text = _PROSE_TEXT

        return LLMResult(text=text, total_tokens=self.tokens_per_call)


class FakeSearchClient:
    """A scripted, offline ``SearchClient`` that records the queries it receives."""

    def __init__(self) -> None:
        self.call_count = 0
        self.queries: list[str] = []

    async def search(self, query: str, *, max_results: int) -> list[SearchResult]:
        self.call_count += 1
        self.queries.append(query)
        return [
            SearchResult(
                title="Result",
                url="https://example.com",
                content="Some factual content about the company.",
            )
        ]
