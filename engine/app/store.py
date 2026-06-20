"""SQLite-backed profile cache for the fulfilment engine.

A ``CompanyProfile`` is cached on the composite key ``(normalized_name,
depth)`` with a creation timestamp; reads honour a TTL. A malformed cached
row (unparseable ``created_at`` or ``profile_json``) is treated as a miss and
logged -- never silently substituted with a fabricated profile.
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone

import aiosqlite

from app.models import CompanyProfile

logger = logging.getLogger(__name__)


class ProfileCache:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._conn = None

    async def connect(self) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(self.db_path)), exist_ok=True)
        self._conn = await aiosqlite.connect(self.db_path)
        await self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS profile_cache (
                normalized_name TEXT,
                depth TEXT,
                profile_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (normalized_name, depth)
            )
            """
        )
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    async def get(
        self, normalized_name: str, depth: str, ttl_hours: int
    ) -> CompanyProfile | None:
        async with self._conn.execute(
            "SELECT profile_json, created_at FROM profile_cache "
            "WHERE normalized_name = ? AND depth = ?",
            (normalized_name, depth),
        ) as cursor:
            row = await cursor.fetchone()
        if row is None:
            return None
        profile_json, created_at_str = row
        try:
            created_at = datetime.fromisoformat(created_at_str)
        except ValueError:
            logger.warning(
                "Unparseable created_at for cache key (%s, %s); treating as miss",
                normalized_name,
                depth,
            )
            return None
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        if (datetime.now(timezone.utc) - created_at) > timedelta(hours=ttl_hours):
            return None
        try:
            return CompanyProfile.model_validate_json(profile_json)
        except Exception:
            logger.warning(
                "Malformed profile_json for cache key (%s, %s); treating as miss",
                normalized_name,
                depth,
            )
            return None

    async def put(
        self, normalized_name: str, depth: str, profile: CompanyProfile
    ) -> None:
        await self._conn.execute(
            "INSERT OR REPLACE INTO profile_cache "
            "(normalized_name, depth, profile_json, created_at) VALUES (?, ?, ?, ?)",
            (
                normalized_name,
                depth,
                profile.model_dump_json(),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        await self._conn.commit()
