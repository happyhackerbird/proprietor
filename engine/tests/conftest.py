"""Pytest fixtures for the offline engine test suite.

The ``client`` fixture wires the FastAPI app with fakes via
``app.dependency_overrides`` and a ``ProfileCache`` on a temp SQLite DB, so the
whole suite runs offline with zero network and never touches the real
``data/cache.db``. ``DB_PATH`` is pointed at a temp path before ``app.main`` is
imported (and the settings cache is cleared) so the lifespan does not create a
real cache file. ``researcher_factory`` builds a ``Researcher`` against fresh
fakes for the metering/depth-gating tests that exercise the pipeline directly.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import pytest

from app.clients import LLMClient, SearchClient
from app.cost_meter import CostMeter
from app.researcher import Researcher
from app.store import ProfileCache
from tests.fakes import FakeLLMClient, FakeSearchClient


@dataclass
class Harness:
    """The wired test app plus the injected fakes and cache."""

    client: object
    llm: FakeLLMClient
    search: FakeSearchClient
    cache: ProfileCache


@pytest.fixture
async def harness(tmp_path):
    db_path = str(tmp_path / "cache.db")
    # Point settings at a temp DB *before* importing app.main so the lifespan
    # never opens the real data/cache.db.
    os.environ["DB_PATH"] = db_path
    from app.settings import get_settings

    get_settings.cache_clear()

    from starlette.testclient import TestClient

    from app import main as main_module

    fake_llm = FakeLLMClient()
    fake_search = FakeSearchClient()

    cache = ProfileCache(db_path)
    await cache.connect()

    main_module.app.dependency_overrides[main_module.get_cache] = lambda: cache
    main_module.app.dependency_overrides[main_module.get_llm_client] = lambda: fake_llm
    main_module.app.dependency_overrides[main_module.get_search_client] = (
        lambda: fake_search
    )

    # Stub the lifespan-managed module-level cache so app startup does not open
    # a second (real-path) connection; the dependency override is what the
    # routes actually use.
    main_module._cache = cache

    with TestClient(main_module.app) as test_client:
        yield Harness(
            client=test_client, llm=fake_llm, search=fake_search, cache=cache
        )

    main_module.app.dependency_overrides.clear()
    await cache.close()
    get_settings.cache_clear()


@pytest.fixture
def researcher_factory():
    """Build a fresh ``Researcher`` + fakes + ``CostMeter`` for one run.

    Returns a callable; pass ``llm_kwargs`` to configure the fake LLM. The
    fakes and meter are exposed on the returned object so tests can read counts.
    """

    @dataclass
    class Built:
        researcher: Researcher
        llm: FakeLLMClient
        search: FakeSearchClient
        meter: CostMeter

    def _build(*, llm_kwargs: dict | None = None) -> Built:
        llm: LLMClient = FakeLLMClient(**(llm_kwargs or {}))
        search: SearchClient = FakeSearchClient()
        meter = CostMeter()
        researcher = Researcher(
            llm,
            search,
            model="fake-model",
            fast_model="fake-fast-model",
            meter=meter,
        )
        return Built(researcher=researcher, llm=llm, search=search, meter=meter)

    return _build
