// TuRu - Israel Transverse Mercator (ITM, "רשת ישראל החדשה", EPSG:2039) <-> WGS84.
// Explicit conversion for authoritative CBS settlement reference points (קובץ היישובים, column
// "קואורדינטות"): Transverse Mercator on GRS80, then the 7-parameter Helmert shift from the Israel
// datum to WGS84 (values published by the Survey of Israel; sub-metre accuracy is irrelevant here -
// settlement reference points are "centre of the built-up area", validated against known places).
const GRS80 = { a: 6378137.0, f: 1 / 298.257222101 };
const ITM = { lat0: 31.7343936111, lon0: 35.2045169444, k0: 1.0000067, fe: 219529.584, fn: 626907.39 };
// Israel 1993 (GRS80-based ITM datum) -> WGS84 Helmert parameters (Survey of Israel, dX dY dZ in m, rotations in arc-sec, scale ppm)
const HELMERT = { dx: -24.0024, dy: -17.1032, dz: -17.8444, rx: -0.33077, ry: -1.85269, rz: 1.66969, ds: 5.4248 };
const D2R = Math.PI / 180;

function tmInverse(E, N, ell, p) {
  const { a, f } = ell; const e2 = f * (2 - f); const e = Math.sqrt(e2); const ep2 = e2 / (1 - e2);
  const lat0 = p.lat0 * D2R, lon0 = p.lon0 * D2R;
  const M0 = a * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256) * lat0 - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * lat0) + (15 * e2 * e2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * lat0) - (35 * e2 ** 3 / 3072) * Math.sin(6 * lat0));
  const M = M0 + (N - p.fn) / p.k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
  const C1 = ep2 * c * c, T1 = t * t;
  const N1 = a / Math.sqrt(1 - e2 * s * s);
  const R1 = a * (1 - e2) / Math.pow(1 - e2 * s * s, 1.5);
  const D = (E - p.fe) / (N1 * p.k0);
  const lat = phi1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / c;
  return { lat: lat / D2R, lng: lon / D2R };
}

function geodeticToEcef(lat, lng, h, ell) {
  const e2 = ell.f * (2 - ell.f); const s = Math.sin(lat * D2R), c = Math.cos(lat * D2R);
  const N = ell.a / Math.sqrt(1 - e2 * s * s);
  return { x: (N + h) * c * Math.cos(lng * D2R), y: (N + h) * c * Math.sin(lng * D2R), z: (N * (1 - e2) + h) * s };
}
function ecefToGeodetic(x, y, z, ell) {
  const e2 = ell.f * (2 - ell.f); const p = Math.sqrt(x * x + y * y);
  let lat = Math.atan2(z, p * (1 - e2)); let N, h;
  for (let i = 0; i < 6; i++) { const s = Math.sin(lat); N = ell.a / Math.sqrt(1 - e2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - e2 * N / (N + h))); }
  return { lat: lat / D2R, lng: Math.atan2(y, x) / D2R };
}
function helmert(pt, h) {
  const rx = h.rx / 3600 * D2R, ry = h.ry / 3600 * D2R, rz = h.rz / 3600 * D2R, s = 1 + h.ds * 1e-6;
  return { x: h.dx + s * (pt.x - rz * pt.y + ry * pt.z), y: h.dy + s * (rz * pt.x + pt.y - rx * pt.z), z: h.dz + s * (-ry * pt.x + rx * pt.y + pt.z) };
}

// ITM easting/northing (metres) -> WGS84 { lat, lng }
function itmToWgs84(E, N) {
  const g = tmInverse(Number(E), Number(N), GRS80, ITM);
  const ecef = helmert(geodeticToEcef(g.lat, g.lng, 0, GRS80), HELMERT);
  const w = ecefToGeodetic(ecef.x, ecef.y, ecef.z, { a: 6378137.0, f: 1 / 298.257223563 });
  return { lat: Math.round(w.lat * 1e6) / 1e6, lng: Math.round(w.lng * 1e6) / 1e6 };
}

// CBS "קואורדינטות": 12 digits = XXXXXX YYYYYY metres; 10 digits = XXXXX YYYYY in tens of metres (legacy /
// pseudo-areas). Anything else -> null (never guessed).
function parseCbsCoordinates(raw) {
  const s = String(raw ?? '').trim();
  if (/^\d{12}$/.test(s)) return { E: Number(s.slice(0, 6)), N: Number(s.slice(6)), precision_m: 1 };
  if (/^\d{10}$/.test(s)) return { E: Number(s.slice(0, 5)) * 10, N: Number(s.slice(5)) * 10, precision_m: 10 };
  return null;
}

module.exports = { itmToWgs84, parseCbsCoordinates, tmInverse, ITM, GRS80, HELMERT };
