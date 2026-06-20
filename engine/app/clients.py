"""Provider client interfaces for the fulfilment engine.

The engine depends only on the ``LLMClient`` and ``SearchClient`` Protocols
so tests can inject fakes; the real wrappers (``NebiusLLMClient``,
``TavilySearchClient``) are constructed per request, never at import.
"""

from dataclasses import dataclass
from typing import Protocol

from openai import AsyncOpenAI
from tavily import AsyncTavilyClient


@dataclass
class LLMResult:
    text: str
    total_tokens: int


@dataclass
class SearchResult:
    title: str
    url: str
    content: str


class LLMClient(Protocol):
    async def complete(
        self,
        *,
        system: str,
        prompt: str,
        model: str,
        temperature: float = 0.1,
        max_tokens: int = 2000,
    ) -> LLMResult: ...


class SearchClient(Protocol):
    async def search(self, query: str, *, max_results: int) -> list[SearchResult]: ...


class NebiusLLMClient:
    """Real ``LLMClient`` wrapping ``AsyncOpenAI`` against the Nebius endpoint."""

    def __init__(self, api_key: str, base_url: str) -> None:
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    async def complete(
        self,
        *,
        system: str,
        prompt: str,
        model: str,
        temperature: float = 0.1,
        max_tokens: int = 2000,
    ) -> LLMResult:
        resp = await self._client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return LLMResult(
            text=(resp.choices[0].message.content or ""),
            total_tokens=(resp.usage.total_tokens if resp.usage else 0),
        )


class TavilySearchClient:
    """Real ``SearchClient`` wrapping ``AsyncTavilyClient``."""

    def __init__(self, api_key: str) -> None:
        self._client = AsyncTavilyClient(api_key=api_key)

    async def search(self, query: str, *, max_results: int) -> list[SearchResult]:
        r = await self._client.search(query, max_results=max_results)
        return [
            SearchResult(
                title=item.get("title", ""),
                url=item.get("url", ""),
                content=item.get("content", ""),
            )
            for item in r.get("results", [])
        ]
