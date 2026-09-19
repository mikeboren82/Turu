// "🕐 חיפושים אחרונים" (Home Refactor Phase 2B) - הועבר מ-app/index.js: אחריות-חיפושים-אחרונים
// עצמאית ומלאה (state + טעינה + persistence + dedupe/remove/clear), בלי לגעת בשום דבר אחר
// ב-Home (חיפוש חופשי/searchMode/filters/מיקום/בחירה מהירה/מה קרוב/ניווט - כל אלה נשארים ב-Home
// עצמו, ראו קריאות ב-app/index.js). נשמר מקומית במכשיר בלבד (AsyncStorage - שקול ל-localStorage,
// אבל עובד גם ב-native, לא רק web), לא ב-DB ולא קשור לחשבון המשתמש (ראו גם GUEST_HOME_LOCATION_KEY
// ב-app/index.js - אותו דפוס persistence בדיוק, אבל key/אחריות נפרדים לגמרי).
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const RECENT_SEARCHES_KEY = 'turu_recent_searches';
const RECENT_SEARCHES_MAX = 5;

// טרנספורמציה טהורה בלבד (מיוצאת בנפרד כדי שאפשר לבדוק אותה כפונקציה טהורה, ראו
// tests/useRecentSearches.test.js, בלי תשתית-רינדור של React): חיפוש חדש קופץ לראש הרשימה,
// כפילות קודמת של אותו טקסט (השוואת מחרוזת מדויקת) מוסרת כדי שהוא לא יופיע פעמיים, והרשימה
// נחתכת ל-RECENT_SEARCHES_MAX (5) האחרונים.
export function addRecentSearch(prev, text) {
  return [text, ...prev.filter((q) => q !== text)].slice(0, RECENT_SEARCHES_MAX);
}

export function useRecentSearches() {
  const [recentSearches, setRecentSearches] = useState([]);

  useEffect(() => {
    AsyncStorage.getItem(RECENT_SEARCHES_KEY).then((raw) => {
      if (!raw) return;
      try { setRecentSearches(JSON.parse(raw)); } catch { /* ערך פגום - מתעלמים, לא קורסים */ }
    });
  }, []);

  const recordRecentSearch = (text) => {
    setRecentSearches((prev) => {
      const next = addRecentSearch(prev, text);
      AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
      return next;
    });
  };

  const clearRecentSearches = () => {
    setRecentSearches([]);
    AsyncStorage.removeItem(RECENT_SEARCHES_KEY);
  };

  const removeRecentSearch = (text) => {
    setRecentSearches((prev) => {
      const next = prev.filter((q) => q !== text);
      AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
      return next;
    });
  };

  return {
    recentSearches, recordRecentSearch, clearRecentSearches, removeRecentSearch,
  };
}
