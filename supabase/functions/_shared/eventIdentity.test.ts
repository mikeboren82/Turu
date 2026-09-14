// EVENT identity vs OCCURRENCE identity (2026-09-14): event_key is stable across performances; the
// legacy event_fingerprint stays an occurrence-level key; a shared listing page is never identity.
import { assertEquals, assert } from 'jsr:@std/assert@1';
import { computeEventKey, findEventMatch, isListingShapedUrl, isGenericTitle, eventKeyRank } from './eventIdentity.ts';
import { computeEventFingerprint, computeFieldDiff, computeConfidence, getConfidenceThresholds, type ExistingActivity } from './matching.ts';

const S = 'src-raanana';
const today = '2026-09-14';
const name = 'גולי והגיטרה ששרה לגיל 2-4';
const base: ExistingActivity = {
  id: 'e1', name, name_source: null, description: null, category: 'הצגה', min_age: 2, max_age: 4, price_type: 'fixed', price_amount: 45,
  booking_requirement: null, source_url: 'https://tickets.raanana.muni.il/ילדים_ומשפחה', location_name: 'המשכן למוסיקה', city: 'רעננה', lat: 32.18, lng: 34.87,
  venue_id: 'v-mishkan', event_fingerprint: computeEventFingerprint({ name, venueId: 'v-mishkan', scheduleType: 'one_time', oneTimeDate: '2026-10-12', startTime: '16:30' }),
  schedule_type: 'one_time', one_time_date: '2026-10-12', start_time: '16:30', end_time: null, recurring_days: [], has_image: false,
  occurrences: [{ date: '2026-10-12', start_time: '16:30', end_time: null }, { date: '2026-10-12', start_time: '17:30', end_time: null }, { date: '2026-12-21', start_time: '16:30', end_time: null }],
  event_key: 'tvs:גולי והגיטרה ששרה לגיל 24|v:v-mishkan|s:src-raanana', event_key_kind: 'title_venue_source', source_id: S, official_url: null,
};

Deno.test('A: one event with 3 dates => ONE event key (dates are not part of it); fingerprint stays the first occurrence', () => {
  const k1 = computeEventKey({ sourceId: S, title: name, venueId: 'v-mishkan' })!;
  const k2 = computeEventKey({ sourceId: S, title: name, venueId: 'v-mishkan' })!;
  assertEquals(k1.key, k2.key);
  assertEquals(k1.kind, 'title_venue_source');
  assertEquals(base.event_fingerprint, `גולי והגיטרה ששרה לגיל 24|v:v-mishkan|2026-10-12|16:30`);
});

Deno.test('B: the earliest occurrence expires => the event still matches by key; key and fingerprint unchanged', () => {
  const later = '2026-10-13'; // 12.10 has passed, 21.12 has not
  const candidate = { name, venue_id: 'v-mishkan', event_key: base.event_key, event_key_kind: 'title_venue_source', occurrences: [{ date: '2026-12-21', start_time: '16:30' }], one_time_date: '2026-12-21', start_time: '16:30' };
  const m = findEventMatch(candidate, [base], S, later);
  assert(m && m.reason === 'event_key');
  assertEquals(m!.activity.event_key, base.event_key);
  assertEquals(m!.activity.event_fingerprint, base.event_fingerprint);
  // but an activity whose dates are ALL past is never matched (a new season is a new event)
  assertEquals(findEventMatch(candidate, [base], S, '2027-01-01'), null);
});

Deno.test('C: a rescan with a new performance => same event, diff lists only the new occurrence (never a date rewrite)', () => {
  const candidate = { name, city: 'רעננה', venue_id: 'v-mishkan', pageUrl: base.source_url, event_key: base.event_key, event_key_kind: 'title_venue_source', schedule_type: 'one_time', one_time_date: '2026-10-12', start_time: '16:30',
    occurrences: [{ date: '2026-10-12', start_time: '16:30', end_time: null }, { date: '2026-10-12', start_time: '17:30', end_time: null }, { date: '2026-12-21', start_time: '16:30', end_time: null }, { date: '2027-02-01', start_time: '16:30', end_time: null }], image_urls: [] };
  const m = findEventMatch(candidate, [base], S, today);
  assert(m);
  const diff = computeFieldDiff(candidate, base);
  assertEquals(Object.keys(diff), ['occurrences']);
  assertEquals(diff.occurrences.after, ['2027-02-01 16:30']);
  assertEquals('one_time_date' in diff, false);
  // and with nothing new it is a plain duplicate (empty diff)
  assertEquals(Object.keys(computeFieldDiff({ ...candidate, occurrences: candidate.occurrences.slice(0, 3) }, base)), []);
});

Deno.test('D: a similar title at the same venue is a DIFFERENT event (ages / another show)', () => {
  const k58 = computeEventKey({ sourceId: S, title: 'גולי והגיטרה ששרה לגיל 5-8', venueId: 'v-mishkan' })!;
  assert(k58.key !== base.event_key);
  const c58 = { name: 'גולי והגיטרה ששרה לגיל 5-8', venue_id: 'v-mishkan', event_key: k58.key, event_key_kind: k58.kind, detail_url: 'https://tickets.raanana.muni.il/גולי_5-8', occurrences: [{ date: '2026-10-12', start_time: '16:30' }, { date: '2026-12-21', start_time: '16:30' }], start_time: '16:30' };
  assertEquals(findEventMatch(c58, [base], S, today), null);
  const other = { name: 'האריה שאהב תות - תיאטרון סיפור לגילאי 2-4', venue_id: 'v-mishkan', detail_url: 'https://tickets.raanana.muni.il/האריה', occurrences: [{ date: '2026-10-12', start_time: '16:30' }, { date: '2026-10-26', start_time: '16:30' }], start_time: '16:30' };
  assertEquals(findEventMatch(other, [base], S, today), null);
});

Deno.test('E: a shared listing page in provenance is never identity; generic titles never get a title key or an E2 match', () => {
  const thresholds = getConfidenceThresholds({});
  const otherFromSamePage = { name: 'סדנת גיבורי על - איור לילדים', city: 'רעננה', venue_id: null, pageUrl: base.source_url, one_time_date: '2026-10-05', start_time: '10:00', recurring_days: [] };
  assertEquals(findEventMatch(otherFromSamePage, [base], S, today), null);
  assert(computeConfidence(otherFromSamePage, { ...base, venue_id: null }, thresholds).score < thresholds.needsReview);
  assertEquals(computeEventKey({ sourceId: S, title: 'שעת סיפור', venueId: 'v-lib' }), null);
  assertEquals(isGenericTitle('הצגה לגיל הרך'), true);
  const storyHour: ExistingActivity = { ...base, id: 'e2', name: 'שעת סיפור', venue_id: 'v-lib', event_key: null, event_key_kind: null, occurrences: [{ date: '2026-10-05', start_time: '17:00', end_time: null }], start_time: '17:00', one_time_date: '2026-10-05' };
  const sameHour = { name: 'שעת סיפור', venue_id: 'v-lib', detail_url: 'https://lib.il/e/2', occurrences: [{ date: '2026-10-12', start_time: '17:00' }, { date: '2026-10-19', start_time: '17:00' }], start_time: '17:00' };
  assertEquals(findEventMatch(sameHour, [storyHour], S, today), null);
});

Deno.test('E2 fallback (pre-traversal rows): exact title + same venue + same source + same time + >=2 explicit performances; recurring misread gets a guarded schedule_type diff', () => {
  const legacy: ExistingActivity = { ...base, event_key: null, event_key_kind: null, entity_type: 'אירוע_קבוע', event_fingerprint: 'גולי והגיטרה ששרה לגיל 24|v:v-mishkan|שני|16:30', schedule_type: 'recurring', one_time_date: null, occurrences: [], recurring_days: ['שני'], start_time: '16:30' };
  const candidate = { name, city: 'רעננה', venue_id: 'v-mishkan', pageUrl: base.source_url, detail_url: 'https://tickets.raanana.muni.il/גולי_והגיטרה_ששרה_לגיל_2-4', detail_verified: true, schedule_type: 'one_time', entity_type: 'אירוע', one_time_date: '2026-10-12', start_time: '16:30',
    occurrences: [{ date: '2026-10-12', start_time: '16:30', end_time: null }, { date: '2026-10-12', start_time: '17:30', end_time: null }], image_urls: [] };
  const m = findEventMatch(candidate, [legacy], S, today);
  assert(m && m.reason === 'occurrence_series');
  const diff = computeFieldDiff(candidate, legacy);
  assertEquals(diff.schedule_type?.after, 'one_time');
  assertEquals(diff.entity_type?.after, 'אירוע');
  assertEquals(Object.keys(computeFieldDiff(candidate, legacy, { enrichmentOnly: true })).sort(), ['entity_type', 'occurrences', 'schedule_type']);
  assertEquals((diff.occurrences.after as string[]).length, 2);
  // a real weekly class (5 weekday rows) is never flipped by one performance page
  const weekly = { ...legacy, recurring_days: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי'] };
  assertEquals('schedule_type' in computeFieldDiff(candidate, weekly), false);
  // a different source, or a different time, or no detail page => no E2 match
  assertEquals(findEventMatch(candidate, [legacy], 'src-other', today), null);
  assertEquals(findEventMatch({ ...candidate, start_time: '18:00', occurrences: [{ date: '2026-10-12', start_time: '18:00' }, { date: '2026-12-21', start_time: '18:00' }] }, [legacy], S, today), null);
  assertEquals(findEventMatch({ ...candidate, detail_url: null }, [legacy], S, today), null);
});

Deno.test('URL-kind keys: only verified, event-shaped detail URLs; the detail URL with a matching kind-1 key on the other side wins', () => {
  assertEquals(computeEventKey({ sourceId: S, title: name, venueId: 'v-mishkan', detailUrl: 'https://tickets.raanana.muni.il/ילדים_ומשפחה?page=2', detailVerified: true })!.kind, 'title_venue_source');
  const urlKey = computeEventKey({ sourceId: S, title: name, venueId: null, detailUrl: 'https://tickets.raanana.muni.il/גולי_והגיטרה_ששרה_לגיל_2-4/?utm_source=fb', detailVerified: true })!;
  assertEquals(urlKey, { key: 'url:https://tickets.raanana.muni.il/גולי_והגיטרה_ששרה_לגיל_2-4', kind: 'detail_url' });
  assert(eventKeyRank('detail_url') > eventKeyRank('title_venue_source'));
  assertEquals(isListingShapedUrl('https://tickets.raanana.muni.il/אזרחים_ותיקים_page_83'), true);
  // compatibility: a url key match still needs a compatible title or venue and the same source
  const withUrl: ExistingActivity = { ...base, event_key: urlKey.key, event_key_kind: 'detail_url' };
  assert(findEventMatch({ name, event_key: urlKey.key, event_key_kind: 'detail_url', venue_id: null }, [withUrl], S, today));
  assertEquals(findEventMatch({ name: 'משהו אחר לגמרי', event_key: urlKey.key, event_key_kind: 'detail_url', venue_id: null }, [withUrl], S, today), null);
  assertEquals(findEventMatch({ name, event_key: urlKey.key, event_key_kind: 'detail_url', venue_id: null }, [withUrl], 'src-other', today), null);
});

Deno.test('address replacement: only a derived address may be replaced, and only by the official detail page', () => {
  const derived: ExistingActivity = { ...base, address: 'חפץ חיים', address_source: 'cleaner:reverse_geocode' };
  const fromDetail = { name, city: 'רעננה', venue_id: 'v-mishkan', pageUrl: 'x', address: 'הפלמ"ח 2 א', address_source: 'monster:detail', one_time_date: '2026-10-12', start_time: '16:30', occurrences: base.occurrences, image_urls: [] };
  assertEquals(computeFieldDiff(fromDetail, derived).address?.after, 'הפלמ"ח 2 א');
  assertEquals('address' in computeFieldDiff({ ...fromDetail, address_source: undefined }, derived), false);
  assertEquals('address' in computeFieldDiff(fromDetail, { ...derived, address_source: 'monster:venue' }), false);
});
