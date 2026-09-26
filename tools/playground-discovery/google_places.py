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

# IDs-only field mask - bills at Google's cheapest ("Essentials") SKU rather
# than the "Pro" tier DISCOVERY_FIELD_MASK triggers (any field beyond a bare
# ID/resource name is Pro). Used only for settlement_gap_check.py's coverage
# spot-check, where a raw result *count* is all that's needed - never for
# actually importing a place (a bare ID with no name/address/location isn't
# usable as an activity record).
IDS_ONLY_FIELD_MASK = "places.id"

RETRYABLE_STATUS = {429, 500, 502, 503, 504}  # kept for callers; any 5xx is retried (see _request)
RETRY_AFTER_CAP_SECONDS = 30.0


# Classified failures (2026-09-26, Places image automation). All subclass RuntimeError so every existing
# `except RuntimeError` / `except Exception` caller behaves exactly as before; `error_class` is a stable,
# key-free label a caller can store (enrich_images.py's ledger) - never the response body.
class PlacesApiError(RuntimeError):
    error_class = "error"

    def __init__(self, message: str, *, status_code: int | None = None, error_class: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        if error_class:
            self.error_class = error_class


class PlacesTransientError(PlacesApiError):
    """Timeout / transport / protocol error / 5xx that outlived the in-run retries."""
    error_class = "transient"


class PlacesMalformedResponse(PlacesApiError):
    """HTTP 200 whose body is not a JSON object - retried once, then this."""
    error_class = "malformed"


class PlacesInvalidPlace(PlacesApiError):
    """400 INVALID_ARGUMENT / 404 NOT_FOUND - this place id is not answerable; never retried in-run."""
    error_class = "invalid"


class PlacesRateLimited(PlacesApiError):
    """429 that outlived the bounded retries (Retry-After honoured) - the caller should stop the run."""
    error_class = "rate_limited"


class PlacesAuthError(PlacesApiError):
    """401 / 403 - key, API enablement or billing problem: a configuration failure, not a per-place fact."""
    error_class = "auth"


class PlacesCallBudgetExhausted(PlacesApiError):
    """The caller's call budget (e.g. a daily cap) has no calls left - no request was sent."""
    error_class = "budget"


class CallBudget:
    """Counts every HTTP attempt (retries included) against a hard cap."""

    def __init__(self, remaining: int):
        self.remaining = max(0, int(remaining))
        self.used = 0

    def take(self) -> bool:
        if self.remaining <= 0:
            return False
        self.remaining -= 1
        self.used += 1
        return True


@dataclass
class ApiCallStats:
    total_requests: int = 0
    attempts: int = 0  # every request sent, including ones that died in transport (total_requests = responses)
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
        call_budget: CallBudget | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep=asyncio.sleep,
    ):
        if not api_key:
            raise ValueError("GOOGLE_MAPS_API_KEY is required (see .env.example)")
        self._api_key = api_key
        self._semaphore = asyncio.Semaphore(max_concurrency)
        self._rate_limiter = RateLimiter(requests_per_second)
        self._max_retries = max_retries
        self._timeout = timeout_seconds
        self._call_budget = call_budget
        self._transport = transport  # tests only (httpx.MockTransport)
        self._sleep = sleep
        self.stats = ApiCallStats()

    async def _request(self, method: str, path: str, body: dict | None, field_mask: str, *, query_label: str | None) -> dict:
        url = f"{PLACES_BASE_URL}/{path}"
        headers = {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": self._api_key,
            "X-Goog-FieldMask": field_mask,
        }
        # Retry policy (2026-09-26): transport-level failures of ANY kind (timeouts, connect/read errors,
        # protocol errors, the empty-message "Server disconnected") and 5xx are transient and retried with
        # exponential backoff + jitter; 429 honours Retry-After (capped); a 200 that is not a JSON object is
        # retried once. 400/404 (bad or dead place id) and 401/403 (key/billing) are never retried.
        last_error: PlacesApiError | None = None
        malformed_seen = 0
        async with self._semaphore:
            async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
                for attempt in range(self._max_retries + 1):
                    can_retry = attempt < self._max_retries
                    if self._call_budget is not None and not self._call_budget.take():
                        raise PlacesCallBudgetExhausted(f"Places API {path}: call budget exhausted")
                    await self._rate_limiter.wait()
                    self.stats.attempts += 1
                    try:
                        resp = await client.request(method, url, json=body, headers=headers)
                    except httpx.TransportError as exc:
                        kind = "timeout" if isinstance(exc, httpx.TimeoutException) else "transport"
                        last_error = PlacesTransientError(
                            f"Places API {path} failed: {type(exc).__name__}: {exc}", error_class=kind)
                        logger.warning("[ERROR] endpoint=%s query=%s status=%s (%s) retry=%d",
                                       path, query_label, kind, type(exc).__name__, attempt)
                        if can_retry:
                            await self._sleep(self._backoff_seconds(attempt))
                            continue
                        raise last_error from exc
                    self.stats.record(path, query_label)
                    code = resp.status_code
                    if code == 200:
                        try:
                            data = resp.json()
                            if not isinstance(data, dict):
                                raise ValueError("not a JSON object")
                            return data
                        except ValueError:
                            malformed_seen += 1
                            last_error = PlacesMalformedResponse(f"Places API {path} returned a malformed 200 body",
                                                                 status_code=200)
                            logger.warning("[ERROR] endpoint=%s query=%s status=malformed_200 retry=%d",
                                           path, query_label, attempt)
                            if malformed_seen < 2 and can_retry:
                                await self._sleep(self._backoff_seconds(attempt))
                                continue
                            raise last_error
                    # Non-retryable (or retries exhausted) - surface the body for diagnosis, but never log the
                    # API key (it's only in headers, which we don't print here - section 29).
                    detail = f"Places API {path} failed: HTTP {code} - {resp.text[:300]}"
                    if code in (401, 403):
                        raise PlacesAuthError(detail, status_code=code)
                    if code in (400, 404):
                        raise PlacesInvalidPlace(detail, status_code=code)
                    if code == 429:
                        last_error = PlacesRateLimited(detail, status_code=code)
                        if can_retry:
                            wait = self._retry_after_seconds(resp.headers.get("Retry-After"))
                            logger.warning("[ERROR] endpoint=%s query=%s status_code=429 retry=%d retry_after=%s",
                                           path, query_label, attempt, wait)
                            await self._sleep(wait if wait is not None else self._backoff_seconds(attempt))
                            continue
                        raise last_error
                    if code >= 500:
                        last_error = PlacesTransientError(detail, status_code=code, error_class="http_5xx")
                        if can_retry:
                            logger.warning("[ERROR] endpoint=%s query=%s status_code=%d retry=%d",
                                           path, query_label, code, attempt)
                            await self._sleep(self._backoff_seconds(attempt))
                            continue
                        raise last_error
                    raise PlacesApiError(detail, status_code=code, error_class=f"http_{code}")
        raise last_error or PlacesApiError(f"Places API {path} failed after retries")

    @staticmethod
    def _retry_after_seconds(value: str | None) -> float | None:
        """Retry-After in delta-seconds form, capped; an HTTP-date or garbage -> None (use backoff)."""
        if not value:
            return None
        try:
            return max(0.0, min(RETRY_AFTER_CAP_SECONDS, float(value.strip())))
        except ValueError:
            return None

    async def _post(self, path: str, body: dict, field_mask: str, *, query_label: str | None) -> dict:
        return await self._request("POST", path, body, field_mask, query_label=query_label)

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

    async def count_nearby_ids(self, *, lat: float, lon: float, radius_m: int, included_types: list[str] | None,
                                max_results: int = 20) -> int:
        """IDs-only Nearby Search (IDS_ONLY_FIELD_MASK) - returns just how many
        places Google finds, not the places themselves. Cheap ("Essentials" tier)
        gap-detection signal for settlement_gap_check.py: if this count is
        meaningfully higher than what's already in TuRu for the same settlement,
        that settlement is worth a real (Pro-tier) follow-up search."""
        body = {
            "locationRestriction": {"circle": {"center": {"latitude": lat, "longitude": lon}, "radius": radius_m}},
            "maxResultCount": max_results,
            "rankPreference": "DISTANCE",
        }
        if included_types:
            body["includedTypes"] = included_types
        data = await self._post("places:searchNearby", body, IDS_ONLY_FIELD_MASK, query_label="__gap_check__")
        return len(data.get("places", []))

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

    async def has_photos(self, place_id: str) -> bool:
        """Place Details lookup used only to decide whether image enrichment has
        anything to offer for this place - never downloads/stores the photo
        itself or its `photos[].name` reference (Google's terms only allow
        indefinite storage of the place_id, see supabase/0055 and the
        place-photo Edge Function, which re-resolves the current photo live on
        every request instead)."""
        data = await self._request("GET", f"places/{place_id}", None, "photos", query_label="__details_photos__")
        return bool(data.get("photos"))
