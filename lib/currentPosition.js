// בקשה מפורשת של המשתמש "השתמשו במיקום שלי" (components/LocationQuickPicker.js): מחזירה הצלחה
// רק אם *הבקשה הזו* קיבלה גם הרשאה וגם מיקום שמיש. הרשאה לבדה, או קואורדינטות ישנות שנשארו
// בזיכרון מבקשה קודמת, אינן הצלחה - אחרת מצב 'current' נשמר בלי נקודת-מוצא ומסך התוצאות מציג
// "עד 15 דק' ממני" בזמן שבפועל אין סינון/מיון לפי מרחק בכלל.
// LocationApi מוזרק (expo-location בפועל) כדי שהבדיקות ירוצו בלי מכשיר.
// error הוא אחד מ-'denied' | 'blocked' | 'locationFailed' - אותן הודעות בדיוק כמו "מה יש סביבי?"
// (home.nearMe.errors.*), ראו CURRENT_POSITION_ERROR_KEYS.

// אם getCurrentPositionAsync לא חוזר (GPS תקוע), הכפתור לא נשאר "מאתר..." לנצח. רק שלב האיתור -
// לא שלב בקשת ההרשאה, שבו המשתמש עשוי עדיין לקרוא את פרומפט המערכת.
export const POSITION_TIMEOUT_MS = 20000;

export const CURRENT_POSITION_ERROR_KEYS = {
  denied: 'home.nearMe.errors.denied',
  blocked: 'home.nearMe.errors.blocked',
  locationFailed: 'home.nearMe.errors.locationFailed',
};

export function usableCoords(position) {
  const lat = position?.coords?.latitude;
  const lng = position?.coords?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { latitude: lat, longitude: lng };
}

// מה הבורר עושה עם תוצאת הבקשה: הצלחה → mode 'current' + הקואורדינטות *של הבקשה הזו*. כישלון →
// המיקום הקודם בדיוק כמו שהוא (אותו אובייקט), בלי קואורדינטות, בלי nationwide.
export function applyCurrentPositionResult(location, result) {
  if (!result?.ok) return { location, coords: null };
  return { location: { ...location, mode: 'current' }, coords: result.coords };
}

export async function requestCurrentPosition(LocationApi, { timeoutMs = POSITION_TIMEOUT_MS } = {}) {
  let permission;
  try {
    permission = await LocationApi.requestForegroundPermissionsAsync();
  } catch {
    return { ok: false, error: 'denied' };
  }
  if (permission?.status !== 'granted') {
    // canAskAgain===false מפורש בלבד = חסום (כמו handleNearMePress ב-app/index.js); undefined בווב לא.
    return { ok: false, error: permission?.canAskAgain === false ? 'blocked' : 'denied' };
  }
  let timer;
  try {
    const position = await Promise.race([
      LocationApi.getCurrentPositionAsync({}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
    const coords = usableCoords(position);
    return coords ? { ok: true, coords } : { ok: false, error: 'locationFailed' };
  } catch {
    return { ok: false, error: 'locationFailed' };
  } finally {
    clearTimeout(timer);
  }
}
