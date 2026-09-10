"""
TuRu - Playground/park discovery: Google Places API (New) client.

Only the official REST API (places.googleapis.com) - never Google Search/Maps
HTML scraping, never CAPTCHA bypass (explicit requirement, section 31).
Async (httpx) so MAX_CONCURRENCY (section 8/28) is a real asyncio.Semaphore,
not a fake sequential loop labeled "concurrent".

Field masks are always an explicit minimal list - never "*" (section 6/27).
"""
import asyncio
import logging
import time
from dataclasses import dataclass

import httpx

logger = logging.getLogger("playground_discovery.google_places")

PLACES_BASE_URL = "https://places.googleapis.com/v1"

# Minimal field set for discovery (section 6) - no photos here on purpose;
# photos are a separate, later concern (image enrichment), not discovery.
DISCOVERY_FIELD_MASK = ",".join([
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.location",
    "places.types",
    "places.primaryType",
    "places.googleMapsUri",
])

RETRYABLE_STATUS = {429, 500, 502, 503, 504}


@dataclass
class ApiCallStats:
    total_requests: int = 0
    requests_by_endpoint: dict = None
    requests_by_query: dict = None

    def __post_init__(self):
        if self.requests_by_endpoint is None:
            self.requests_by_endpoint = {}
        if self.requests_by_query is None:
            self.requests_by_query = {}

    def record(self, endpoint: str, query: str | None):
        self.total_requests += 1
        self.requests_by_endpoint[endpoint] = self.requests_by_endpoint.get(endpoint, 0) + 1
        if query:
            self.requests_by_query[query] = self.requests_by_query.get(query, 0) + 1


class RateLimiter:
    """Simple requests-per-second gate shared across all concurrent workers -
    section 28 (REQUESTS_PER_SECOND), independent of MAX_CONCURRENCY (which
    limits how many calls are in flight, not how fast new ones start)."""

    def __init__(self, requests_per_second: float):
        self._min_interval = 1.0 / requests_per_second if requests_per_second > 0 else 0
        self._lock = asyncio.Lock()
        self._last_call = 0.0

    async def wait(self):
        if self._min_interval <= 0:
            return
        async with self._lock:
            now = time.monotonic()
            wait_for = self._last_call + self._min_interval - now
            if wait_for > 0:
                await asyncio.sleep(wait_for)
            self._last_call = time.monotonic()


class GooglePlacesClient:
    def __init__(
        self,
        api_key: str,
        *,
        max_concurrency: int = 5,
        requests_per_second: float = 5.0,
        max_retries: int = 4,
        timeout_seconds: float = 15.0,
    ):
        if not api_key:
            raise ValueError("GOOGLE_MAPS_API_KEY is required (see .env.example)")
        self._api_key = api_key
        self._semaphore = asyncio.Semaphore(max_concurrency)
        self._rate_limiter = RateLimiter(requests_per_second)
        self._max_retries = max_retries
        self._timeout = timeout_seconds
        self.stats = ApiCallStats()

    async def _post(self, path: str, body: dict, field_mask: str, *, query_label: str | None) -> dict:
        url = f"{PLACES_BASE_URL}/{path}"
        headers = {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": self._api_key,
            "X-Goog-FieldMask": field_mask,
        }
        last_error = None
        async with self._semaphore:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                for attempt in range(self._max_retries + 1):
                    await self._rate_limiter.wait()
                    try:
                        resp = await client.post(url, json=body, headers=headers)
                    except httpx.TimeoutException as exc:
                        last_error = exc
                        logger.warning("[ERROR] endpoint=%s query=%s status=timeout retry=%d", path, query_label, attempt)
                        await asyncio.sleep(self._backoff_seconds(attempt))
                        continue
                    self.stats.record(path, query_label)
                    if resp.status_code == 200:
                        return resp.json()
                    if resp.status_code in RETRYABLE_STATUS and attempt < self._max_retries:
                        logger.warning(
                            "[ERROR] endpoint=%s query=%s status_code=%d retry=%d",
                            path, query_label, resp.status_code, attempt,
                        )
                        await asyncio.sleep(self._backoff_seconds(attempt))
                        continue
                    # Non-retryable (or retries exhausted) - surface the body for
                    # diagnosis, but never log the API key (it's only in headers,
                    # which we don't print here - section 29).
                    raise RuntimeError(f"Places API {path} failed: HTTP {resp.status_code} - {resp.text[:300]}")
        raise RuntimeError(f"Places API {path} failed after retries: {last_error}")

    @staticmethod
    def _backoff_seconds(attempt: int) -> float:
        import random
        return min(30.0, (2 ** attempt)) + random.uniform(0, 0.5)  # jitter, section 28

    async def search_nearby(self, *, lat: float, lon: float, radius_m: int, included_types: list[str] | None,
                             max_results: int = 20, query_label: str | None = None) -> list[dict]:
        body = {
            "locationRestriction": {"circle": {"center": {"latitude": lat, "longitude": lon}, "radius": radius_m}},
            "maxResultCount": max_results,
            "rankPreference": "DISTANCE",
        }
        if included_types:
            body["includedTypes"] = included_types
        data = await self._post("places:searchNearby", body, DISCOVERY_FIELD_MASK, query_label=query_label)
        return data.get("places", [])

    async def search_text(self, *, query: str, lat: float, lon: float, radius_m: int,
                           max_results: int = 20) -> list[dict]:
        body = {
            "textQuery": query,
            "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lon}, "radius": radius_m}},
            "maxResultCount": max_results,
            "languageCode": "he" if any("֐" <= ch <= "׿" for ch in query) else "en",
            "regionCode": "IL",
        }
        data = await self._post("places:searchText", body, DISCOVERY_FIELD_MASK, query_label=query)
        return data.get("places", [])
