const test = require('node:test');
const assert = require('node:assert/strict');
const { computeEventFingerprint } = require('../eventFingerprint');

test('fingerprint mirrors the Deno implementation (same cases as dedupe.test.ts)', () => {
  const a = computeEventFingerprint({ name: 'שעת סיפור', city: 'תל אביב-יפו', scheduleType: 'recurring', recurringDays: ['שלישי', 'ראשון'], startTime: '10:30:00' });
  const b = computeEventFingerprint({ name: 'שעת סיפור', city: 'תל אביב יפו', scheduleType: 'recurring', recurringDays: ['ראשון', 'שלישי'], startTime: '10:30' });
  assert.equal(a, b);
  assert.equal(a, 'שעת סיפור|c:תל אביב יפו|ראשון,שלישי|10:30');
  assert.equal(computeEventFingerprint({ name: 'גן שעשועים', city: 'חולון', scheduleType: 'fixed_hours' }), null);
  assert.equal(computeEventFingerprint({ name: 'הצגה', venueId: 'v1', scheduleType: 'one_time', oneTimeDate: '2026-09-27', startTime: '17:00' }), 'הצגה|v:v1|2026-09-27|17:00');
});
