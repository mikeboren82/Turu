// TuRu - classify the OPEN review queue (incoming_activities in status new/needs_review) by the
// reason each item is still there, so the backlog is never an unexplained "pending" pile.
// Read-only. Prints a breakdown and writes review-queue-classification-<date>.json (report input).
//
// Classification is driven by what the rows ACTUALLY carry (audited 2026-09-13): validation_issues
// ('מחיר' soft; 'עיר','קטגוריה','תאריך','סוג ישות','קהל יעד לא ברור' gating), extracted_data
// (city/location_name/venue_id/one_time_date/audience/images/event_fingerprint - lat/lng are ALWAYS
// null on incoming rows: coordinates are resolved by geocoding at approval time), match_type
// (new | update + existing_activity_id + diff), the source's trust/health, and a live fingerprint
// lookup against activities. Dimensions the data cannot support are reported as
// unclassifiable_insufficient_data with the missing information named - never guessed.
//   node classify-review-queue.js [--json-only]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient } = require('./supabase');
const { assessChildRelevance } = require('./childRelevance');

const SOFT = new Set(['מחיר']);
const META_ISSUES = { 'קטגוריה': 'category', 'תאריך': 'date', 'סוג ישות': 'entity_type' };

// primary reason = first matching rule (a blocker), flags = every non-blocking weakness observed
const CATEGORY_META = {
  duplicate:                      { automatable: 'yes - auto-link to the existing activity via event_fingerprint / possible_duplicate flag', human: 'no (spot-check only)' },
  expired_event:                  { automatable: 'yes - auto-reject (reprocess-review-queue.js already does this)', human: 'no' },
  adult_or_irrelevant:            { automatable: 'yes - assessChildRelevance reject (already automated)', human: 'no' },
  blocked_source:                 { automatable: 'no - source paused/attention; resolve via relay-scan or reactivate', human: 'no (ops)' },
  update_to_existing_activity:    { automatable: 'partially - auto-apply when the diff touches only additive/soft fields (description, images, price, times)', human: 'yes when name/date/venue changes' },
  missing_address_or_location:    { automatable: 'partially - venue aliases + municipality default city; otherwise needs a human or a better page', human: 'often' },
  incomplete_required_metadata:   { automatable: 'partially - re-extraction with category/date hints; category inference from text', human: 'sometimes' },
  ambiguous_event:                { automatable: 'no - audience genuinely unclear on the page', human: 'yes' },
  untrusted_source_policy_hold:   { automatable: 'yes - by raising source trust (>=80) after a yield/quality review of that source', human: 'yes today, by policy' },
  event_too_far_ahead:            { automatable: 'yes - re-evaluate automatically when the date enters the 180-day window', human: 'no' },
  genuinely_requires_human_judgment: { automatable: 'no', human: 'yes' },
  other:                          { automatable: 'unknown', human: 'unknown' },
};

async function all(client, table, select, fn) {
  let from = 0, rows = [];
  while (true) { let q = client.from(table).select(select).range(from, from + 999); if (fn) q = fn(q); const { data, error } = await q; if (error) throw error; rows = rows.concat(data); if (data.length < 1000) return rows; from += 1000; }
}

(async () => {
  const { client } = await getClient();
  const { data: settingsRows } = await client.from('automation_settings').select('key, value');
  const settings = Object.fromEntries((settingsRows || []).map((r) => [r.key, r.value]));
  const minTrust = Number(settings.auto_approve_min_trust_score ?? 80);
  const maxDays = Number(settings.event_max_days_ahead ?? 180);
  const today = new Date().toISOString().slice(0, 10);
  const maxDate = new Date(Date.now() + maxDays * 86400000).toISOString().slice(0, 10);

  const rows = await all(client, 'incoming_activities',
    'id, match_type, status, validation_issues, confidence_score, existing_activity_id, diff, page_url, found_at, extracted_data, source:sources(id, name, is_active, health_status, disabled_reason, is_trusted, source_trust_score, source_kind, publisher_type)',
    (q) => q.in('status', ['new', 'needs_review']));

  const fps = [...new Set(rows.map((r) => r.extracted_data?.event_fingerprint).filter(Boolean))];
  const existingFp = new Set();
  for (let i = 0; i < fps.length; i += 150) {
    const { data } = await client.from('activities').select('event_fingerprint').in('event_fingerprint', fps.slice(i, i + 150));
    (data || []).forEach((a) => existingFp.add(a.event_fingerprint));
  }

  const classified = rows.map((r) => {
    const c = r.extracted_data || {};
    const issues = r.validation_issues || [];
    const gating = issues.filter((i) => !SOFT.has(i));
    const src = r.source || {};
    const trusted = !!src.is_trusted || (src.source_trust_score != null && Number(src.source_trust_score) >= minTrust);
    const rel = assessChildRelevance(c);
    const isOneTime = c.schedule_type === 'one_time';
    const hasPlace = !!(c.city && (c.location_name || c.formatted_address));
    const hasImage = !!((c.images && c.images.length) || (c.image_urls && c.image_urls.length) || c.image_url);
    const metaMissing = gating.filter((i) => META_ISSUES[i]).map((i) => META_ISSUES[i]);
    const diffKeys = r.match_type === 'update' && r.diff && typeof r.diff === 'object' ? Object.keys(r.diff) : [];

    const flags = [];
    if (c.location_name && !c.venue_id) flags.push('unresolved_venue');
    if (!hasImage) flags.push('missing_image');
    if (!c.city) flags.push('missing_city');
    if (issues.includes('מחיר')) flags.push('missing_price');
    if (r.match_type === 'new' && !c.audience) flags.push('audience_not_extracted');

    let primary, detail = null;
    if ((c.event_fingerprint && existingFp.has(c.event_fingerprint)) || issues.some((i) => i.startsWith('possible_duplicate'))) primary = 'duplicate';
    else if (isOneTime && c.one_time_date && c.one_time_date < today) primary = 'expired_event';
    else if (rel === 'reject') primary = 'adult_or_irrelevant';
    else if (src.id && (!src.is_active || ['auto_paused', 'attention_required'].includes(src.health_status))) { primary = 'blocked_source'; detail = src.disabled_reason || src.health_status; }
    else if (r.match_type === 'update') { primary = 'update_to_existing_activity'; detail = diffKeys.join(','); }
    else if (!hasPlace) { primary = 'missing_address_or_location'; detail = !c.city ? 'no city' : 'no location_name'; }
    else if (metaMissing.length) { primary = 'incomplete_required_metadata'; detail = metaMissing.join(','); }
    else if (rel === 'review' || gating.includes('קהל יעד לא ברור')) { primary = 'ambiguous_event'; detail = c.audience || 'audience missing'; }
    else if (!trusted) { primary = 'untrusted_source_policy_hold'; detail = `${src.name} trust=${src.source_trust_score}`; }
    else if (isOneTime && c.one_time_date && c.one_time_date > maxDate) { primary = 'event_too_far_ahead'; detail = c.one_time_date; }
    else if (isOneTime && !c.one_time_date) { primary = 'incomplete_required_metadata'; detail = 'one_time without date'; }
    else if (gating.length) { primary = 'genuinely_requires_human_judgment'; detail = gating.join(','); }
    else primary = 'other';
    return { id: r.id, primary, detail, flags, source: src.name || '(none)', name: c.name, city: c.city || null, date: c.one_time_date || null, match_type: r.match_type };
  });

  const n = classified.length;
  const byPrimary = {};
  classified.forEach((x) => { (byPrimary[x.primary] = byPrimary[x.primary] || []).push(x); });
  const summary = Object.entries(byPrimary).sort((a, b) => b[1].length - a[1].length).map(([cat, items]) => {
    const details = {}; items.forEach((i) => { const k = i.detail || '-'; details[k] = (details[k] || 0) + 1; });
    const sources = {}; items.forEach((i) => { sources[i.source] = (sources[i.source] || 0) + 1; });
    return {
      category: cat, count: items.length, pct: Math.round((items.length / n) * 1000) / 10,
      automatable: CATEGORY_META[cat].automatable, requires_human: CATEGORY_META[cat].human,
      top_details: Object.entries(details).sort((a, b) => b[1] - a[1]).slice(0, 6),
      top_sources: Object.entries(sources).sort((a, b) => b[1] - a[1]).slice(0, 5),
      examples: items.slice(0, 3).map((i) => `${i.name} [${i.source}${i.date ? ' ' + i.date : ''}]`),
    };
  });
  const flagCounts = {}; classified.forEach((x) => x.flags.forEach((f) => { flagCounts[f] = (flagCounts[f] || 0) + 1; }));
  const unclassifiable = {
    missing_coordinates: 'not determinable on incoming rows - lat/lng are always null there; coordinates are resolved at approval (requireVerifiedLocation geocoding). Would need: geocode-at-scan or a stored geocode attempt result.',
    low_confidence_extraction: 'not determinable for match_type=new - confidence_score is 0 for every new item (only computed for update/duplicate matches). Would need: per-field extraction confidence from the LLM, or a second-pass consistency score.',
  };

  if (!process.argv.includes('--json-only')) {
    console.log(`open review queue: ${n} items (new ${classified.filter((x) => x.match_type === 'new').length}, update ${classified.filter((x) => x.match_type === 'update').length}); trust gate >= ${minTrust}, window <= ${maxDate}\n`);
    console.log('PRIMARY REASON (one per item, blocker-first)');
    for (const s of summary) {
      console.log(`  ${s.category.padEnd(34)} ${String(s.count).padStart(4)}  ${String(s.pct).padStart(5)}%   automatable: ${s.automatable.split(' - ')[0]} | human: ${s.requires_human}`);
      console.log(`      details: ${s.top_details.map(([k, v]) => `${k}=${v}`).join(', ')}`);
      console.log(`      sources: ${s.top_sources.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    console.log('\nNON-BLOCKING FLAGS (an item can carry several)');
    for (const [f, v] of Object.entries(flagCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${f.padEnd(24)} ${String(v).padStart(4)}  ${Math.round((v / n) * 1000) / 10}%`);
    console.log('\nUNCLASSIFIABLE WITH CURRENT DATA');
    for (const [k, v] of Object.entries(unclassifiable)) console.log(`  ${k}: ${v}`);
  }
  const out = { generatedAt: new Date().toISOString(), total: n, byPrimary: summary, flags: flagCounts, unclassifiable, items: classified };
  const file = path.join(__dirname, `review-queue-classification-${today}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path.basename(file)}`);
})().catch((e) => { console.error(e); process.exit(1); });
