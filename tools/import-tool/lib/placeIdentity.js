// TuRu - PLACE identity for evergreen records (a farm, a petting zoo, a museum - not a dated event).
// Regression (2026-09-17): "חי פארק" and "חי פארק כפר סבא" - the same petting zoo imported from two
// websites on the same day, identical coordinates and address, both published. The pre-insert guards
// (google_place_id, event_fingerprint) cannot see it: the fingerprint contains the NAME, and the names
// differ by the city suffix. Entity semantics (binding): this is PLACE identity - it never applies to a
// dated event (two different shows in one hall are not duplicates) and never to a public playground
// (adjacent playgrounds are distinct; they have their own twin reconciliation).
//   same place  =  <= 80 m apart  AND  the names agree once locality words are dropped
// One rule for the pre-insert guard (server.js) and the DB-wide audit (audit-place-duplicates.js).
const { normalizeForMatch } = require('../eventFingerprint');
const { haversineKm } = require('./canonicalSettlement');

const SAME_PLACE_KM = 0.08;
const NAME_AGREEMENT = 0.8;
// words that say WHERE, not WHAT - dropped before names are compared
const LOCALITY_FILLER = new Set(['עיריית', 'עירוני', 'העירוני', 'עירונית', 'מועצה', 'מקומית', 'אזורית', 'ב', 'של']);

function placeNameWords(name, city) {
  const cityWords = new Set(normalizeForMatch(city).split(' ').filter(Boolean));
  const fold = (w) => w.replace(/[׳״]/g, '').replace(/יי/g, 'י').replace(/וו/g, 'ו');
  return new Set(normalizeForMatch(name).split(' ').map(fold).filter((w) => w.length > 1 && !cityWords.has(w) && !LOCALITY_FILLER.has(w)
    // "בכפר סבא" - the city with a prefix letter
    && !(w.length > 2 && /^[בלמה]/.test(w) && cityWords.has(w.slice(1)))));
}
function placeNameAgreement(a, b, city) {
  const A = placeNameWords(a, city), B = placeNameWords(b, city);
  if (!A.size || !B.size) return 0;
  let common = 0; A.forEach((w) => { if (B.has(w)) common++; });
  return common / Math.max(A.size, B.size);
}
const isDated = (rowOrCandidate) => rowOrCandidate.schedule_type === 'one_time' || (rowOrCandidate.activity_schedules || []).some((s) => s.schedule_type === 'one_time');

// a recurring ACTIVITY (a weekly class / series) is the same one only on the same days at the same hour:
// "סדרת תיאטרון סיפור ימי ב׳ 17:00" and "... ימי ג׳ 16:30" are two series in one hall, not a duplicate
const scheduleKey = (x) => (x.activity_schedules || []).filter((r) => r.schedule_type === 'recurring').map((r) => `${r.day_of_week}|${String(r.start_time || '').slice(0, 5)}`).sort().join(',');

// -> { same, km, agreement, why }
function samePlace(a, b) {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return { same: false, why: 'no coordinates' };
  if (isDated(a) || isDated(b)) return { same: false, why: 'a dated event is never a place duplicate' };
  if (a.category === 'גן שעשועים' || b.category === 'גן שעשועים') return { same: false, why: 'playgrounds have their own reconciliation' };
  const km = haversineKm(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
  if (km > SAME_PLACE_KM) return { same: false, km, why: 'too far apart' };
  const agreement = placeNameAgreement(a.name, b.name, a.city || b.city);
  const ka = scheduleKey(a), kb = scheduleKey(b);
  if (agreement >= NAME_AGREEMENT && ka && kb && ka !== kb) return { same: false, km: Math.round(km * 1000) / 1000, agreement: Math.round(agreement * 100) / 100, why: 'same spot and name, different recurring schedule (another class / series)' };
  return { same: agreement >= NAME_AGREEMENT, km: Math.round(km * 1000) / 1000, agreement: Math.round(agreement * 100) / 100, why: agreement >= NAME_AGREEMENT ? 'same spot, same name without locality words' : 'same spot, different name (another tenant / activity of the place)' };
}

// pre-insert guard: an approved evergreen activity at the same spot with the same place name, or null
async function findPlaceDuplicate(client, cand) {
  if (cand.lat == null || cand.lng == null || !cand.name || isDated(cand) || cand.category === 'גן שעשועים') return null;
  const d = 0.0012; // ~130 m box, refined by the exact distance below
  const { data } = await client.from('activities').select('id, name, category, locations!inner(city, lat, lng), activity_schedules(schedule_type, day_of_week, start_time)').eq('status', 'approved')
    .gte('locations.lat', Number(cand.lat) - d).lte('locations.lat', Number(cand.lat) + d).gte('locations.lng', Number(cand.lng) - d).lte('locations.lng', Number(cand.lng) + d).limit(40);
  for (const r of data || []) {
    const v = samePlace(cand, { name: r.name, category: r.category, city: r.locations.city, lat: r.locations.lat, lng: r.locations.lng, activity_schedules: r.activity_schedules });
    if (v.same) return { id: r.id, name: r.name, ...v };
  }
  return null;
}

module.exports = { samePlace, findPlaceDuplicate, placeNameAgreement, placeNameWords, SAME_PLACE_KM, NAME_AGREEMENT };
