"""Depth-tiered enrichment pipeline.

``Researcher.enrich`` turns a company name into a typed ``CompanyProfile``.
The pipeline runs four parallel domain passes, optional web search, gap
identification, targeted follow-ups, regex + LLM synthesis, and a final
validation pass for the deepest tier. Every provider call routes through the
two private gateways (``_llm`` / ``_search``) so the threaded ``CostMeter``
counts each call exactly once. Monotonicity is structural: a comprehensive
run executes the identical standard pipeline plus exactly one validation
call, so its total call count is strictly greater for identical input.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re

from app.clients import LLMClient, SearchClient, SearchResult
from app.cost_meter import CostMeter
from app.models import Basics, CompanyProfile, Funding, Hiring, News, Product

logger = logging.getLogger(__name__)

_DOMAIN_SYSTEM = (
    "You are a company research assistant. Provide comprehensive, accurate, "
    "and up-to-date information about the company in question."
)
_EXTRACTION_SYSTEM = (
    "You are a precise data extraction assistant. Your only task is to extract "
    "structured information from text and return it as a valid JSON object with "
    "the exact fields specified. Do not include any explanation outside the JSON."
)
_GAP_SYSTEM = (
    "You are a research analyst specializing in identifying information gaps in "
    "company research. Be precise and analytical."
)
_FOLLOWUP_SYSTEM = (
    "You are a research assistant specializing in company analysis. Provide "
    "accurate, factual information only."
)
_VALIDATION_SYSTEM = (
    "You are a data validation assistant. Validate and correct structured "
    "company data against the provided research text. Respond with valid JSON only."
)

# Domain-specific research focuses; each yields one parallel domain pass.
_DOMAIN_FOCUS = {
    "funding": [
        "latest funding round, investors, amount, and date",
        "total funding raised and current valuation",
    ],
    "product": [
        "product offerings and core features",
        "technology stack and technical capabilities",
    ],
    "market": [
        "market position and competitors",
        "market share, growth, and industry trends",
    ],
    "team": [
        "founder and CEO background and experience",
        "leadership, team size, and recent hires",
    ],
}


def _domain_prompt(company: str, domain: str) -> str:
    """A prose research prompt for one domain (no JSON instruction)."""
    points = "".join(f"\n- {company} {q}" for q in _DOMAIN_FOCUS[domain])
    return (
        f"Research {company} focusing on its {domain.upper()} aspects.\n"
        f"Please address all of these points in detail:{points}\n\n"
        f"Provide a thorough analysis of {company}'s {domain} situation with "
        f"specific data points where available."
    )


def _followup_prompt(company: str, question: str) -> str:
    """A prose prompt answering one knowledge-gap question (no JSON instruction)."""
    return (
        f"Research and answer the following specific question about {company}:\n\n"
        f"Question: {question}\n\n"
        f"Provide a factual, well-researched answer based on reliable information. "
        f"Include specific details where available."
    )


def _extraction_prompt(company: str, subject: str, fields: list[str]) -> str:
    """An extraction prompt asking for a JSON object with the named fields."""
    field_lines = "\n".join(f"- {f}" for f in fields)
    return (
        f"Given the following text about {company}'s {subject}:\n\n"
        f"{subject_text_placeholder()}\n\n"
        f"Extract the following information, focusing ONLY on {company}.\n"
        f"If a piece of information is not present in the text, use null for "
        f"scalar fields or an empty list [] for list fields.\n\n"
        f"Output ONLY a valid JSON object with these exact fields:\n"
        f"{field_lines}\n\n"
        f"Important: only include information explicitly mentioned in the text. "
        f"For list fields, return an array of strings."
    )


def subject_text_placeholder() -> str:
    # Marker spliced out before send; the real text is injected by the caller.
    return "{__TEXT__}"


_PRODUCT_FIELDS = [
    "description (string): brief description of the product",
    "tech_stack (array of strings): technologies/frameworks used in the product",
    "target_market (string): target market or users of the product",
    "recent_updates (array of strings): notable product features or capabilities",
]
_FUNDING_FIELDS = [
    "stage (string): funding stage, e.g. 'Seed', 'Series A'",
    "latest_round (string): most recent funding amount, e.g. '$4.5 million'",
    "total_funding (string): total funding raised, e.g. '$6 million'",
    "investors (array of strings): list of investors",
    "runway_estimate (string): estimated financial runway, e.g. '18 months'",
]

_FOLLOWUP_BUCKETS = {
    "funding": ["fund", "investor", "money", "round", "valuation"],
    "product": ["product", "technology", "feature", "tech stack", "offering"],
    "market": ["market", "competitor", "industry", "customer"],
    "team": ["team", "founder", "employee", "hire", "staff", "ceo"],
    "news": ["news", "recent", "update", "press", "launch", "announce"],
}


class Researcher:
    """Runs the depth-gated enrichment pipeline against injected clients."""

    def __init__(
        self,
        llm: LLMClient,
        search: SearchClient,
        *,
        model: str,
        fast_model: str,
        meter: CostMeter,
    ) -> None:
        self.llm = llm
        self.search = search
        self.model = model
        self.fast_model = fast_model
        self.meter = meter

    # --- single metered gateways (the ONLY meter touch points in /enrich) ---

    async def _llm(
        self,
        system: str,
        prompt: str,
        *,
        model: str | None = None,
        max_tokens: int = 2000,
        temperature: float = 0.1,
    ) -> str:
        res = await self.llm.complete(
            system=system,
            prompt=prompt,
            model=(model or self.model),
            max_tokens=max_tokens,
            temperature=temperature,
        )
        self.meter.record_llm(res.total_tokens)
        return res.text

    async def _search(self, query: str, *, max_results: int = 5) -> list[SearchResult]:
        # Tavily rejects queries over 400 chars (BadRequestError); clamp here at
        # the single gateway so domain + follow-up searches are both covered.
        query = query.strip()[:400]
        results = await self.search.search(query, max_results=max_results)
        self.meter.record_search()
        return results

    # --- pipeline ---

    async def enrich(self, company: str, depth: str) -> CompanyProfile:
        web_enabled = depth != "basic"

        # 1. Domain passes (always) — four parallel prose research calls.
        domain_texts = await asyncio.gather(
            self._llm(_DOMAIN_SYSTEM, _domain_prompt(company, "funding")),
            self._llm(_DOMAIN_SYSTEM, _domain_prompt(company, "product")),
            self._llm(_DOMAIN_SYSTEM, _domain_prompt(company, "market")),
            self._llm(_DOMAIN_SYSTEM, _domain_prompt(company, "team")),
        )
        funding_text, product_text, market_text, team_text = domain_texts
        news_text = ""

        # 2. Web search (skip if basic) — one fixed set of Tavily queries.
        if web_enabled:
            web_queries = [
                f"{company} funding investors",
                f"{company} product technology",
                f"{company} latest news",
                f"{company} hiring jobs",
            ]
            search_batches = await asyncio.gather(
                *(self._search(q) for q in web_queries)
            )
            web_text = "\n\n".join(
                _results_to_text(batch) for batch in search_batches
            )
            news_text += web_text + "\n\n"

            # 3. Gap-id (skip if basic) — one fast-model call.
            gathered = "\n\n".join(
                [funding_text, product_text, market_text, team_text, web_text]
            )
            gaps = await self._identify_gaps(company, gathered)

            # 4. Follow-ups (skip if basic) — one search + one answer per gap.
            if gaps:
                follow_ups = await asyncio.gather(
                    *(self._answer_gap(company, gap) for gap in gaps)
                )
                for gap, answer in zip(gaps, follow_ups):
                    block = f"Question: {gap}\nAnswer: {answer}\n\n"
                    bucket = _route_followup(gap)
                    if bucket == "funding":
                        funding_text += block
                    elif bucket == "product":
                        product_text += block
                    elif bucket == "market":
                        market_text += block
                    elif bucket == "team":
                        team_text += block
                    elif bucket == "news":
                        news_text += block
                    else:
                        funding_text += block
                        product_text += block
                        market_text += block
                        team_text += block

        # 5. Synthesis (always) — regex for deterministic fields (free),
        #    LLM JSON extraction for fuzzy fields.
        basics = _extract_basics(team_text + market_text)
        hiring = _extract_hiring(team_text)
        news = _extract_news(news_text)

        product_data = await self._extract_json(
            company, "product information", _PRODUCT_FIELDS, product_text
        )
        funding_data = await self._extract_json(
            company, "funding information", _FUNDING_FIELDS, funding_text
        )
        product = _build_product(product_data)
        funding = _build_funding(funding_data)

        profile = CompanyProfile(
            company=company,
            confidence=(0.9 if web_enabled else 0.7),
            basics=basics,
            product=product,
            funding=funding,
            hiring=hiring,
            news=news,
        )

        # 6. Validation (comprehensive only) — exactly one extra LLM call.
        if depth == "comprehensive":
            research_text = "\n\n".join(
                [funding_text, product_text, market_text, team_text, news_text]
            )
            profile = await self._validate(company, profile, research_text)

        return profile

    async def _identify_gaps(self, company: str, gathered: str) -> list[str]:
        prompt = (
            f"Analyze the following research about {company} and identify 3-5 "
            f"important knowledge gaps that need further investigation:\n\n"
            f"{gathered}\n\n"
            f"List ONLY specific questions that need answers, as a numbered list, "
            f"focusing on the most critical missing information about funding, "
            f"product, market position, and team. These gaps guide follow-up "
            f"research."
        )
        text = await self._llm(
            _GAP_SYSTEM, prompt, model=self.fast_model, max_tokens=1000, temperature=0.2
        )
        questions: list[str] = []
        for line in text.split("\n"):
            line = line.strip()
            if line and (line.endswith("?") or ":" in line):
                cleaned = re.sub(r"^[\d\.\-\*]+\s*", "", line)
                if cleaned:
                    questions.append(cleaned)
        return questions[:5]

    async def _answer_gap(self, company: str, question: str) -> str:
        await self._search(question)
        return await self._llm(_FOLLOWUP_SYSTEM, _followup_prompt(company, question))

    async def _extract_json(
        self, company: str, subject: str, fields: list[str], text: str
    ) -> dict:
        if not text or len(text.strip()) < 10:
            logger.warning("Insufficient text for %s extraction of %s", subject, company)
            return {}
        prompt = _extraction_prompt(company, subject, fields).replace(
            subject_text_placeholder(), text
        )
        raw = await self._llm(_EXTRACTION_SYSTEM, prompt)
        return _parse_json_object(raw, what=f"{subject} extraction")

    async def _validate(
        self, company: str, profile: CompanyProfile, research_text: str
    ) -> CompanyProfile:
        prompt = (
            f"Validate and correct the structured data about {company} against "
            f"the provided research text.\n\n"
            f"The current extracted data is:\n{profile.model_dump_json(indent=2)}\n\n"
            f"Review it against the following research text:\n"
            f"{research_text[:3000]}\n\n"
            f"Identify inconsistencies, errors, or missing information. Return ONLY "
            f"a corrected JSON object with the same structure but improved accuracy. "
            f"Include only fields you are correcting."
        )
        # Bug-fix vs the source's latent defect: _llm returns a str; parse it
        # directly rather than calling .get(...) on the string.
        raw = await self._llm(_VALIDATION_SYSTEM, prompt)
        corrected = _parse_json_object(raw, what="validation")
        if not corrected:
            return profile
        return _merge_corrections(profile, corrected)


# --- free helpers (no provider calls, no meter) ---


def _results_to_text(results: list[SearchResult]) -> str:
    return "\n".join(f"{r.title}\n{r.content}" for r in results)


def _route_followup(question: str) -> str | None:
    q = question.lower()
    for bucket, keywords in _FOLLOWUP_BUCKETS.items():
        if any(kw in q for kw in keywords):
            return bucket
    return None


def _parse_json_object(text: str, *, what: str) -> dict:
    """json.loads with a ``{...}`` regex fallback; on failure log + return {}."""
    if not text:
        return {}
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if match:
            try:
                parsed = json.loads(match.group(0))
                return parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                pass
    logger.warning("Failed to parse JSON object for %s", what)
    return {}


def _build_product(data: dict) -> Product:
    return Product(
        description=data.get("description"),
        tech_stack=_as_str_list(data.get("tech_stack")),
        target_market=data.get("target_market"),
        recent_updates=_as_str_list(data.get("recent_updates")),
    )


def _build_funding(data: dict) -> Funding:
    return Funding(
        stage=data.get("stage"),
        latest_round=data.get("latest_round"),
        total_funding=data.get("total_funding"),
        investors=_as_str_list(data.get("investors")),
        runway_estimate=data.get("runway_estimate"),
    )


def _as_str_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value if v is not None]
    return []


def _merge_corrections(profile: CompanyProfile, corrected: dict) -> CompanyProfile:
    """Merge non-null corrected fields back into the profile's sub-models."""
    data = profile.model_dump()
    for section in ("basics", "product", "funding", "hiring", "news"):
        section_corr = corrected.get(section)
        if isinstance(section_corr, dict):
            for key, value in section_corr.items():
                if value is not None and key in data[section]:
                    data[section][key] = value
    top_conf = corrected.get("confidence")
    if isinstance(top_conf, (int, float)):
        data["confidence"] = float(top_conf)
    return CompanyProfile.model_validate(data)


# --- regex extractors (deterministic fields) ---


def _clean(text: str) -> str:
    return re.sub(r"\[\d+\]", "", text)


def _extract_basics(text: str) -> Basics:
    cleaned = _clean(text)

    stage_match = re.search(
        r"(?:stage|round)[:.\s]+\s*(seed|series [a-z]|ipo|acquired)", cleaned, re.I
    )
    if not stage_match:
        stage_match = re.search(r"(seed|series [a-z]|ipo|acquired)(?:\s+round)?", cleaned, re.I)

    team_match = re.search(
        r"(?:approximately|about|~|has|with|employs)?\s*([\d,]+)\s*"
        r"(?:employees|people|team\s*size|team\s*members|staff)",
        cleaned,
        re.I,
    )

    location_match = re.search(
        r"(?:based|located|headquarters?|headquartered)\s+in\s+([A-Za-z\s,]+?)(?:\.|\n|,|\()",
        cleaned,
        re.I,
    )

    mission_match = re.search(
        r"mission(?:\s+is)?[:\s]+([^\n\.]+?)(?:\.|\n|\[)", cleaned, re.I
    )

    return Basics(
        stage=stage_match.group(1).strip().title() if stage_match else None,
        team_size=team_match.group(1).strip() if team_match else None,
        location=location_match.group(1).strip() if location_match else None,
        mission=mission_match.group(1).strip() if mission_match else None,
        culture_keywords=_extract_keywords(cleaned, ["culture", "values", "remote", "startup"]),
    )


def _extract_hiring(text: str) -> Hiring:
    cleaned = _clean(text)

    open_roles: list[str] = []
    role_patterns = [
        r"open (?:positions?|roles?)(?:\s+include)?[:\s]+(.*?)(?:\n|$)",
        r"hiring for[:\s]+(.*?)(?:\n|$)",
        r"looking for[:\s]+(.*?)(?:\n|$)",
        r"(?:position|role|job) titles?[:\s]+(.*?)(?:\n|$)",
    ]
    for pattern in role_patterns:
        roles_match = re.search(pattern, cleaned, re.I)
        if roles_match:
            extracted = [r.strip() for r in re.split(r",|\band\b", roles_match.group(1)) if r.strip()]
            if extracted:
                open_roles.extend(extracted)
                break
    if not open_roles:
        for title in ("engineer", "developer", "researcher", "scientist", "designer", "manager", "director"):
            if re.search(rf"\b{title}s?\b", cleaned, re.I):
                open_roles.append(title.title())

    remote_match = re.search(r"remote(?:\s+policy)?[:\s]+(.*?)(?:\n|$)", cleaned, re.I)
    eng_culture_match = re.search(
        r"engineering\s+culture[:\s]+(.*?)(?:\n\n|$)", cleaned, re.I | re.DOTALL
    )

    departments: list[str] = []
    dept_match = re.search(r"departments?\s+hiring[:\s]+(.*?)(?:\n|$)", cleaned, re.I)
    if dept_match:
        departments = [d.strip() for d in re.split(r",|\band\b", dept_match.group(1)) if d.strip()]
    if not departments:
        for keyword in ("engineering", "research", "product", "sales", "marketing", "operations", "hr", "finance", "legal"):
            if re.search(rf"\b{keyword}\b", cleaned, re.I):
                departments.append(keyword.title())

    return Hiring(
        open_roles=open_roles[:10],
        departments_hiring=departments[:5],
        engineering_culture=eng_culture_match.group(1).strip() if eng_culture_match else None,
        remote_policy=remote_match.group(1).strip() if remote_match else None,
    )


def _extract_news(text: str) -> News:
    cleaned = _clean(text)

    summary = _extract_section(cleaned, "latest news")
    if not summary:
        summary = _extract_section(cleaned, "recent news")
    if not summary:
        summary = _extract_section(cleaned, "strategic partnerships")

    partnerships: list[str] = []
    partnership_patterns = [
        r"partnership(?:s)?\s+(?:with|between)[^\.]+?(?:with|and)\s+([A-Z][a-zA-Z ]+)",
        r"collaboration\s+(?:with|between)[^\.]+?(?:with|and)\s+([A-Z][a-zA-Z ]+)",
        r"partnered\s+with\s+([A-Z][a-zA-Z ]+)",
    ]
    for pattern in partnership_patterns:
        for match in re.finditer(pattern, cleaned, re.I):
            partner = match.group(1).strip()
            if partner and len(partner) > 3 and "**" not in partner:
                partnerships.append(partner)

    product_launches: list[str] = []
    launch_patterns = [
        r"(?:launched|released|announced)[^\.]*?\b([A-Z][a-zA-Z0-9 ]+?\b(?:\s+product|\s+model|\s+feature|\s+service))",
        r"(?:launched|released|announced)[^\.]*?(?:called|named)\s+([A-Z][a-zA-Z0-9 ]+)\b",
    ]
    for pattern in launch_patterns:
        for match in re.finditer(pattern, cleaned, re.I):
            launch = match.group(1).strip()
            if launch and len(launch) > 3 and "**" not in launch:
                if not any(launch.lower() in p.lower() or p.lower() in launch.lower() for p in product_launches):
                    product_launches.append(launch)

    press_mentions: list[str] = []
    press_patterns = [
        r"(?:mentioned|featured|covered)\s+(?:in|by)\s+([A-Z][a-zA-Z ]+)",
        r"(?:article|review|story)\s+(?:in|by|on)\s+([A-Z][a-zA-Z ]+)",
        r"([A-Z][a-zA-Z ]+)\s+(?:reported|wrote|published|covered)",
    ]
    for pattern in press_patterns:
        for match in re.finditer(pattern, cleaned, re.I):
            press = match.group(1).strip()
            if press and len(press) > 3 and "**" not in press:
                press_mentions.append(press)

    return News(
        summary=summary,
        product_launches=product_launches[:5],
        partnerships=[p for p in partnerships if ":" not in p[:15]][:5],
        press_mentions=press_mentions[:5],
    )


def _extract_keywords(text: str, keywords: list[str]) -> list[str]:
    lowered = text.lower()
    return [k for k in keywords if re.search(r"\b" + re.escape(k.lower()) + r"\b", lowered)]


def _extract_section(text: str, section_name: str) -> str | None:
    patterns = [
        rf"(?:##|#{{2,}})\s+.*?{section_name}.*?\n+(.*?)(?=\n\n#{{1,}}|\n\n\*\*|\Z)",
        rf"\*\*.*?{section_name}.*?\*\*\s*\n+(.*?)(?=\n\n#{{1,}}|\n\n\*\*|\Z)",
        rf"{section_name}.*?:\s*\n+(.*?)(?=\n\n#{{1,}}|\n\n\*\*|\Z)",
        rf"{section_name}.*?:(.*?)(?=\n\n|\Z)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.I | re.DOTALL)
        if match and match.group(1):
            return match.group(1).strip()
    return None
