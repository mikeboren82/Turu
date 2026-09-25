// Client catalogue cache (2026-09-25, "Activities Loading + Client Cache Performance").
//
// Before this, Home (app/index.js) and Activities (app/activities.js) each ran their own
// fetchApprovedActivities() in a mount effect: 6 paged requests (~5,500 rows) + public_profiles per
// mount, with nothing shared. Measured on localhost: every Home->Activities visit re-downloaded the
// whole catalogue even though Home had just loaded the identical payload, and bottom-nav "Home"
// remounts Home, so one Home->Activities->Home->Activities round trip cost 12 catalogue page
// requests, the two screens' fetches overlapping (up to 10 in flight at once).
//
// This is one module-level, in-memory store shared by every screen. It holds ONLY the public
// approved catalogue (exactly what fetchApprovedActivities returns - RLS-public rows plus public
// recommender nicknames). Never user state: favourites/visited/hidden/notes/preferences stay
// per-screen and are fetched per session as before. Nothing is persisted; a cold start always
// begins empty.
//
// Freshness policy (deliberately small and bounded):
//   age < FRESH_MS                -> served from memory, no request.
//   FRESH_MS <= age < MAX_AGE_MS  -> served from memory immediately AND revalidated in the background
//                                    (stale-while-revalidate); success swaps the whole array in.
//   age >= MAX_AGE_MS             -> no longer valid: dropped, next consumer sees LOADING and a
//                                    blocking load (as on a cold start). Data is never kept forever.
// Revalidation is only ever triggered by a consumer asking (screen mount/focus, app foreground,
// explicit retry) - no timers. One request chain at a time: concurrent ensureFresh calls share
// the in-flight promise. A failed refresh keeps the valid rows (never replaced with 0) and records
// refreshError; automatic re-attempts back off for RETRY_BACKOFF_MS, an explicit retry does not.
//
// Pure (no React, no supabase import) so node --test can drive it with a fake fetcher and clock;
// lib/useActivitiesCatalogue.js binds the app-wide singleton to fetchApprovedActivities.

export const FRESH_MS = 5 * 60 * 1000;
export const MAX_AGE_MS = 60 * 60 * 1000;
export const RETRY_BACKOFF_MS = 30 * 1000;

const EMPTY = Object.freeze([]);

// status: 'loading' (no usable rows yet, or a request is on its way), 'ready' (rows are usable -
// possibly being refreshed in the background), 'error' (no usable rows AND the last attempt failed).
export function createCatalogueStore({
  fetcher, now = () => Date.now(), freshMs = FRESH_MS, maxAgeMs = MAX_AGE_MS, retryBackoffMs = RETRY_BACKOFF_MS,
}) {
  let rows = null;
  let fetchedAt = 0;
  let inflight = null;
  let lastError = null;
  let lastFailureAt = 0;
  let refreshError = null;
  const listeners = new Set();
  let snapshot = buildSnapshot();

  function buildSnapshot() {
    let status = 'loading';
    if (rows) status = 'ready';
    else if (lastError && !inflight) status = 'error';
    return {
      status,
      activities: rows || EMPTY,
      fetchedAt: rows ? fetchedAt : null,
      error: rows ? null : lastError,
      refreshError: rows ? refreshError : null,
      refreshing: !!(rows && inflight),
    };
  }

  function emit() {
    snapshot = buildSnapshot();
    for (const l of listeners) l();
  }

  function startFetch() {
    const run = (async () => {
      try {
        const data = await fetcher();
        rows = Array.isArray(data) ? data : [];
        fetchedAt = now();
        lastError = null;
        refreshError = null;
      } catch (err) {
        lastFailureAt = now();
        if (rows) refreshError = err || new Error('refresh failed');
        else lastError = err || new Error('load failed');
      } finally {
        inflight = null;
        emit();
      }
    })();
    inflight = run;
    emit();
    return run;
  }

  // Returns the in-flight promise when a request is (now) running, otherwise null.
  function ensureFresh({ force = false } = {}) {
    if (inflight) return inflight;
    const t = now();
    if (rows && t - fetchedAt >= maxAgeMs) {
      rows = null;
      refreshError = null;
      emit();
    }
    if (!force) {
      if (rows && t - fetchedAt < freshMs) return null;
      if (lastFailureAt && t - lastFailureAt < retryBackoffMs) return null;
    }
    return startFetch();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensureFresh,
    // explicit user retry / manual refresh - bypasses freshness and failure backoff.
    refresh: () => ensureFresh({ force: true }),
  };
}

// Which of the four result states a results screen is in. The count, the empty state and the
// "nothing matched" copy may only render in the two LOADED_* states - while the catalogue (or the
// per-user filtering inputs it is ranked with) is still arriving, the screen is LOADING, never
// "0 activities".
export const RESULTS_VIEW = Object.freeze({
  LOADING: 'LOADING',
  LOADED_WITH_RESULTS: 'LOADED_WITH_RESULTS',
  LOADED_EMPTY: 'LOADED_EMPTY',
  LOAD_FAILED: 'LOAD_FAILED',
});

export function resolveResultsView({ catalogueStatus, userStateReady, loadError, resultCount }) {
  if (catalogueStatus === 'error' || loadError) return RESULTS_VIEW.LOAD_FAILED;
  if (catalogueStatus !== 'ready' || !userStateReady) return RESULTS_VIEW.LOADING;
  return resultCount > 0 ? RESULTS_VIEW.LOADED_WITH_RESULTS : RESULTS_VIEW.LOADED_EMPTY;
}
