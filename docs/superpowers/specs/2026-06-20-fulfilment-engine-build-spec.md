# Build Spec — Proprietor Fulfilment Engine (Python)

**Self-contained task brief. A fresh agent with no prior context should be able to build this from this
file alone.**

## What you are building

**Proprietor** is an AI agent that autonomously runs a *Company Enrichment SaaS* and settles money in
USDC. This task is **only the fulfilment engine** — the standalone Python service that turns a company
into a structured profile. A *separate* money/payment layer (not in scope here) will call this engine
over HTTP and handle all payments.

The engine must do one thing extremely well: **turn `{ company }` into a typed `CompanyProfile`, and
report exactly what it cost to do so.** That cost number is consumed by a downstream pricing layer, so it
must be accurate per request.

> ⛔ **Out of scope — do NOT build:** anything involving crypto, wallets, x402, USDC, payments, pricing,
> margins, or a CFO. This engine **reports** cost; it never charges. Keep it payment-free.

## Stack

- **Python 3.11+**, **FastAPI** + **uvicorn**, **Pydantic v2**, **httpx** (async), **aiosqlite** (cache).
- **Search:** **Tavily** (`tavily-python`).
- **Inference:** **Nebius TokenFactory** — OpenAI-compatible, so use the `openai` client with a custom
  `base_url` (set via env per Nebius AI Studio docs). Model is configurable via env.
- Dependency manager: **uv** or **Poetry** (your choice). Put the engine under `engine/` in the repo.

## Public HTTP interface

```
POST /enrich
  body:  { "company": "stripe.com", "depth": "standard", "force_refresh": false }
  200:   { "profile": CompanyProfile, "cost": CostBreakdown, "cache_hit": false, "depth_served": "standard" }

POST /preview                      # free, cheap — name disambiguation only
  body:  { "company": "acme" }
  200:   { "disambiguation_choices": [ { "id", "display_name", "description", "domain" } ] }

GET  /healthz  -> 200 { "ok": true }
```

`depth ∈ {basic, standard, comprehensive}` (default `standard`). `company` may be a name OR a domain.

## Data models (Pydantic)

```
CompanyProfile = {
  company: str, confidence: float,                 # confidence 0..1
  basics:  { stage?, team_size?, location?, mission?, culture_keywords: [str] },
  product: { description?, tech_stack: [str], target_market?, recent_updates: [str] },
  funding: { stage?, latest_round?, total_funding?, investors: [str], runway_estimate? },
  hiring:  { open_roles: [str], departments_hiring: [str], engineering_culture?, remote_policy? },
  news:    { summary?, product_launches: [str], partnerships: [str], press_mentions: [str] }
}
CostBreakdown = { tavily_searches: int, nebius_calls: int, nebius_tokens: int, est_usd: float }
```

All `?` fields are `Optional` (`None` when absent); all list fields default to `[]`.

## Pipeline (per `/enrich`)

1. **Normalize + cache check.** Normalize `company` to a cache key `(normalized_name, depth)`. If a fresh
   (within TTL) cached profile exists and `force_refresh` is false → return it with `cache_hit=true` and
   `cost` all-zero. Otherwise continue.
2. **Parallel domain research.** Four concurrent passes — `funding`, `product`, `market`, `team` — each
   an LLM (Nebius) call with a domain-specific prompt.
3. **Web search (skip on `basic`).** For `standard`/`comprehensive`, run **Tavily** searches to gather
   recent/factual sources.
4. **Gap identification (skip on `basic`).** One cheap LLM call that reads the gathered material and lists
   3–5 missing-info questions.
5. **Targeted follow-ups (skip on `basic`).** Answer each gap question (Tavily search + LLM).
6. **Synthesis.** Extract the typed fields: deterministic fields (team size, location, roles, etc.) via
   cheap **regex**; fuzzy fields (product/funding summaries) via **Nebius** JSON-extraction calls.
7. **Validation pass (only `comprehensive`).** One extra LLM call that cross-checks the assembled profile
   against the raw research and corrects obvious errors.
8. **Cache + return** the profile with its `CostBreakdown`.

**Depth ⇒ cost (must hold):** `basic` performs **zero Tavily searches**; `comprehensive` performs
**strictly more** LLM/Tavily calls than `standard`. This monotonic cost-by-depth relationship is what the
downstream pricing layer relies on — enforce and test it.

## Cost metering (critical)

- A `CostMeter` object threaded through one request. Every Tavily call increments `tavily_searches`;
  every Nebius call increments `nebius_calls` and adds `usage.total_tokens` to `nebius_tokens`.
- `est_usd` = `tavily_searches × TAVILY_UNIT_USD + nebius_tokens × NEBIUS_USD_PER_TOKEN` (both env-config,
  with sane defaults). Accuracy of the *counts* matters more than the dollar estimate.
- Cache hits report an all-zero `CostBreakdown`.

## Caching

- SQLite at `data/cache.db` (gitignored). Schema: key `(normalized_name, depth)` → `profile_json`,
  `created_at`. TTL via `CACHE_TTL_HOURS` (default 24). `force_refresh` bypasses read but still writes.

## Disambiguation (`/preview`)

- One cheap Nebius call that decides whether the input names multiple plausible companies; if so, return
  candidate choices. Keep it cheap — it's a free pre-purchase step. (Used by `/preview`; `/enrich` may
  call it too, but never blocks on it.)

## Config (env, via pydantic-settings; `.env` is gitignored)

`TAVILY_API_KEY`, `NEBIUS_API_KEY`, `NEBIUS_BASE_URL`, `NEBIUS_MODEL`, `NEBIUS_FAST_MODEL` (optional cheap
model for gap-id/extraction), `CACHE_TTL_HOURS`, `DB_PATH`, `TAVILY_UNIT_USD`, `NEBIUS_USD_PER_TOKEN`.

## Architecture requirement — testability

The Tavily client and the Nebius/LLM client must be **injected behind small interfaces** (e.g.
`SearchClient`, `LLMClient`) so tests can pass **fakes**. The whole engine must be testable **offline**
with zero real API calls.

## Tests (must pass offline with fakes)

- **Cost meter:** counts match the number of fake search/LLM calls made; `est_usd` computes correctly.
- **Depth gating:** `basic` makes 0 Tavily calls; `comprehensive` makes more total calls than `standard`.
- **Cache:** miss → populates; second identical request → `cache_hit=true`, zero cost; `force_refresh`
  bypasses.
- **Schema:** `/enrich` returns a valid `CompanyProfile` (optionals `None`, lists `[]`) from fake data.
- **Disambiguation:** ambiguous fake input yields ≥2 choices; unambiguous yields 0/1.
- **(Optional, env-gated)** one live integration test hitting real Tavily+Nebius.

## Acceptance criteria

1. `uvicorn` boots; `GET /healthz` → 200.
2. `POST /enrich` (with fakes in tests, real keys in manual run) returns a populated `CompanyProfile`
   with a `confidence` and a `CostBreakdown` whose counts equal the calls actually made.
3. Repeat request returns `cache_hit=true` with zero cost.
4. `basic` depth shows `tavily_searches=0`; `comprehensive` > `standard` in total calls.
5. All offline tests pass. A short `engine/README.md` explains how to run it and the env vars.
6. No payment/crypto/Circle code anywhere in `engine/`.

## Notes / gotchas

- Nebius is OpenAI-compatible: `OpenAI(base_url=NEBIUS_BASE_URL, api_key=NEBIUS_API_KEY)` then
  `client.chat.completions.create(...)`; read `resp.usage.total_tokens` for the meter.
- Keep **search (Tavily)** and **reasoning (Nebius)** as separate steps — don't use a model that browses.
- Keep timeouts modest and cache aggressively; this service will be demoed live.
- Concurrency: use `asyncio.gather` for the four domain passes and for follow-ups.
