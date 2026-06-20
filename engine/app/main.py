"""FastAPI application wiring for the fulfilment engine.

The app exposes ``/enrich``, ``/preview``, and a keyless ``/healthz``. The
lifespan opens (and closes) only the ``ProfileCache``; provider clients are
constructed lazily per request via overridable dependency callables, so the
app boots and serves ``/healthz`` (and the offline test suite runs) without
any API keys. Tests swap in fakes through ``app.dependency_overrides``.
Provider transport/construction errors propagate as 5xx — a failure is never
masked as a fake-success profile.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends

from app.settings import get_settings
from app.store import ProfileCache
from app.cost_meter import CostMeter, zero_cost
from app.clients import (
    LLMClient,
    SearchClient,
    NebiusLLMClient,
    TavilySearchClient,
)
from app.researcher import Researcher
from app.disambiguation import Disambiguator
from app.normalize import normalize_company
from app.models import (
    EnrichRequest,
    EnrichResponse,
    PreviewRequest,
    PreviewResponse,
)

_cache: ProfileCache | None = None


@asynccontextmanager
async def lifespan(app):
    global _cache
    s = get_settings()
    _cache = ProfileCache(s.db_path)
    await _cache.connect()
    yield
    await _cache.close()


app = FastAPI(title="Proprietor Fulfilment Engine", lifespan=lifespan)


def get_cache() -> ProfileCache:
    assert _cache is not None
    return _cache


def get_llm_client() -> LLMClient:
    s = get_settings()
    return NebiusLLMClient(api_key=s.nebius_api_key, base_url=s.nebius_base_url)


def get_search_client() -> SearchClient:
    s = get_settings()
    return TavilySearchClient(api_key=s.tavily_api_key)


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.post("/enrich", response_model=EnrichResponse)
async def enrich(
    req: EnrichRequest,
    cache=Depends(get_cache),
    llm=Depends(get_llm_client),
    search=Depends(get_search_client),
):
    s = get_settings()
    key = normalize_company(req.company)

    if not req.force_refresh:
        cached = await cache.get(key, req.depth, s.cache_ttl_hours)
        if cached is not None:
            return EnrichResponse(
                profile=cached,
                cost=zero_cost(),
                cache_hit=True,
                depth_served=req.depth,
            )

    meter = CostMeter()
    researcher = Researcher(
        llm,
        search,
        model=s.nebius_model,
        fast_model=(s.nebius_fast_model or s.nebius_model),
        meter=meter,
    )
    profile = await researcher.enrich(req.company, req.depth)
    await cache.put(key, req.depth, profile)
    cost = meter.breakdown(s.tavily_unit_usd, s.nebius_usd_per_token)
    return EnrichResponse(
        profile=profile,
        cost=cost,
        cache_hit=False,
        depth_served=req.depth,
    )


@app.post("/preview", response_model=PreviewResponse)
async def preview(req: PreviewRequest, llm=Depends(get_llm_client)):
    s = get_settings()
    disamb = Disambiguator(llm, model=(s.nebius_fast_model or s.nebius_model))
    choices = await disamb.preview(req.company)
    return PreviewResponse(disambiguation_choices=choices)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000)
