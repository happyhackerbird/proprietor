"""Application settings loaded from the environment (pydantic-settings v2).

Importing this module and constructing ``Settings()`` succeeds with no
environment variables set — every field has a default. No API client is
constructed here; provider clients are built lazily per request, so a
keyless import (e.g. for ``/healthz`` or offline tests) never crashes.
Environment variable names are matched case-insensitively, so e.g.
``TAVILY_API_KEY`` populates ``tavily_api_key``.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    tavily_api_key: str = ""
    nebius_api_key: str = ""
    nebius_base_url: str = "https://api.studio.nebius.com/v1"
    nebius_model: str = "meta-llama/Llama-3.3-70B-Instruct"
    nebius_fast_model: str | None = None
    cache_ttl_hours: int = 24
    db_path: str = "data/cache.db"
    tavily_unit_usd: float = 0.008
    nebius_usd_per_token: float = 0.0000002


@lru_cache
def get_settings() -> Settings:
    return Settings()
