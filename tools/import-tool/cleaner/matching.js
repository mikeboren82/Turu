// TuRu - Node mirror of supabase/functions/_shared/matching.ts (wordOverlapScore, haversineKm,
// getExistingActivitiesForCity, findSimilarActivities, computeConfidence) so the Cleaner can run the
// SAME deduplication the scanner runs before it hands a repaired candidate back to the pipeline.
// Keep in lockstep with the Deno file; tests/cleanerMatching.test.js asserts the shared cases.
const { normalizeCityName } = require('../cityNaming');
const { normalizeForMatch } = require('../eventFingerprint');

function wordOverlapScore(a, b) {
  const wa = new Set(normalizeForMatch(a).split(' ').filter((w) => w.length > 1));
  const wb = new Set(normalizeForMatch(b).split(' ').filter((w) => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0; wa.forEach((w) => { if (wb.has(w)) common++; });
  return common / Math.max(wa.size, wb.size);
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; const dLat = (lat2 - lat1) * Math.PI / 180; const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getConfidenceThresholds(settings) {
  return {
    duplicate: Number(settings.duplicate_confidence_threshold ?? 0.9),
    needsReview: Number(settings.needs_review_confidence_threshold ?? 0.6),
    proximityKm: Number(settings.proximity_km ?? 0.15),
  };
}

async function getExistingActivitiesForCity(client, city, cache) {
  const norm = normalizeCityName(city) || city;
  if (!norm) return [];
  if (cache.has(norm)) return cache.get(norm);
  const cityVariants = [...new Set([norm, city].filter(Boolean))];
  const { data, error } = await client.from('activities')
    .select('id, name, name_source, description, category, entity_type, min_age, max_age, price_type, price_amount, booking_requirement, source_url, venue_id, event_fingerprint, event_key, event_key_kind, official_url, source_id, location:locations!inner(name, city, lat, lng, address, address_source), activity_schedules(schedule_type, one_time_date, start_time, end_time, day_of_week), activity_images(url)')
    .in('location.city', cityVariants).eq('status', 'approved');
  if (error) throw error;
  const mapped = (data || []).map((a) => mapExistingRow(a));
  cache.set(norm, mapped);
  return mapped;
}

// mirror of matching.ts mapExistingRow: every dated performance is an occurrence; the scalar
// one_time_date/start_time are the EARLIEST UPCOMING one (PostgREST returns child rows unordered)
function mapExistingRow(a, today = new Date().toISOString().slice(0, 10)) {
  const rows = a.activity_schedules || [];
  const occ = rows.filter((s) => s.schedule_type === 'one_time' && s.one_time_date)
    .map((s) => ({ date: String(s.one_time_date), start_time: s.start_time ? String(s.start_time).slice(0, 5) : null, end_time: s.end_time ? String(s.end_time).slice(0, 5) : null }))
    .sort((x, y) => (x.date + (x.start_time || '')).localeCompare(y.date + (y.start_time || '')));
  const next = occ.find((o) => o.date >= today) || occ[0] || null;
  const sched = next ? null : (rows[0] || {});
  return {
    id: a.id, name: a.name, name_source: a.name_source, description: a.description, category: a.category,
    min_age: a.min_age, max_age: a.max_age, price_type: a.price_type, price_amount: a.price_amount,
    booking_requirement: a.booking_requirement, source_url: a.source_url,
    location_name: a.location?.name ?? null, address: a.location?.address ?? null, city: normalizeCityName(a.location?.city ?? null),
    address_source: a.location?.address_source ?? null,
    lat: a.location?.lat ?? null, lng: a.location?.lng ?? null,
    venue_id: a.venue_id ?? null, event_fingerprint: a.event_fingerprint ?? null,
    event_key: a.event_key ?? null, event_key_kind: a.event_key_kind ?? null, official_url: a.official_url ?? null, source_id: a.source_id ?? null, entity_type: a.entity_type ?? null,
    schedule_type: next ? 'one_time' : (sched?.schedule_type ?? null), one_time_date: next ? next.date : (sched?.one_time_date ?? null),
    start_time: next ? next.start_time : (sched?.start_time ? String(sched.start_time).slice(0, 5) : null), end_time: next ? next.end_time : (sched?.end_time ? String(sched.end_time).slice(0, 5) : null),
    recurring_days: rows.map((s) => s.day_of_week).filter(Boolean),
    occurrences: occ,
    has_image: (a.activity_images || []).length > 0,
  };
}
function candidateDates(c) { const s = new Set((Array.isArray(c?.occurrences) ? c.occurrences : []).map((o) => o.date).filter(Boolean)); if (c?.one_time_date) s.add(c.one_time_date); return [...s].sort(); }
function existingDates(e) { const s = new Set((e.occurrences || []).map((o) => o.date)); if (e.one_time_date) s.add(e.one_time_date); return [...s].sort(); }

async function findSimilarActivities(client, candidate, cache) {
  if (!candidate.name || !candidate.city) return [];
  const existing = await getExistingActivitiesForCity(client, candidate.city, cache);
  return existing
    .map((a) => ({ ...a, _nameScore: wordOverlapScore(candidate.name, a.name) }))
    .filter((a) => a._nameScore >= 0.3 || a.source_url === candidate.pageUrl || (candidate.venue_id && a.venue_id === candidate.venue_id))
    .sort((a, b) => b._nameScore - a._nameScore)
    .slice(0, 8);
}

function computeConfidence(candidate, existing, thresholds) {
  const breakdown = {};
  breakdown.exact_url_match = candidate.pageUrl && existing.source_url && candidate.pageUrl === existing.source_url ? 1 : 0;
  breakdown.fingerprint_match = candidate.event_fingerprint && existing.event_fingerprint && candidate.event_fingerprint === existing.event_fingerprint ? 1 : 0;
  breakdown.venue_match = candidate.venue_id && existing.venue_id && candidate.venue_id === existing.venue_id ? 1 : 0;
  breakdown.name_overlap = wordOverlapScore(candidate.name, existing.name);
  const candCity = normalizeCityName(candidate.city || null);
  breakdown.city_match = candCity && existing.city && candCity === existing.city ? 1 : 0;
  if (candidate.lat != null && candidate.lng != null && existing.lat != null && existing.lng != null) {
    const km = haversineKm(candidate.lat, candidate.lng, existing.lat, existing.lng);
    breakdown.proximity = km <= thresholds.proximityKm ? 1 : Math.max(0, 1 - km / (thresholds.proximityKm * 4));
  } else breakdown.proximity = 0;
  const cDates = candidateDates(candidate), eDates = existingDates(existing);
  if (cDates.length && eDates.length) breakdown.schedule_match = cDates.some((d) => eDates.includes(d)) ? 1 : 0; // any-date overlap
  else if (candidate.recurring_days?.length && existing.recurring_days?.length) {
    const overlap = candidate.recurring_days.filter((d) => existing.recurring_days.includes(d)).length;
    breakdown.schedule_match = overlap > 0 ? overlap / Math.max(candidate.recurring_days.length, existing.recurring_days.length) : 0;
  } else breakdown.schedule_match = 0;

  let score;
  const urlIdentity = breakdown.exact_url_match >= 1 && breakdown.name_overlap >= 0.5; // a shared listing page + same date is not identity
  if (breakdown.fingerprint_match >= 1 || urlIdentity) score = 0.95;
  else if (breakdown.venue_match >= 1) {
    score = (breakdown.name_overlap * 0.3) + (breakdown.venue_match * 0.3) + (breakdown.schedule_match * 0.3) + (breakdown.city_match * 0.1);
    if (breakdown.schedule_match >= 1 && breakdown.name_overlap >= 0.2) score = Math.max(score, 0.92);
  } else {
    score = (breakdown.name_overlap * 0.4) + (breakdown.city_match * 0.15) + (breakdown.proximity * 0.25) + (breakdown.schedule_match * 0.2) + (breakdown.exact_url_match * 0.1);
  }
  return { score: Math.min(1, Math.round(score * 1000) / 1000), breakdown };
}

// Best existing match for a candidate (or null). Same decision the scanner makes.
async function bestMatch(client, candidate, thresholds, cache) {
  const similar = await findSimilarActivities(client, candidate, cache);
  let best = null;
  for (const existing of similar) {
    const confidence = computeConfidence(candidate, existing, thresholds);
    if (!best || confidence.score > best.confidence.score) best = { activity: existing, confidence };
  }
  return best;
}

module.exports = { wordOverlapScore, haversineKm, getConfidenceThresholds, getExistingActivitiesForCity, findSimilarActivities, computeConfidence, bestMatch, mapExistingRow, candidateDates, existingDates };
