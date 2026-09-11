"""
TuRu - Playground/park discovery: Israel geography helpers.

Pure functions only (no I/O, no network) - grid generation, bounds checking,
distance calculation. Kept separate from google_places.py/playground_discovery.py
so they're trivially unit-testable without any network/API mocking.

Israel bounding box below is a superset (a bit generous on every edge) of the
country's actual extent, deliberately - grid coverage should never clip a real
place near a border; false positives just outside the true border are filtered
later via OUT_OF_BOUNDS classification using the same box, not a tighter one.
"""
from dataclasses import dataclass
from math import radians, sin, cos, sqrt, atan2

# Configurable via CLI (--min-lat/--max-lat/--min-lon/--max-lon) - these are only
# the defaults. Covers Eilat in the south to the Lebanon border in the north,
# the Mediterranean coast to past the Jordan Valley in the east.
DEFAULT_ISRAEL_BOUNDS = {
    "min_lat": 29.45,
    "max_lat": 33.35,
    "min_lon": 34.20,
    "max_lon": 35.95,
}

EARTH_RADIUS_KM = 6371.0


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km. Same formula already used in the Node side
    of this project (lib/filterActivities.js haversineKm, tools/import-tool
    server.js haversineKm) - kept consistent across languages, not reinvented."""
    d_lat = radians(lat2 - lat1)
    d_lon = radians(lon2 - lon1)
    a = sin(d_lat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ** 2
    return EARTH_RADIUS_KM * 2 * atan2(sqrt(a), sqrt(1 - a))


def is_in_bounds(lat: float, lon: float, bounds: dict = None) -> bool:
    if lat is None or lon is None:
        return False
    b = bounds or DEFAULT_ISRAEL_BOUNDS
    return b["min_lat"] <= lat <= b["max_lat"] and b["min_lon"] <= lon <= b["max_lon"]


@dataclass(frozen=True)
class GridPoint:
    grid_id: str
    lat: float
    lon: float
    radius_m: int
    refinement_level: int = 0
    parent_grid_id: str | None = None


def generate_grid(bounds: dict, step_deg: float, radius_m: int) -> list[GridPoint]:
    """A simple regular lat/lon grid over `bounds`, spaced `step_deg` apart.
    Deliberately NOT using the existing constants/israeliCities.js city-name list
    for this - that list has no coordinates and is not exhaustive (documented in
    its own header comment as "not a complete list"), so it can't drive real
    geographic coverage. A coordinate grid is what section 2/3 of the request
    actually needs; the city list stays useful later only as a human-readable
    label lookup, not as the search geometry itself.
    """
    if step_deg <= 0:
        raise ValueError("step_deg must be > 0")
    # Indexed by row/col count (rounded) rather than accumulating floats in a
    # while-loop condition - repeated += step_deg drifts (e.g. 31.0 + 0.1 + 0.1
    # lands a hair above 31.2 in binary float), silently dropping the last row/col.
    points: list[GridPoint] = []
    n_rows = round((bounds["max_lat"] - bounds["min_lat"]) / step_deg) + 1
    n_cols = round((bounds["max_lon"] - bounds["min_lon"]) / step_deg) + 1
    for row in range(n_rows):
        lat = round(bounds["min_lat"] + row * step_deg, 6)
        for col in range(n_cols):
            lon = round(bounds["min_lon"] + col * step_deg, 6)
            points.append(GridPoint(grid_id=f"g{row}-{col}", lat=lat, lon=lon, radius_m=radius_m))
    return points


def refine_grid_point(point: GridPoint, max_level: int) -> list[GridPoint]:
    """Splits a SATURATED_GRID point into 4 sub-points at half the radius (section
    37 - bounded adaptive refinement). Returns [] once max_level is reached, so
    callers never recurse infinitely - MAX_REFINEMENT_LEVEL is enforced here,
    not left to caller discipline."""
    if point.refinement_level >= max_level:
        return []
    # Half-radius offset in degrees, approximated (good enough at this radius scale -
    # 1 degree latitude ~= 111km, consistent everywhere; longitude varies with
    # latitude but the error is negligible at the sub-grid distances used here).
    offset_deg = (point.radius_m / 2) / 111_000
    sub_radius = max(100, point.radius_m // 2)
    next_level = point.refinement_level + 1
    offsets = [(-1, -1), (-1, 1), (1, -1), (1, 1)]
    return [
        GridPoint(
            grid_id=f"{point.grid_id}-r{next_level}-{i}",
            lat=round(point.lat + dy * offset_deg, 6),
            lon=round(point.lon + dx * offset_deg, 6),
            radius_m=sub_radius,
            refinement_level=next_level,
            parent_grid_id=point.grid_id,
        )
        for i, (dy, dx) in enumerate(offsets)
    ]
