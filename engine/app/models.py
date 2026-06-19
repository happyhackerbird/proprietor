"""Typed request/response and profile models for the fulfilment engine.

A company name or domain is enriched into a ``CompanyProfile`` and the
per-request ``CostBreakdown`` is reported alongside it. Optional scalar
fields default to ``None``; list fields default to ``[]``.
"""

from typing import Literal

from pydantic import BaseModel, Field

Depth = Literal["basic", "standard", "comprehensive"]


class Basics(BaseModel):
    stage: str | None = None
    team_size: str | None = None
    location: str | None = None
    mission: str | None = None
    culture_keywords: list[str] = Field(default_factory=list)


class Product(BaseModel):
    description: str | None = None
    tech_stack: list[str] = Field(default_factory=list)
    target_market: str | None = None
    recent_updates: list[str] = Field(default_factory=list)


class Funding(BaseModel):
    stage: str | None = None
    latest_round: str | None = None
    total_funding: str | None = None
    investors: list[str] = Field(default_factory=list)
    runway_estimate: str | None = None


class Hiring(BaseModel):
    open_roles: list[str] = Field(default_factory=list)
    departments_hiring: list[str] = Field(default_factory=list)
    engineering_culture: str | None = None
    remote_policy: str | None = None


class News(BaseModel):
    summary: str | None = None
    product_launches: list[str] = Field(default_factory=list)
    partnerships: list[str] = Field(default_factory=list)
    press_mentions: list[str] = Field(default_factory=list)


class CompanyProfile(BaseModel):
    company: str
    confidence: float
    basics: Basics
    product: Product
    funding: Funding
    hiring: Hiring
    news: News


class CostBreakdown(BaseModel):
    tavily_searches: int
    nebius_calls: int
    nebius_tokens: int
    est_usd: float


class EnrichRequest(BaseModel):
    company: str
    depth: Depth = "standard"
    force_refresh: bool = False


class EnrichResponse(BaseModel):
    profile: CompanyProfile
    cost: CostBreakdown
    cache_hit: bool
    depth_served: Depth


class PreviewRequest(BaseModel):
    company: str


class DisambiguationChoice(BaseModel):
    id: str
    display_name: str
    description: str | None = None
    domain: str | None = None


class PreviewResponse(BaseModel):
    disambiguation_choices: list[DisambiguationChoice] = Field(default_factory=list)
