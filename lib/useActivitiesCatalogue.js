import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { fetchApprovedActivities } from './activities';
import { createCatalogueStore } from './catalogueCache';

// The one app-wide public catalogue (see lib/catalogueCache.js for the freshness policy). Home and
// Activities both read it, so whichever screen mounts first pays for the load and the other one
// (and every later visit inside the freshness window) renders from memory.
export const activitiesCatalogue = createCatalogueStore({ fetcher: fetchApprovedActivities });

// Revalidation points: screen focus (covers first mount, returning to a screen that stayed in the
// stack, and a reused /activities instance) and the app returning to the foreground. Each call is a
// no-op while the cache is fresh or a request is already running.
export function useActivitiesCatalogue() {
  const snapshot = useSyncExternalStore(
    activitiesCatalogue.subscribe, activitiesCatalogue.getSnapshot, activitiesCatalogue.getSnapshot,
  );

  useFocusEffect(useCallback(() => {
    activitiesCatalogue.ensureFresh();
  }, []));

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') activitiesCatalogue.ensureFresh();
    });
    return () => sub.remove();
  }, []);

  return { ...snapshot, retry: activitiesCatalogue.refresh };
}
