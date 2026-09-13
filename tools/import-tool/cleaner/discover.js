// TuRu Cleaner - DISCOVER + CLASSIFY + PRIORITIZE: find records that need attention and upsert one
// cleaner_cases row per (subject, issue). Idempotent; cheap enough to run every cycle (a few
// paginated selects). Playgrounds are exempt from missing_image (placeholder policy is their designed
// resolution) but not from incomplete_address (reverse geocoding is cheap and useful in the app).
const { normalizeCityName } = require('../cityNaming');

const BASE_PRIORITY = { missing_location: 10, rejected_missing_address: 12, unverified_location: 15, missing_schedule: 25, incomplete_address: 30, missing_required_metadata: 35, missing_venue: 40, missing_region: 45, missing_image: 50, broken_image: 52, low_quality_description: 60 };
const META_ISSUES = new Set(['קטגוריה', 'תאריך', 'סוג ישות', 'קהל יעד לא ברור']);

async function all(client, table, select, fn) {
  let from = 0, rows = [];
  while (true) { let q = client.from(table).select(select).range(from, from + 999); if (fn) q = fn(q); const { data, error } = await q; if (error) throw new Error(table + ': ' + error.message); rows = rows.concat(data); if (data.length < 1000) return rows; from += 1000; }
}

// an extracted "2026-09-31" is not a date; it must not reach the date column (and is itself a metadata defect)
function validDate(d) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = new Date(d + 'T00:00:00Z');
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d ? null : d;
}

function priorityFor(issue, { eventDate, live, recurring, today }) {
  let p = BASE_PRIORITY[issue] ?? 50;
  if (eventDate) { const days = (new Date(eventDate) - new Date(today)) / 86400000; if (days <= 7) p -= 5; else if (days <= 30) p -= 3; }
  if (live) p -= 2;
  if (recurring) p -= 1;
  return p;
}

// -> { candidates: [{subject_kind, subject_id, issue, priority, event_date, source_id, opened_reason}], stats }
async function discoverCases(client, { today }) {
  const out = []; const stats = {};
  const add = (c) => { out.push(c); stats[c.issue] = (stats[c.issue] || 0) + 1; };

  // A. open incoming candidates (match_type new): blocking location / metadata issues
  const inc = await all(client, 'incoming_activities', 'id, source_id, validation_issues, found_at, status, city:extracted_data->>city, location_name:extracted_data->>location_name, formatted_address:extracted_data->>formatted_address, schedule_type:extracted_data->>schedule_type, one_time_date:extracted_data->>one_time_date, lat:extracted_data->>lat', (q) => q.in('status', ['new', 'needs_review', 'failed']).eq('match_type', 'new'));
  for (const r of inc) {
    const eventDate = r.schedule_type === 'one_time' ? validDate(r.one_time_date) : null;
    const recurring = r.schedule_type === 'recurring';
    const issues = [...(r.validation_issues || [])];
    if (r.schedule_type === 'one_time' && r.one_time_date && !eventDate && !issues.includes('תאריך')) issues.push('תאריך');
    const hasPlace = !!(normalizeCityName(r.city || null) && (r.location_name || r.formatted_address));
    if (!hasPlace) add({ subject_kind: 'incoming', subject_id: r.id, issue: 'missing_location', priority: priorityFor('missing_location', { eventDate, recurring, today }), event_date: eventDate, source_id: r.source_id, opened_reason: !r.city ? 'no city' : 'no location_name' });
    const meta = issues.filter((i) => META_ISSUES.has(i));
    if (meta.length) add({ subject_kind: 'incoming', subject_id: r.id, issue: 'missing_required_metadata', priority: priorityFor('missing_required_metadata', { eventDate, recurring, today }), event_date: eventDate, source_id: r.source_id, opened_reason: meta.join(',') });
    if (r.status === 'failed') add({ subject_kind: 'incoming', subject_id: r.id, issue: 'missing_required_metadata', priority: 20, event_date: eventDate, source_id: r.source_id, opened_reason: 'status failed' });
  }

  // B. live activities with missing important data
  const acts = await all(client, 'activities', 'id, category, venue_id, source_id, placeholder_group, photo_skipped, locations(id, address, city, lat, lng, region), activity_schedules(schedule_type, one_time_date), activity_images(id)', (q) => q.eq('status', 'approved'));
  for (const a of acts) {
    const pg = a.category === 'גן שעשועים';
    const loc = a.locations; const sched = a.activity_schedules || [];
    const oneTime = sched.find((s) => s.schedule_type === 'one_time');
    const eventDate = validDate(oneTime?.one_time_date || null);
    const recurring = sched.some((s) => s.schedule_type === 'recurring');
    const ctx = { eventDate, live: true, recurring, today };
    if (eventDate && eventDate < today) continue; // expired: the cron archives it, nothing to repair
    if (!loc || loc.lat == null || loc.lng == null) add({ subject_kind: 'activity', subject_id: a.id, issue: 'missing_coordinates', priority: 12, event_date: eventDate, source_id: a.source_id, opened_reason: 'live without coordinates' });
    else if (!loc.address) add({ subject_kind: 'activity', subject_id: a.id, issue: 'incomplete_address', priority: priorityFor('incomplete_address', ctx) + (pg ? 20 : 0), event_date: eventDate, source_id: a.source_id, opened_reason: 'coordinates without street address' });
    if (!pg && !a.venue_id) add({ subject_kind: 'activity', subject_id: a.id, issue: 'missing_venue', priority: priorityFor('missing_venue', ctx), event_date: eventDate, source_id: a.source_id, opened_reason: 'no canonical venue' });
    if (!pg && !(a.activity_images || []).length && !a.photo_skipped) add({ subject_kind: 'activity', subject_id: a.id, issue: 'missing_image', priority: priorityFor('missing_image', ctx), event_date: eventDate, source_id: a.source_id, opened_reason: a.placeholder_group ? 'placeholder ' + a.placeholder_group : 'no image' });
    if (!pg && !sched.length) add({ subject_kind: 'activity', subject_id: a.id, issue: 'missing_schedule', priority: priorityFor('missing_schedule', ctx), event_date: null, source_id: a.source_id, opened_reason: 'no schedule rows' });
    if (loc && !loc.region) add({ subject_kind: 'activity', subject_id: a.id, issue: 'missing_region', priority: priorityFor('missing_region', ctx), event_date: eventDate, source_id: a.source_id, opened_reason: 'location without region' });
  }
  return { candidates: out, stats };
}

// upsert without touching attempts/status of existing open cases; re-open nothing here (reopen.js does)
async function upsertCases(client, candidates) {
  let created = 0, existing = 0;
  const known = await all(client, 'cleaner_cases', 'subject_kind, subject_id, issue, status');
  const key = (c) => `${c.subject_kind}|${c.subject_id}|${c.issue}`;
  const map = new Map(known.map((k) => [key(k), k]));
  const rows = [];
  for (const c of candidates) { if (map.has(key(c))) { existing++; continue; } rows.push({ ...c, status: 'open', next_attempt_at: new Date().toISOString() }); }
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await client.from('cleaner_cases').insert(rows.slice(i, i + 200));
    if (error) throw new Error('cleaner_cases insert: ' + error.message);
    created += Math.min(200, rows.length - i);
  }
  // cases whose subject no longer has the issue (fixed by a human / the scanner) => resolved(external)
  const wanted = new Set(candidates.map(key));
  const stale = known.filter((k) => k.status === 'open' && !wanted.has(key(k)));
  for (const k of stale) await client.from('cleaner_cases').update({ status: 'resolved', resolution: { outcome: 'resolved_externally' }, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).match({ subject_kind: k.subject_kind, subject_id: k.subject_id, issue: k.issue });
  return { created, existing, closedExternally: stale.length };
}

module.exports = { discoverCases, upsertCases, all, BASE_PRIORITY };
