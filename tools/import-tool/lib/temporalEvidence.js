// TuRu - ENTITY-TYPE-AWARE temporal evidence (Node twin of supabase/functions/_shared/extraction.ts
// missingTemporalEvidence / repairEntityTypeFromSchedule). A dated or recurring EVENT must carry the
// evidence its type needs before any automated path may publish it; an evergreen place never needs one
// and hours are never fabricated. Returns the missing-evidence code or null.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function recurringDays(c) { return Array.isArray(c.recurring_days) ? c.recurring_days.filter((d) => typeof d === 'string' && d.trim()) : []; }

function missingTemporalEvidence(c) {
  if (!c) return null;
  const occ = Array.isArray(c.occurrences) ? c.occurrences.filter((o) => o && typeof o.date === 'string' && ISO_DATE.test(o.date)) : [];
  const hasDate = (typeof c.one_time_date === 'string' && ISO_DATE.test(c.one_time_date)) || occ.length > 0;
  if (c.schedule_type === 'one_time') return hasDate ? null : 'one_time_without_date';
  if (c.schedule_type === 'recurring') return recurringDays(c).length ? null : 'recurring_without_days';
  if (c.entity_type === 'אירוע') return 'event_without_one_time_schedule';
  if ((c.entity_type === 'אירוע_קבוע' || c.entity_type === 'פעילות') && !c.schedule_type) return 'recurring_event_without_schedule';
  return null;
}

// the extraction prompt's own definition: a repeating schedule is never a plain "אירוע"
function repairEntityTypeFromSchedule(c) {
  if (c && c.entity_type === 'אירוע' && c.schedule_type === 'recurring' && recurringDays(c).length) return 'אירוע_קבוע';
  return c ? c.entity_type ?? null : null;
}

// validation-issue label the queue shows for each code ('תאריך' already exists for one_time)
const ISSUE_LABEL = { one_time_without_date: 'תאריך', recurring_without_days: 'ימי פעילות', event_without_one_time_schedule: 'תאריך', recurring_event_without_schedule: 'ימי פעילות' };

module.exports = { missingTemporalEvidence, repairEntityTypeFromSchedule, ISSUE_LABEL };
