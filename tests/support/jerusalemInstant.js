// Test helper (Opening Hours Phase 3): the exact UTC instant at which Israel's civil wall clock
// reads `isoDate hhmm`. Tests that care about "it is Monday 10:00 in Jerusalem" must pin an
// INSTANT, not a device-local Date literal - `new Date('2026-06-15T10:00:00')` means 10:00 in
// whatever zone the machine running the suite happens to be in, which silently passes on an
// Israeli dev machine and silently changes meaning on CI in UTC.
//
// The offset is taken from lib/jerusalemTime.js itself (lazily, so the caller's babel ESM hook is
// already installed by the time this runs) rather than re-deriving Israel's DST rule here. That
// rule is independently verified by tests/jerusalemTime.test.js against known transition dates,
// so this helper inherits a tested source of truth instead of adding a second unverified one.
//
// Two passes: guess the offset at the naive instant, then re-evaluate at the corrected one. That
// converges everywhere except inside the one-hour gap a spring-forward skips, which is not a real
// wall-clock time and is never used as a test input.
function jerusalemInstant(isoDate, hhmm) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const { israelUtcOffsetMinutes } = require('../../lib/jerusalemTime.js');
  let epoch = wallClockAsUtc - israelUtcOffsetMinutes(wallClockAsUtc) * 60000;
  epoch = wallClockAsUtc - israelUtcOffsetMinutes(epoch) * 60000;
  return new Date(epoch);
}

module.exports = { jerusalemInstant };
