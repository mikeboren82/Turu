// TuRu - "🔎 חיפוש חכם": קורא ל-Edge Function smart-search (ניתוח-שפה-טבעית בלבד, שם ה-AI
// חי) ואז ממיר את ה-Structured Intent המובנה שחוזר לאובייקט filters הרגיל של האפליקציה
// (constants/filterSchema.js DEFAULT_FILTERS) - קוד טהור, בלי AI, בלי DB - בדיוק העיקרון
// הארכיטקטוני שנדרש: "AI מפרש, לא בוחר פעילויות". lib/filterActivities.js לא משתנה כלל,
// חוץ מתמיכה חדשה במצב location.mode='address' (ראו שם).
import { supabase } from './supabase';
import { AGE_OPTIONS, HOUR_OPTIONS, DEFAULT_FILTERS } from '../constants/filterSchema';
import { childAgeToBand, childrenToDefaultAgeFilter } from './children';
import { resolveLocationIntent, deriveTextQuery, hasGeographicCue, debugSearchIntent } from './searchIntent';

// אותו דפוס בדיוק כמו IS_DEV ב-lib/i18n/index.js.
const IS_DEV = typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';

// אימות "האם היישוב הזה קיים בכלל" מול טבלת settlements (public-read, כבר בשימוש ב-
// fetchSettlementCoords). שאילתה חסומה אחת (indexed ilike, limit 1) עם cache ברמת-המודול, ורק
// כשהמנתח בכלל החזיר עיר - לא בכל הקלדה (החיפוש כולו submit-driven, וממילא כבר עושה round-trip
// ל-Edge Function, אז זו תוספת זניחה). סמנטיקת ההשוואה זהה בכוונה ל-matchesCityFilter
// (lib/filterActivities.js): substring על שם היישוב - "האם קיים יישוב כזה" נמדד באותה צורה שבה
// הפילטר עצמו יחפש אותו אחר כך.
const verifiedCityCache = new Map();

export async function verifyCityInCatalog(city) {
  const trimmed = (city || '').trim();
  if (!trimmed) return false;
  if (verifiedCityCache.has(trimmed)) return verifiedCityCache.get(trimmed);
  try {
    const { data, error } = await supabase.from('settlements').select('name_he').ilike('name_he', `%${trimmed}%`).limit(1);
    // כשל רשת/שרת: מחזירים "מאומת" בכוונה - לעולם לא מדיחים מיקום בגלל תקלת-תשתית (ההתנהגות
    // הגרועה ביותר כאן היא לשבור חיפוש-עיר תקין בגלל בעיה זמנית ברשת).
    if (error) return true;
    const verified = Array.isArray(data) && data.length > 0;
    verifiedCityCache.set(trimmed, verified);
    return verified;
  } catch {
    return true;
  }
}

// extra: { cityOverride, pendingIntent } - שני אלה יחד מדלגים על קריאת AI נוספת בסבב-הבהרה
// (המשתמש כבר קיבל needsClarification פעם אחת וסיפק עיר) - ראו supabase/functions/smart-search.
export async function parseSmartSearchQuery(query, extra = {}) {
  const { data, error } = await supabase.functions.invoke('smart-search', { body: { query, ...extra } });
  if (error) {
    // FunctionsHttpError נותן הודעה גנרית - הפרטים האמיתיים יושבים בגוף התשובה עצמו (אותו
    // דפוס בדיוק כמו extractActivityFromUrl ב-lib/submitActivity.js).
    if (error.context && typeof error.context.json === 'function') {
      try {
        const body = await error.context.json();
        if (body?.error) throw new Error(body.error);
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message !== error.message) throw parseErr;
      }
    }
    throw error;
  }
  if (data?.error) throw new Error(data.error);
  // מעשירים את ה-intent בשתי ראיות שהמנתח עצמו לא מספק, לפני שהוא מגיע ל-intentToFilters
  // (שנשאר טהור ובדיק): הטקסט הגולמי שהמשתמש הקליד, ו"האם העיר שהוחזרה קיימת בכלל בקטלוג
  // היישובים". זה הוק יחיד - כל הקוראים (מסך הבית, מסך התוצאות, סבב-ההבהרה) מקבלים את זה
  // בלי שינוי אצלם. ראו lib/searchIntent.js לנימוק המלא.
  if (data?.intent) {
    const city = data.intent.location?.city || null;
    // סבב-הבהרה (רחוב בלי עיר): העיר שחזרה היא ה-cityOverride שהמשתמש עצמו הקליד/בחר - השרת רק
    // מיזג אותה ל-pendingIntent כדי לגאוקד את הרחוב. היא לא ניחוש של המודל ולכן לא נבדקת/מודחת.
    const override = (extra.cityOverride || '').trim();
    if (override && city === override) {
      return { ...data, intent: { ...data.intent, rawQuery: query, location: { ...data.intent.location, citySource: 'user', cityVerified: true } } };
    }
    // אימות מול ה-DB נדרש *רק* כשאין רמז לשוני גאוגרפי: כשיש רמז ("פעילויות בחיפה"), ההכרעה
    // זהה בין כה וכה (המיקום נשמר), אז חוסכים את ה-round-trip לגמרי - וזה הרוב המוחלט של
    // חיפושי-המקום האמיתיים. רק טוקן עירום ועמום ("זהבה") משלם את השאילתה, והיא נשמרת ב-cache.
    const needsVerification = !!city && !hasGeographicCue(query, city);
    const cityVerified = needsVerification ? await verifyCityInCatalog(city) : !!city;
    return { ...data, intent: { ...data.intent, rawQuery: query, location: { ...data.intent.location, cityVerified } } };
  }
  return data; // { intent } או { needsClarification, intent }
}

function ageRangeToBands(age) {
  if (!age) return null;
  const bands = AGE_OPTIONS.filter((band) => band.max >= age.min && band.min <= age.max).map((band) => band.id);
  return bands.length ? bands : null;
}

function timeRangeToHour(timeRange) {
  if (!timeRange) return DEFAULT_FILTERS.hour;
  const match = HOUR_OPTIONS.find((h) => h.start === timeRange.start && h.end === timeRange.end);
  if (match) return { option: match.id, custom: null };
  return { option: null, custom: { start: timeRange.start, end: timeRange.end } };
}

function priceHintToBuckets(hint) {
  if (hint === 'free') return ['free'];
  if (hint === 'cheap') return ['u30'];
  return [];
}

function durationHintToBuckets(hint) {
  if (hint === 'short') return ['short'];
  if (hint === 'long') return ['xlong'];
  return [];
}

// הטבות הן איתות-דירוג בלבד (lib/filterActivities.js, benefitMatchScore) - הופכות לסינון קשיח
// רק אם המשתמש ביקש הטבות *במפורש* ("פעילויות עם הנחה"/"שיש לי עליהן הטבה") - לא סתם כי יש לו
// מועדון מוגדר בפרופיל. תואם ל-BENEFIT_FILTER_OPTIONS הקיים (constants/filterSchema.js).
function benefitsHintToBuckets(hint) {
  if (hint === 'any') return ['has_benefit'];
  if (hint === 'mine') return ['my_benefits'];
  return [];
}

function intentLocationToFilters(loc, fallbackLocation) {
  if (loc.coords) {
    // כתובת מגואוקדדת (רחוב+עיר שזוהו בהצלחה) - מצב 'address' חדש, ראו lib/filterActivities.js.
    const radiusKm = loc.relation === 'exact' ? 1 : 5;
    return {
      mode: 'address', city: loc.city || '', region: [], radiusKm, coords: loc.coords,
      addressLabel: [loc.street, loc.city].filter(Boolean).join(', '),
    };
  }
  if (loc.city) return { ...DEFAULT_FILTERS.location, mode: 'city', city: loc.city };
  if (loc.region) return { ...DEFAULT_FILTERS.location, mode: 'region', region: [loc.region] };
  // אין מיקום בחיפוש עצמו - נופלים לברירת המחדל השמורה של המשתמש אם יש (לא מנחשים כלום חדש).
  if (fallbackLocation?.mode) return fallbackLocation;
  return DEFAULT_FILTERS.location;
}

// גיל: מספר מפורש בטקסט תמיד מנצח (שלב 15 בבקשה); אחרת שם ילד/ה שהוזכר ונמצא בפרופיל;
// אחרת - אם יש ילדים בפרופיל ולא צוין שם/גיל - כל הילדים (אותו דפוס בדיוק כמו "למי מחפשים
// היום?" בעמוד הבית, app/index.js).
// גיל שנגזר *מהטקסט עצמו* ונפתר לפילטר אמיתי: גיל מפורש שממופה ל-band, או שם-ילד שהוזכר ונמצא
// בפרופיל עם תאריך-לידה. null אם שום דבר לא נפתר - ואז שדה המנתח (age/childNameMentioned) לא
// מסנן כלום בפועל. זו גם הפונקציה היחידה שקובעת אם הגיל "אפקטיבי" לצורך הכרעת הטקסט החופשי
// (ageResolved למטה), כך שהבדיקה והפילטר לא יכולים להיפרד זה מזה.
// band הגיל של הילד/ה שהוזכר/ה בשם - רק אם השם תואם ילד/ה אמיתי/ת בפרופיל עם תאריך-לידה.
// זה המקור היחיד ל"השם נפתר לקשר-פרסונליזציה קיים" (childResolved), וגם מה שהגיל עצמו משתמש בו.
function mentionedChildBand(intent, children) {
  if (!intent.childNameMentioned || !children?.length) return null;
  const child = children.find((c) => (c.name || '').trim() && intent.childNameMentioned.includes(c.name.trim()));
  return child ? childAgeToBand(child.birthdate) : null;
}

function textAgeBands(intent, children) {
  const explicit = ageRangeToBands(intent.age);
  if (explicit) return explicit;
  const band = mentionedChildBand(intent, children);
  return band ? [band] : null;
}

function resolveAge(intent, children) {
  const fromText = textAgeBands(intent, children);
  if (fromText) return fromText;
  if (children?.length) {
    const bands = childrenToDefaultAgeFilter(children);
    if (bands.length) return bands;
  }
  return DEFAULT_FILTERS.age;
}

// ה-Intent המובנה (מה-Edge Function) → filters רגילים, מוכנים ל-rankActivities/applyFilters
// הקיימים בלי שום שינוי בהם. context: { children, fallbackLocation, fallbackCategory } - מידע
// מהמסך (לא נטען מחדש כאן, ולא נשלח ל-AI - הכל בקוד טהור). fallbackCategory: בדיוק אותו דפוס-
// עדיפות כמו fallbackLocation - הטקסט מנצח אם הוא ציין קטגוריה במפורש, אחרת נופלים לבחירת
// ה"מה עושים?" המובנית שהמשתמש כבר עשה (כרטיס-חיפוש מאוחד, 2026-09-16) - לא מוחקים אותה בשקט.
export function intentToFilters(intent, context = {}) {
  const { children, fallbackLocation, fallbackCategory } = context;
  // פירוק-עמימות (lib/searchIntent.js): התאמה למילון-מקומות אינה כוונה גאוגרפית בפני עצמה.
  // עיר שאינה קיימת בקטלוג היישובים ושאין עליה רמז לשוני ("בזהבה"/"ליד זהבה") מודחת חזרה
  // לטקסט חופשי - filters.q הקנוני הקיים, שכבר מסונן ע"י matchesFreeText ב-applyFilters, בלי
  // מנוע-חיפוש חדש ובלי לגעת בדירוג. הטקסט הגולמי לעולם לא נאבד בדרך.
  const rawQuery = context.rawQuery ?? intent.rawQuery ?? '';
  const resolution = resolveLocationIntent({
    rawQuery, city: intent.location?.city, cityVerified: intent.location?.cityVerified, citySource: intent.location?.citySource,
  });
  const effectiveLocation = resolution.keepLocation
    ? intent.location
    : { ...intent.location, city: null, coords: null };
  // שדה שהמנתח מילא אינו בהכרח פילטר: "זהבה" חזר מהמודל כ-childNameMentioned (שם של ילדה), ובלי
  // ילד/ה כזה בפרופיל הוא לא מסנן דבר - אבל נספר כ"מבנה" וחסם את נפילת-הטקסט → כל הקטלוג (רגרסיה
  // שנמדדה בפרודקשן, v19). הגיל נחשב רק אם נפתר בפועל.
  const ageResolved = !!textAgeBands(intent, children);
  const childResolved = !!mentionedChildBand(intent, children);
  const q = deriveTextQuery({ intent, resolution, rawQuery, ageResolved, childResolved });
  const location = intentLocationToFilters(effectiveLocation, fallbackLocation);
  // תיעוד-פיתוח בלבד (סעיף Observability): איך השאילתה הזו התפרשה ולמה. רק הטקסט שהמשתמש
  // הקליד בעצמו + ההחלטה - בלי GPS, בלי מזהי-משתמש, בלי היסטוריה.
  if (IS_DEV) console.log('[searchIntent]', debugSearchIntent({ rawQuery, resolution, textQuery: q, location }));
  return {
    ...DEFAULT_FILTERS,
    q,
    // KNOWN FOLLOW-UP - EXPLICIT STRUCTURED INTENT vs INFERRED TEXT INTENT PRECEDENCE: קטגוריה שהוסקה
    // מהטקסט (עם category_evidence מאומת בשרת) עדיין גוברת כאן על בחירת WHAT מפורשת. זה צר בהרבה
    // מבעבר (קטגוריה ספקולטיבית כבר לא מגיעה לכאן בכלל), אבל עדיין לא הוכרע - אותה משפחת קונפליקט
    // כמו WHERE מפורש מול מיקום מוסק (tests/searchIntent.test.js, "mixed 10"). לא לשנות בלי החלטת מוצר.
    category: intent.category ? [intent.category] : (fallbackCategory?.length ? fallbackCategory : []),
    location,
    age: resolveAge(intent, children),
    when: { options: intent.when.option ? [intent.when.option] : [], date: intent.when.date },
    hour: timeRangeToHour(intent.timeRange),
    price: priceHintToBuckets(intent.priceHint),
    duration: durationHintToBuckets(intent.durationHint),
    placeType: intent.placeTypeHint ? [intent.placeTypeHint] : [],
    amenities: intent.amenityHints || [],
    benefits: benefitsHintToBuckets(intent.benefitsHint),
  };
}

// שער "📍 באיזה אזור לחפש?" של מסך הבית, כפי שהוא (לא שונה): אין שום מיקום בטקסט עצמו, וגם אין
// מיקום שכבר ידוע במסך (WHERE מפורש/GPS/ברירת-מחדל שמורה). הוצא לכאן רק כדי שזרימת-ההבהרה המלאה
// (טקסט → intent → שער → עיר שהמשתמש בחר → filters) תהיה בדיקה אחת (tests/searchIntent.test.js).
export function needsAreaClarification(intent, currentLocation) {
  const loc = intent?.location || {};
  const hasAnyLocation = !!(loc.city || loc.region || loc.street || loc.coords);
  return !hasAnyLocation && !currentLocation?.mode;
}

// העיר שהמשתמש הקליד בתשובה ל"באיזה אזור לחפש?" - מיקום מפורש. עובר ל-intentToFilters בערוץ
// fallbackLocation (אותו ערוץ של WHERE מפורש, ובדיוק מה שמסך התוצאות כבר עושה בהבהרה המקבילה),
// ולא מוזרק ל-intent.location.city - שם הוא היה נראה כמו ניחוש של המודל ומודח לטקסט.
export function explicitCityLocation(city) {
  return { ...DEFAULT_FILTERS.location, mode: 'city', city: (city || '').trim() };
}
