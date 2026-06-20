"""Company-name disambiguation.

``Disambiguator.preview`` makes exactly one cheap LLM call to decide whether a
company name maps to multiple plausible distinct companies, and returns the
candidate choices. The call asks for a JSON array reply and is parsed leniently
(``json.loads`` with a ``[...]`` regex fallback); a parse failure degrades to an
empty list rather than crashing.
"""

from __future__ import annotations

import json
import logging
import re

from app.clients import LLMClient
from app.cost_meter import CostMeter
from app.models import DisambiguationChoice

logger = logging.getLogger(__name__)

_SYSTEM = (
    "You are a research assistant specializing in identifying distinct companies "
    "that share the same name. Be thorough and accurate."
)


def _prompt(company: str) -> str:
    return (
        f"Determine whether '{company}' names multiple plausible distinct "
        f"companies. For each distinct company, give its full name, a "
        f"one-sentence description of its primary business, and its primary "
        f"website domain (e.g. example.com) if known.\n\n"
        f"Reply with ONLY a JSON array of objects with these exact keys: "
        f'"name", "description", "domain". Use an empty array [] or a single '
        f"element if the name is unambiguous, and two or more elements if "
        f"multiple distinct companies share the name."
    )


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


class Disambiguator:
    """Resolves a company name into candidate disambiguation choices."""

    def __init__(self, llm: LLMClient, *, model: str) -> None:
        self.llm = llm
        self.model = model

    async def preview(
        self, company: str, *, meter: CostMeter | None = None
    ) -> list[DisambiguationChoice]:
        res = await self.llm.complete(
            system=_SYSTEM,
            prompt=_prompt(company),
            model=self.model,
            max_tokens=1000,
            temperature=0.1,
        )
        if meter is not None:
            meter.record_llm(res.total_tokens)

        items = _parse_json_array(res.text)
        choices: list[DisambiguationChoice] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if not name:
                continue
            domain = item.get("domain") or None
            choice_id = _slug(str(name))
            if domain:
                choice_id = f"{_slug(str(domain).split('.')[0])}_{choice_id}"
            choices.append(
                DisambiguationChoice(
                    id=choice_id,
                    display_name=str(name),
                    description=item.get("description") or None,
                    domain=domain,
                )
            )
        return choices


def _parse_json_array(text: str) -> list:
    """json.loads with a ``[...]`` regex fallback; on failure log + return []."""
    if not text:
        return []
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        match = re.search(r"\[[\s\S]*\]", text)
        if match:
            try:
                parsed = json.loads(match.group(0))
                return parsed if isinstance(parsed, list) else []
            except json.JSONDecodeError:
                pass
    logger.warning("Failed to parse disambiguation JSON array")
    return []
