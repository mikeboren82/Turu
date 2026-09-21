const test = require('node:test');
const assert = require('node:assert/strict');
const { computeEventFingerprint, computeEventFingerprintProbes } = require('../eventFingerprint');

test('fingerprint mirrors the Deno implementation (same cases as dedupe.test.ts)', () => {
  const a = computeEventFingerprint({ name: 'שעת סיפור', city: 'תל אביב-יפו', scheduleType: 'recurring', recurringDays: ['שלישי', 'ראשון'], startTime: '10:30:00' });
  const b = computeEventFingerprint({ name: 'שעת סיפור', city: 'תל אביב יפו', scheduleType: 'recurring', recurringDays: ['ראשון', 'שלישי'], startTime: '10:30' });
  assert.equal(a, b);
  assert.equal(a, 'שעת סיפור|c:תל אביב יפו|ראשון,שלישי|10:30');
  assert.equal(computeEventFingerprint({ name: 'גן שעשועים', city: 'חולון', scheduleType: 'fixed_hours' }), null);
  assert.equal(computeEventFingerprint({ name: 'הצגה', venueId: 'v1', scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '17:00' }), 'הצגה|v:v1|2026-09-27|17:00');
});

// --- computeEventFingerprintProbes (2026-09-21, "Stabilize Event Fingerprint Matching") - Node twin
// of the same cases in supabase/functions/_shared/dedupe.test.ts. Keep in lockstep; see that file's
// header comment above these tests for the full rationale (the Beit Ariela city->venue duplicate
// pattern). Lookup-only widening - storage (computeEventFingerprint, tested above) is untouched.

test('dual-probe: venue known + city known -> [canonical venue-form, city-form an unresolved-venue ingestion would have stored]', () => {
  const input = { name: 'הקוסם מארץ עוץ', venueId: 'venue-renanim', city: 'רעננה', scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '17:00' };
  const probes = computeEventFingerprintProbes(input);
  assert.deepEqual(probes, [
    computeEventFingerprint(input),
    computeEventFingerprint({ ...input, venueId: null }),
  ]);
  assert.equal(probes[0], 'הקוסם מארץ עוץ|v:venue-renanim|2026-09-27|17:00');
  assert.equal(probes[1], 'הקוסם מארץ עוץ|c:רעננה|2026-09-27|17:00');
});

test('dual-probe: no venue -> a single probe (the canonical IS already the city-form)', () => {
  const probes = computeEventFingerprintProbes({ name: 'שעת סיפור', city: 'חולון', scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '10:00' });
  assert.equal(probes.length, 1);
  assert.equal(probes[0], computeEventFingerprint({ name: 'שעת סיפור', city: 'חולון', scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '10:00' }));
});

test('dual-probe: venue known but NO city -> a single probe (never a degenerate empty-city probe)', () => {
  const probes = computeEventFingerprintProbes({ name: 'שעת סיפור', venueId: 'venue-x', city: null, scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '10:00' });
  assert.equal(probes.length, 1);
  assert.ok(probes[0].includes('v:venue-x'));
});

test('dual-probe: no name/no date -> empty, matching computeEventFingerprint\'s own null cases', () => {
  assert.deepEqual(computeEventFingerprintProbes({ name: '', venueId: 'v1', city: 'חולון', scheduleType: 'one_time', oneTimeDate: '2026-09-27' }), []);
  assert.deepEqual(computeEventFingerprintProbes({ name: 'אירוע', venueId: 'v1', city: 'חולון', scheduleType: 'one_time', oneTimeDate: null }), []);
});

test('POSITIVE REGRESSION: scan 1 stores city-form (venue unresolved), scan 2 resolves a venue - the probe set must contain scan 1\'s exact stored fingerprint', () => {
  const scan1Fingerprint = computeEventFingerprint({ name: 'גלגולו של זחל - שעת סיפור', city: 'תל אביב יפו', scheduleType: 'one_time', oneTimeDate: '2026-10-29', startTime: '17:00' });
  const scan2Probes = computeEventFingerprintProbes({ name: 'גלגולו של זחל - שעת סיפור', venueId: 'af47029d-venue', city: 'תל אביב יפו', scheduleType: 'one_time', oneTimeDate: '2026-10-29', startTime: '17:00' });
  assert.ok(scan2Probes.includes(scan1Fingerprint), 'scan 2\'s probe set must include scan 1\'s stored city-form fingerprint');
  assert.equal(scan2Probes.length, 2);
});

test('NEGATIVE: same title, same venue, DIFFERENT DATE -> no probe overlap', () => {
  const a = computeEventFingerprintProbes({ name: 'הקוסם מארץ עוץ', venueId: 'v1', city: 'רעננה', scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '17:00' });
  const b = computeEventFingerprintProbes({ name: 'הקוסם מארץ עוץ', venueId: 'v1', city: 'רעננה', scheduleType: 'one_time', oneTimeDate: '2026-10-05', startTime: '17:00' });
  assert.deepEqual(a.filter((fp) => b.includes(fp)), []);
});

test('NEGATIVE: same title, same venue, same date, DIFFERENT TIME -> no probe overlap', () => {
  const a = computeEventFingerprintProbes({ name: 'הקוסם מארץ עוץ', venueId: 'v1', city: 'רעננה', scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '17:00' });
  const b = computeEventFingerprintProbes({ name: 'הקוסם מארץ עוץ', venueId: 'v1', city: 'רעננה', scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '18:00' });
  assert.deepEqual(a.filter((fp) => b.includes(fp)), []);
});

test('NEGATIVE: same title/city/date/time but the EXISTING row already has its OWN resolved (different) venue -> no match (a resolved row is never stored under the city-form)', () => {
  const existingStoredFingerprint = computeEventFingerprint({ name: 'הקוסם מארץ עוץ', venueId: 'venue-b', city: 'רעננה', scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '17:00' });
  const candidateProbes = computeEventFingerprintProbes({ name: 'הקוסם מארץ עוץ', venueId: 'venue-a', city: 'רעננה', scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '17:00' });
  assert.ok(!candidateProbes.includes(existingStoredFingerprint));
});

test('NEGATIVE: similar-but-not-identical titles at the same venue/date/time -> no probe overlap (exact title still required)', () => {
  const a = computeEventFingerprintProbes({ name: 'הקוסם מארץ עוץ', venueId: 'v1', city: 'רעננה', scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '17:00' });
  const b = computeEventFingerprintProbes({ name: 'הקוסם מארץ עוץ - מופע מיוחד', venueId: 'v1', city: 'רעננה', scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '17:00' });
  assert.deepEqual(a.filter((fp) => b.includes(fp)), []);
});

test('REVERSE DIRECTION (reported, not implemented): a venue-less candidate produces only the city-form probe, never a guessed venue-form', () => {
  const probes = computeEventFingerprintProbes({ name: 'הקוסם מארץ עוץ', venueId: null, city: 'רעננה', scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '17:00' });
  assert.equal(probes.length, 1);
  assert.ok(probes[0].startsWith('הקוסם מארץ עוץ|c:'));
});
