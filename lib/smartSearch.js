// TuRu - "🔎 חיפוש חכם": קורא ל-Edge Function smart-search (ניתוח-שפה-טבעית בלבד, שם ה-AI
// חי) ואז ממיר את ה-Structured Intent המובנה שחוזר לאובייקט filters הרגיל של האפליקציה
// (constants/filterSchema.js DEFAULT_FILTERS) - קוד טהור, בלי AI, בלי DB - בדיוק העיקרון
// הארכיטקטוני שנדרש: "AI מפרש, לא בוחר פעילויות". lib/filterActivities.js לא משתנה כלל,
// חוץ מתמיכה חדשה במצב location.mode='address' (ראו שם).
import { supabase } from './supabase';
import { AGE_OPTIONS, HOUR_OPTIONS, DEFAULT_FILTERS } from '../constants/filterSchema';
import { childAgeToBand, childrenToDefaultAgeFilter } from './children';

const WHEN_OPTION_LABELS = { today: 'היום', tomorrow: 'מחר', weekend: 'סוף השבוע', week: 'השבוע' };

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
function resolveAge(intent, children) {
  const explicit = ageRangeToBands(intent.age);
  if (explicit) return explicit;
  if (intent.childNameMentioned && children?.length) {
    const child = children.find((c) => (c.name || '').trim() && intent.childNameMentioned.includes(c.name.trim()));
    if (child) {
      const band = childAgeToBand(child.birthdate);
      if (band) return [band];
    }
  }
  if (children?.length) {
    const bands = childrenToDefaultAgeFilter(children);
    if (bands.length) return bands;
  }
  return DEFAULT_FILTERS.age;
}

// ה-Intent המובנה (מה-Edge Function) → filters רגילים, מוכנים ל-rankActivities/applyFilters
// הקיימים בלי שום שינוי בהם. context: { children, fallbackLocation } - מידע מהפרופיל שכבר
// טעון בקליינט (לא נטען מחדש כאן, ולא נשלח ל-AI - הכל בקוד טהור).
export function intentToFilters(intent, context = {}) {
  const { children, fallbackLocation } = context;
  return {
    ...DEFAULT_FILTERS,
    category: intent.category ? [intent.category] : [],
    location: intentLocationToFilters(intent.location, fallbackLocation),
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

// "🔎 הבנתי שאתם מחפשים:" - צ'יפים קריאים-לבן-אדם מה-Intent, לפני שמריצים את החיפוש בפועל
// (לא רק אחרי) - כדי שהמשתמש יראה מה ה-AI הבין ויוכל לתקן לפני שמנווטים, לא רק דרך "סינון
// מתקדם" אחרי שכבר בעמוד התוצאות. פונקציה טהורה, בלי תלות ב-UI - app/index.js רק ממפה לתצוגה.
function formatWhenChip(when) {
  if (!when?.option) return null;
  if (WHEN_OPTION_LABELS[when.option]) return WHEN_OPTION_LABELS[when.option];
  if (when.option === 'specific' && when.date) {
    const d = new Date(`${when.date}T12:00:00`);
    return d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });
  }
  return null;
}

function formatHourChip(timeRange) {
  if (!timeRange) return null;
  const match = HOUR_OPTIONS.find((h) => h.start === timeRange.start && h.end === timeRange.end);
  return match ? match.label : `${timeRange.start}–${timeRange.end}`;
}

function formatAgeChip(age) {
  if (!age) return null;
  return age.min === age.max ? `גיל ${age.min}` : `גילאי ${age.min}–${age.max}`;
}

function formatLocationChip(loc) {
  if (!loc) return null;
  if (loc.street && loc.city) {
    const rel = loc.relation === 'exact' ? '' : 'באזור ';
    return `${rel}${loc.street}, ${loc.city}`;
  }
  if (loc.city) return loc.city;
  if (loc.region) return loc.region;
  return null;
}

export function buildSmartSearchSummary(intent) {
  const chips = [];
  const ageChip = formatAgeChip(intent.age);
  if (ageChip) chips.push({ icon: '👶', text: ageChip });
  const locationChip = formatLocationChip(intent.location);
  if (locationChip) chips.push({ icon: '📍', text: locationChip });
  const whenChip = formatWhenChip(intent.when);
  if (whenChip) chips.push({ icon: '📅', text: whenChip });
  const hourChip = formatHourChip(intent.timeRange);
  if (hourChip) chips.push({ icon: '🕘', text: hourChip });
  if (intent.category) chips.push({ icon: '🎯', text: intent.category });
  if (intent.priceHint) chips.push({ icon: '💰', text: intent.priceHint === 'free' ? 'בחינם' : 'זול' });
  if (intent.durationHint) chips.push({ icon: '⏱️', text: intent.durationHint === 'short' ? 'קצר' : 'ארוך' });
  if (intent.placeTypeHint) chips.push({ icon: intent.placeTypeHint === 'indoor' ? '🏠' : '🌳', text: intent.placeTypeHint === 'indoor' ? 'בפנים' : 'בחוץ' });
  if (intent.benefitsHint) chips.push({ icon: '🎟️', text: intent.benefitsHint === 'mine' ? 'עם הטבה שיש לי' : 'עם הטבה' });
  return chips;
}
