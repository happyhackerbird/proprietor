# Proprietor Fulfilment Engine

A standalone FastAPI service that turns a company name or domain into a typed
`CompanyProfile` and reports the per-request cost of producing it. The engine
**only reports cost — it never charges anything.**

Given a company, it runs a depth-tiered enrichment pipeline: parallel domain
research (funding, product, market, team), optional web search, gap
identification, targeted follow-ups, and synthesis into a structured profile —
deterministic fields by regex, fuzzy fields by LLM extraction, with an extra
validation pass on the deepest tier. A `CostMeter` threaded through each request
counts every provider call so the returned `CostBreakdown` is accurate. Results
are cached in SQLite on `(normalized_name, depth)` with a TTL.

## Running

From the `engine/` directory:

```bash
uv sync --extra dev                          # install deps (incl. test deps)
uv run uvicorn app.main:app --reload         # serve on http://127.0.0.1:8000
uv run pytest                                 # run the offline test suite
```

The app boots and serves `/healthz` with no API keys set. Keys are only needed
to make real `/enrich` and `/preview` calls (offline tests use injected fakes).
Copy `.env.example` to `.env` and fill in your keys.

## HTTP endpoints

### `POST /enrich`

Enrich a company into a profile and report cost.

```jsonc
// request
{ "company": "stripe.com", "depth": "standard", "force_refresh": false }

// 200 response
{
  "profile": { /* CompanyProfile */ },
  "cost": { "tavily_searches": 4, "nebius_calls": 13, "nebius_tokens": 1300, "est_usd": 0.0323 },
  "cache_hit": false,
  "depth_served": "standard"
}
```

`depth` is one of `basic`, `standard`, `comprehensive` (default `standard`).
`company` may be a name or a domain. `basic` performs zero web searches;
`comprehensive` performs strictly more provider calls than `standard`. A cache
hit returns the cached profile with an all-zero `cost` and `cache_hit: true`;
`force_refresh: true` bypasses the cache read but still writes the fresh result.

### `POST /preview`

Cheap name disambiguation — one LLM call, no cost reported.

```jsonc
// request
{ "company": "acme" }

// 200 response
{
  "disambiguation_choices": [
    { "id": "acmerobotics_acme_robotics", "display_name": "Acme Robotics", "description": "industrial robots", "domain": "acmerobotics.com" },
    { "id": "acmefoods_acme_foods", "display_name": "Acme Foods", "description": "snack foods", "domain": "acmefoods.com" }
  ]
}
```

### `GET /healthz`

```jsonc
// 200 response
{ "ok": true }
```

## Environment variables

Configured via pydantic-settings (`.env`, gitignored). See `.env.example`.

| Variable | Purpose | Default |
| --- | --- | --- |
| `TAVILY_API_KEY` | Tavily web-search API key | `""` |
| `NEBIUS_API_KEY` | Nebius LLM API key | `""` |
| `NEBIUS_BASE_URL` | Nebius OpenAI-compatible base URL | `https://api.studio.nebius.com/v1` |
| `NEBIUS_MODEL` | Primary LLM model id | `meta-llama/Llama-3.3-70B-Instruct` |
| `NEBIUS_FAST_MODEL` | Optional cheaper model for gap-id / extraction / disambiguation | unset (falls back to `NEBIUS_MODEL`) |
| `CACHE_TTL_HOURS` | Cache freshness window in hours | `24` |
| `DB_PATH` | SQLite cache location | `data/cache.db` |
| `TAVILY_UNIT_USD` | Per-search price used in the cost estimate | `0.008` |
| `NEBIUS_USD_PER_TOKEN` | Per-token price used in the cost estimate | `0.0000002` |

The dollar figure in `est_usd` is an estimate; the **call counts** are the
authoritative output. The engine reports this cost and never charges for it.
