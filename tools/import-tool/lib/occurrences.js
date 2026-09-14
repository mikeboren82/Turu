// TuRu - OCCURRENCE persistence planning for THE MONSTER (Node side: server.js applyIncomingUpdate,
// merge-occurrence-duplicates.js). Pure: no DB.
//
// An activity's dated performances are activity_schedules rows (schedule_type 'one_time', each with its
// own one_time_date / start_time / end_time / external_id / booking_url; unique on activity+date+time).
// Rules (binding, 2026-09-14):
//   - insert only occurrences that are MISSING and not in the past (a queued diff may be days old);
//   - never rewrite "the" date row; never delete occurrence rows;
//   - recurring -> one_time conversion: the caller inserts first, VERIFIES the expected rows exist, and only
//     then deletes the recurring rows (planScheduleChange only says which rows those are);
//   - event_fingerprint is NOT recomputed for occurrence changes (it is the legacy first-occurrence key;
//     event_key is the stable EVENT identity - lib/eventIdentity.js).
const timeKey = (t) => (t ? String(t).slice(0, 5) : '');
const occKey = (o) => `${o.date || o.one_time_date}|${timeKey(o.start_time)}`;

function normalizeOccurrence(o) {
  const date = o.date || o.one_time_date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
  return {
    date: String(date), start_time: o.start_time ? timeKey(o.start_time) : null, end_time: o.end_time ? timeKey(o.end_time) : null,
    external_id: o.external_id || null, booking_url: o.booking_url || null,
  };
}

// existingRows: activity_schedules rows of the activity; occurrences: candidate occurrences (or a single
// {date,start_time,end_time}); returns { insert: rows to insert, deleteRecurring: ids to delete AFTER
// verification, skipped: {past, present} }
function planScheduleChange(existingRows, occurrences, today, { convertRecurring = false } = {}) {
  const rows = Array.isArray(existingRows) ? existingRows : [];
  const have = new Set(rows.filter((r) => r.schedule_type === 'one_time' && r.one_time_date).map(occKey));
  const insert = []; const skipped = { past: 0, present: 0 };
  const seen = new Set();
  for (const raw of Array.isArray(occurrences) ? occurrences : []) {
    const o = raw && normalizeOccurrence(raw); if (!o) continue;
    const k = occKey(o); if (seen.has(k)) continue; seen.add(k);
    if (today && o.date < today) { skipped.past++; continue; }
    if (have.has(k)) { skipped.present++; continue; }
    insert.push({ schedule_type: 'one_time', one_time_date: o.date, start_time: o.start_time, end_time: o.end_time, external_id: o.external_id, booking_url: o.booking_url });
  }
  const deleteRecurring = convertRecurring ? rows.filter((r) => r.schedule_type === 'recurring').map((r) => r.id).filter(Boolean) : [];
  return { insert, deleteRecurring, skipped };
}

// after inserting: does the activity now hold every expected (date,time)? (crash / partial insert guard)
function occurrencesPersisted(rowsAfter, expected) {
  const have = new Set((rowsAfter || []).filter((r) => r.schedule_type === 'one_time' && r.one_time_date).map(occKey));
  return (expected || []).every((o) => have.has(occKey(o)));
}

// earliest upcoming occurrence (display / legacy scalar fields)
function nextOccurrence(rows, today) {
  const occ = (rows || []).filter((r) => r.schedule_type === 'one_time' && r.one_time_date).map(normalizeOccurrence).filter(Boolean)
    .sort((a, b) => (a.date + (a.start_time || '')).localeCompare(b.date + (b.start_time || '')));
  return occ.find((o) => !today || o.date >= today) || occ[0] || null;
}

module.exports = { planScheduleChange, occurrencesPersisted, nextOccurrence, normalizeOccurrence, occKey };
