// One throttled Nominatim client for every Cleaner module (public endpoint policy: <= 1 req/s,
// identifying UA - the same UA server.js geocodeLocation uses).
let last = 0;
async function nominatim(pathAndQuery) {
  const wait = 1100 - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org${pathAndQuery}`, { headers: { 'User-Agent': 'TuRu-KidsApp/1.0 (contact: mborenmusic@gmail.com)', 'Accept-Language': 'he' }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
module.exports = { nominatim };
