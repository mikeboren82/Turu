// הודעת-משוב משותפת, נגישה ולא-חוסמת (בקשת המשתמש: "לא לחלונות אישור") לכל האפליקציה - אותו
// דפוס "module-level store + subscribe" בדיוק כמו lib/i18n/index.js (current/listeners/
// useSyncExternalStore), לא Context/ספרייה חיצונית חדשה. מרונדרת פעם אחת (components/ToastHost.js
// ב-app/_layout.js) כך שקריאה ל-showToast מכל מסך/רכיב מציגה הודעה זהה מעליו, כולל אחרי ניווט.
import { useSyncExternalStore } from 'react';

let current = null; // { id, message, actionLabel, onAction } | null
let timer = null;
const listeners = new Set();
const notify = () => listeners.forEach((l) => l());

// duration ברירת-מחדל ארוכה יותר כשיש actionLabel (למשל "ביטול" אחרי הסתרה) - זמן אמיתי לפעול,
// לא רק לקרוא. קריאה חדשה מחליפה קריאה קודמת (לא תור/ערימה) - התנהגות snackbar רגילה, תואמת
// "הסתרת כמה פעילויות ברצף": ההסתרה עצמה תמיד נשמרת, רק ה"ביטול" האחרון נשאר זמין על המסך.
export function showToast(message, { actionLabel, onAction, duration } = {}) {
  if (timer) clearTimeout(timer);
  const id = Date.now() + Math.random();
  current = { id, message, actionLabel, onAction };
  notify();
  timer = setTimeout(() => {
    if (current?.id === id) { current = null; notify(); }
  }, duration ?? (actionLabel ? 5000 : 3200));
}

export function dismissToast() {
  if (timer) clearTimeout(timer);
  current = null;
  notify();
}

function getToast() { return current; }
function subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); }

export function useToast() {
  return useSyncExternalStore(subscribe, getToast, getToast);
}
