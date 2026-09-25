// Pure data/navigation logic for the public activity page (app/activity/[id].js). No React, no
// Supabase import - every IO call is injected, so direct-entry behaviour (a shared link opened cold,
// a web refresh, no prior app state) is testable with node --test (tests/activityPage.test.js).
import { DEFAULT_FILTERS } from '../constants/filterSchema';
import { buildResultsParams } from './homeSession';

// activities.id is `uuid primary key` (supabase/schema.sql). Anything else in the URL cannot match a
// row, and sending it to PostgREST fails with "invalid input syntax for type uuid" - which the page
// used to show as a generic load error instead of "not found".
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// expo-router can hand back string | string[] | undefined for a dynamic segment.
export function normalizeActivityIdParam(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = typeof value === 'string' ? value.trim() : '';
  return UUID_RE.test(id) ? id.toLowerCase() : null;
}

// Primary load: the only fetch allowed to decide what the page shows. Never throws.
//   'ok'        - activity visible to this viewer
//   'not_found' - malformed id, unknown id, or a row this viewer may not read. RLS
//                 (activities_read: status='approved' or own or admin) returns no row for
//                 pending/rejected/archived - and expired activities are archived by the daily
//                 cron (0041) - so an anonymous recipient of a stale link lands here, exactly
//                 matching the product rule that archived behaves like deleted for end users.
//   'error'     - the fetch itself failed (network/server); retryable.
export async function loadActivityPage(rawId, { fetchActivity }) {
  const id = normalizeActivityIdParam(rawId);
  if (!id) return { status: 'not_found', id: null, activity: null };
  try {
    const activity = await fetchActivity(id);
    return activity ? { status: 'ok', id, activity } : { status: 'not_found', id, activity: null };
  } catch (error) {
    return { status: 'error', id, activity: null, error };
  }
}

async function settle(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

// Secondary load: session, personal flags/note, admin role, community notes. Each piece fails on its
// own and falls back to the anonymous/empty value - none of it can turn an activity that loaded into
// an error screen (it used to share one try/catch with the primary fetch). Never throws.
export async function loadActivityExtras(id, deps) {
  const { getSessionUserId, fetchFlags, fetchPersonalNote, fetchProfile, fetchCommunityNotes } = deps;
  const userId = await settle(getSessionUserId, null);
  const [flags, note, profile, communityNotes] = await Promise.all([
    userId ? settle(() => fetchFlags(userId, id), null) : null,
    userId ? settle(() => fetchPersonalNote(userId, id), '') : '',
    userId ? settle(() => fetchProfile(userId), null) : null,
    settle(() => fetchCommunityNotes(id), []),
  ]);
  return { userId, flags, note: note || '', profile, communityNotes: communityNotes || [] };
}

// Only approved rows are readable by anonymous recipients, so sharing anything else (an admin or the
// creator looking at a pending/archived row) would hand out a link that opens "not available".
// status is absent on rows not loaded through the detail query - treat that as unknown, not private.
export function isPubliclyShareable(activity) {
  return !!activity && (activity.status == null || activity.status === 'approved');
}

// "Discover more nearby" from an activity page: same canonical navigation payload as every Home
// entry point (buildResultsParams). City first - city mode gets Smart Radius Expansion around the
// settlement, i.e. "this area" - then region, else no location (results page Discovery Mode). No
// category: the point is to widen beyond this one activity. Only the activity's public place fields
// go in; no device coordinates, no personal filters.
export function buildDiscoveryFiltersForActivity(activity) {
  const city = (activity?.city || '').trim();
  if (city) return { ...DEFAULT_FILTERS, location: { ...DEFAULT_FILTERS.location, mode: 'city', city } };
  if (activity?.region) return { ...DEFAULT_FILTERS, location: { ...DEFAULT_FILTERS.location, mode: 'region', region: [activity.region] } };
  return { ...DEFAULT_FILTERS };
}

export function buildDiscoveryParamsForActivity(activity) {
  return buildResultsParams({ filters: buildDiscoveryFiltersForActivity(activity), coords: null, childAges: [] });
}
