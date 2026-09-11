// TuRu - "🔎 חיפוש חכם": הופכת שאילתת-שפה-טבעית בעברית לפילטר מובנה (Structured Search Intent)
// שהאפליקציה כבר יודעת להשתמש בו - lib/filterActivities.js (applyFilters/rankActivities) לא
// משתנה בכלל, וה-AI *לעולם* לא בוחר/ממציא פעילויות בעצמו. הזרימה:
//
//   טקסט חופשי → (הפונקציה הזו) → Structured Intent מאומת → lib/smartSearch.js (קליינט,
//   טהור, בלי AI) → ממיר ל-filters הרגילים → applyFilters/rankActivities הקיימים → תוצאות.
//
// למה AI לא עושה חשבון תאריכים בעצמו: מודלי שפה לא אמינים בחישוב תאריכים מדויק. ה-AI מסווג
// ביטוי יחסי ("מחר"/"שבת"/"בעוד יומיים") לתווית קבועה מתוך אוצר-מילים סגור, והקוד כאן (לא
// ה-AI) מחשב את התאריך המדויק מ"היום" האמיתי - דטרמיניסטי ובדיק, לא תלוי-מודל.
//
// Geocoding: כתובת (רחוב+עיר) מזוהה כאן דרך _shared/geocoding.ts (Nominatim, כמו כלי הניהול) -
// זה *לא* מקור הפעילויות של TuRu, רק "איפה נמצא הרחוב הזה" לפני שמריצים חיפוש-מרחק על מאגר
// הפעילויות האמיתי של TuRu (בקליינט, אחרי שהתשובה חוזרת).

import { createClient } from 'npm:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk@0.32';
import { CATEGORY_VALUES, ARCHIVE_CATEGORIES, REGION_VALUES } from '../_shared/extraction.ts';
import { geocodeAddress } from '../_shared/geocoding.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

// זהה לגזירת CATEGORY_FILTER_OPTIONS ב-constants/filterSchema.js (אותו מקור-אמת,
// categoryValues.json, רק שני runtimes נפרדים) - קטגוריות-ארכיון ו"אחר" אינן יעד-חיפוש תקין.
const SEARCHABLE_CATEGORIES = CATEGORY_VALUES.filter((c) => !ARCHIVE_CATEGORIES.includes(c) && c !== 'אחר');

// ימי השבוע - כולם, לא רק שישי/שבת (נמצא בבדיקה: "פעילות ביום שלישי הבא" נפל בשקט ל-null כי
// רק שני ימים היו נתמכים - המשתמש ציין יום מפורש, אסור להשמיט את זה, ראו עקרון "אל תמציא/
// תשמיט" בסעיף 24). WEEKDAY_LABEL_TO_DOW למטה ממפה כל אחד ל-getDay() (0=ראשון...6=שבת).
const WEEKDAY_LABEL_TO_DOW: Record<string, number> = {
  this_sunday: 0, this_monday: 1, this_tuesday: 2, this_wednesday: 3,
  this_thursday: 4, this_friday: 5, this_saturday: 6,
};
const DATE_LABELS = [
  'today', 'tomorrow', 'day_after_tomorrow',
  ...Object.keys(WEEKDAY_LABEL_TO_DOW),
  'weekend', 'this_week', 'in_days', 'specific_date', null,
] as const;
const AMENITY_HINTS = ['ממוזג', 'מקורה', 'חניה', 'שירותים', 'נגיש לכיסא גלגלים', 'מתאים לעגלה'];
const PRICE_HINTS = ['free', 'cheap', null];
const DURATION_HINTS = ['short', 'long', null];
const PLACE_TYPE_HINTS = ['indoor', 'outdoor', null];
const BENEFITS_HINTS = ['any', 'mine', null];

function buildSystemPrompt(todayISO: string, todayHebrewDay: string): string {
  return `אתה עוזר שמנתח בקשת חיפוש בעברית טבעית של הורה שמחפש פעילות לילדים, והופך אותה לאובייקט JSON מובנה. אתה *לא* בוחר פעילויות בעצמך ולא ממציא מידע - אתה רק מבין את הכוונה של המשתמש.

היום הוא ${todayISO} (יום ${todayHebrewDay}). זה חשוב לצורך סיווג ביטויי-זמן יחסיים - אבל אתה *לא* מחשב תאריך מדויק בעצמך, רק מסווג לאחת הקטגוריות הקבועות למטה (הקוד שקורא אותך יחשב את התאריך המדויק).

החזר אובייקט JSON יחיד עם השדות הבאים בדיוק (null לכל שדה שלא הוזכר או לא ברור - לעולם אל תנחש/תמציא):

- category: הקטגוריה המתאימה ביותר מהרשימה הבאה בדיוק, אחרת null: ${JSON.stringify(SEARCHABLE_CATEGORIES)}
  חשוב: קטגוריה יכולה להופיע צמודה לשם עיר/יישוב *בלי* מילת-יחס כמו "ב-"/"באזור" ביניהן - "גן שעשועים צורן" הוא category:"גן שעשועים" + location.city:"צורן" (לא ביטוי אחד בלתי-ניתן-לפירוק, ולא שם ספציפי של מקום). אותו דבר ל"משחקייה רעננה", "חוג ציור חיפה" וכו' - שם היישוב בסוף המשפט, בלי חיבור מפורש, הוא עדיין location.city, לא חלק מהקטגוריה.
- location: אובייקט עם:
  - city: שם עיר/יישוב מפורש שהוזכר (למשל "תל אביב"), אחרת null
  - street: שם רחוב אם הוזכר (בלי "רחוב"/"ברחוב", רק השם עצמו, למשל "הרצל"), אחרת null
  - region: אם הוזכר אזור רחב (לא עיר ספציפית) שמתאים בדיוק לאחד מהערכים הבאים, אחרת null: ${JSON.stringify(REGION_VALUES)}
  - relation: "exact" אם המשתמש התכוון לרחוב עצמו (למשל "ברחוב הרצל"), "nearby" אם התכוון לאזור מסביב (למשל "ליד רחוב הרצל", "באזור הרצל"), אחרת null. רלוונטי רק כש-street לא null.
- date_label: בדיוק אחד מהערכים הבאים לפי מה שהמשתמש התכוון, אחרת null:
  "today" (היום/עכשיו) | "tomorrow" (מחר) | "day_after_tomorrow" (מחרתיים/בעוד יומיים) | "this_sunday"/"this_monday"/"this_tuesday"/"this_wednesday"/"this_thursday"/"this_friday"/"this_saturday" (המשתמש ציין יום בשבוע מפורש - "ביום שלישי", "שישי", "השבת הקרובה" - תמיד היום הקרוב הבא מהיום) | "weekend" (סוף השבוע, בלי יום ספציפי) | "this_week" (השבוע) | "in_days" (ביטוי כמו "בעוד 3 ימים" - גם למלא days_offset) | "specific_date" (המשתמש נתן תאריך מפורש כמו "ב-15 לחודש" - גם למלא explicit_date)
- days_offset: מספר ימים קדימה מהיום, רק אם date_label הוא "in_days", אחרת null
- explicit_date: תאריך בפורמט YYYY-MM-DD, רק אם date_label הוא "specific_date" והמשתמש נתן תאריך מפורש וחד-משמעי, אחרת null
- time_range: אובייקט {start:"HH:MM", end:"HH:MM"} אם המשתמש ציין זמן ביום (גם מרומז - "בבוקר"→06:00-12:00, "צהריים"→12:00-15:00, "אחר הצהריים"→15:00-18:00, "בערב"→18:00-23:00, "אחרי הגן"→בדרך כלל 15:00-18:00, "יש לנו שעה"→null, זה לא מידע על שעה ספציפית), אחרת null
- age: אובייקט {min, max} (מספרים, שנים) אם המשתמש ציין גיל מפורש למשל "לילד בן 5" → {min:5,max:5}, "לגילאי 3 עד 6" → {min:3,max:6}, אחרת null
- child_name_mentioned: אם המשתמש הזכיר שם פרטי של ילד/ה (למשל "עם אבישי", "לדנה"), החזר את השם עצמו כמחרוזת, אחרת null
- price_hint: "free" אם המשתמש ביקש בפירוש בחינם, "cheap" אם ביקש זול, אחרת null
- duration_hint: "short" אם ביקש משהו קצר/"יש לנו רק שעה", "long" אם ביקש ארוך, אחרת null
- place_type_hint: "indoor" אם המשתמש ביקש *במפורש* בתוך מבנה/מקורה (למשל "משהו סגור", "בבית"), "outdoor" אם ביקש *במפורש* בחוץ/בטבע, אחרת null. חשוב: אל תסיק את זה מסוג הפעילות עצמו (למשל "משחקייה" לא אומרת indoor, "ממוזג" לא אומר indoor, "לייזר טאג"/"קרטינג" לא אומר indoor למרות שרוב המקומות מהסוג הזה בפועל נמצאים במבנה) - רק אם המשתמש ממש אמר את זה על המקום במפורש, לא כי זה נשמע סביר לסוג הפעילות.
- amenity_hints: מערך תגיות מתוך הרשימה הבאה בלבד (רק אם התבקשו בפירוש): ${JSON.stringify(AMENITY_HINTS)}
- benefits_hint: "any" אם המשתמש ביקש *במפורש* פעילויות עם הטבה/הנחה כלשהי (למשל "פעילויות עם הנחה"), "mine" אם ביקש *במפורש* רק הטבות שיש לו/שהוא זכאי להן (למשל "פעילויות שיש לי עליהן הטבה"), אחרת null. חשוב: זו דרישת-סינון קשיחה, לא רמז-דירוג - אל תמלא את זה סתם כי יש למשתמש מועדון כלשהו, רק אם ביקש הטבות באופן מפורש.
- vague_intent: מערך מחרוזות חופשי לכוונות שלא ניתנות למיפוי לשדה קונקרטי (למשל "רגוע", "משהו שיעייף אותו", "מיוחד", "כיפי") - נשמר לצורך תיעוד בלבד, לא משפיע על החיפוש

החזר אך ורק אובייקט JSON תקני, בלי טקסט נוסף לפני/אחרי, בלי markdown code fences.`;
}

function toIsraelISODate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
}

const HEBREW_DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function addDaysISO(todayISO: string, days: number): string {
  const d = new Date(`${todayISO}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function nextWeekdayOffset(todayISO: string, targetDow: number): number {
  const d = new Date(`${todayISO}T00:00:00`);
  const currentDow = d.getDay();
  let diff = targetDow - currentDow;
  if (diff < 0) diff += 7;
  return diff;
}

// ממיר date_label (סיווג מה-AI) לתאריך אמיתי + ה-WHEN_OPTIONS id המתאים (constants/filterSchema.js) -
// חישוב דטרמיניסטי, לא תלוי-AI. מחזיר {whenOption, resolvedDate} - שניהם עשויים להיות null.
function resolveDateLabel(
  label: string | null, daysOffset: number | null, explicitDate: string | null, todayISO: string,
): { whenOption: string | null; resolvedDate: string | null } {
  if (label && label in WEEKDAY_LABEL_TO_DOW) {
    return { whenOption: 'specific', resolvedDate: addDaysISO(todayISO, nextWeekdayOffset(todayISO, WEEKDAY_LABEL_TO_DOW[label])) };
  }
  switch (label) {
    case 'today': return { whenOption: 'today', resolvedDate: todayISO };
    case 'tomorrow': return { whenOption: 'tomorrow', resolvedDate: addDaysISO(todayISO, 1) };
    case 'day_after_tomorrow': return { whenOption: 'specific', resolvedDate: addDaysISO(todayISO, 2) };
    case 'weekend': return { whenOption: 'weekend', resolvedDate: null };
    case 'this_week': return { whenOption: 'week', resolvedDate: null };
    case 'in_days': {
      const n = typeof daysOffset === 'number' && daysOffset >= 0 && daysOffset <= 60 ? daysOffset : null;
      return n == null ? { whenOption: null, resolvedDate: null } : { whenOption: 'specific', resolvedDate: addDaysISO(todayISO, n) };
    }
    case 'specific_date': {
      const valid = explicitDate && /^\d{4}-\d{2}-\d{2}$/.test(explicitDate) && explicitDate >= todayISO;
      return valid ? { whenOption: 'specific', resolvedDate: explicitDate } : { whenOption: null, resolvedDate: null };
    }
    default:
      return { whenOption: null, resolvedDate: null };
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('המודל לא החזיר JSON תקני');
  return JSON.parse(match[0]);
}

// ולידציה הגנתית - כל ערך לא-ברשימה נמחק (אותו עיקרון בדיוק כמו sanitizeCandidate ב-scan-source).
// deno-lint-ignore no-explicit-any
function sanitizeIntent(raw: any) {
  const inList = (val: unknown, list: readonly (string | null)[]) => (list.includes(val as string) ? (val as string) : null);
  const category = typeof raw.category === 'string' && SEARCHABLE_CATEGORIES.includes(raw.category) ? raw.category : null;
  const loc = raw.location || {};
  const location = {
    city: typeof loc.city === 'string' && loc.city.trim() ? loc.city.trim() : null,
    street: typeof loc.street === 'string' && loc.street.trim() ? loc.street.trim() : null,
    region: typeof loc.region === 'string' && REGION_VALUES.includes(loc.region) ? loc.region : null,
    relation: loc.relation === 'exact' || loc.relation === 'nearby' ? loc.relation : null,
  };
  const dateLabel = inList(raw.date_label, DATE_LABELS);
  const daysOffset = typeof raw.days_offset === 'number' ? raw.days_offset : null;
  const explicitDate = typeof raw.explicit_date === 'string' ? raw.explicit_date : null;
  const timeRange = raw.time_range && typeof raw.time_range.start === 'string' && typeof raw.time_range.end === 'string'
    && /^\d{2}:\d{2}$/.test(raw.time_range.start) && /^\d{2}:\d{2}$/.test(raw.time_range.end)
    ? { start: raw.time_range.start, end: raw.time_range.end } : null;
  const age = raw.age && typeof raw.age.min === 'number' && typeof raw.age.max === 'number'
    && raw.age.min >= 0 && raw.age.max <= 18 && raw.age.min <= raw.age.max
    ? { min: raw.age.min, max: raw.age.max } : null;
  const childName = typeof raw.child_name_mentioned === 'string' && raw.child_name_mentioned.trim() ? raw.child_name_mentioned.trim() : null;
  const priceHint = inList(raw.price_hint, PRICE_HINTS);
  const durationHint = inList(raw.duration_hint, DURATION_HINTS);
  const placeTypeHint = inList(raw.place_type_hint, PLACE_TYPE_HINTS);
  const amenityHints = Array.isArray(raw.amenity_hints) ? raw.amenity_hints.filter((v: unknown) => AMENITY_HINTS.includes(v as string)) : [];
  const benefitsHint = inList(raw.benefits_hint, BENEFITS_HINTS);
  const vagueIntent = Array.isArray(raw.vague_intent) ? raw.vague_intent.filter((v: unknown) => typeof v === 'string').slice(0, 5) : [];

  return { category, location, dateLabel, daysOffset, explicitDate, timeRange, age, childName, priceHint, durationHint, placeTypeHint, amenityHints, benefitsHint, vagueIntent };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  // פתוח גם למי שלא מחובר (בקשת המשתמש - "כל אחד יוכל להשתמש בחיפוש החכם, לא רק רשום") - user
  // נשאר null במקרה הזה, לא חוסמים יותר עם 401. rate-limit ממשיך לחול, רק לפי IP במקום user_id.
  const authHeader = req.headers.get('Authorization');
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: authHeader ? { Authorization: authHeader } : {} } },
  );
  const { data: { user } } = authHeader
    ? await supabase.auth.getUser()
    : { data: { user: null } };
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || req.headers.get('cf-connecting-ip') || null;

  // deno-lint-ignore no-explicit-any
  let body: { query?: string; cityOverride?: string; pendingIntent?: any };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'בקשה לא תקינה' }, 400);
  }
  const query = (body.query || '').trim();
  if (!query) return jsonResponse({ error: 'לא הוזן טקסט חיפוש' }, 400);
  if (query.length > 300) return jsonResponse({ error: 'החיפוש ארוך מדי' }, 400);

  // Rate limit פשוט - עד 30 חיפושים חכמים ליום, לפי user_id למחוברים או לפי IP למי שלא (ראו
  // supabase/0053_smart_search_logs.sql + 0057 שהוסיפה ip_address). בלי user וגם בלי IP (נדיר,
  // תלוי בהעדר headers מהפרוקסי) - לא ניתן לזהות את הקורא בכלל, ממשיכים בלי חסימה (best-effort).
  const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  if (user || clientIp) {
    const rateQuery = supabase.from('smart_search_logs').select('id', { count: 'exact', head: true }).gte('created_at', oneDayAgo);
    const { count: recentCount } = user
      ? await rateQuery.eq('user_id', user.id)
      : await rateQuery.eq('ip_address', clientIp);
    if ((recentCount || 0) >= 30) {
      return jsonResponse({ error: 'הגעתם למכסת החיפושים החכמים היומית - נסו שוב מחר, או השתמשו בסינון הרגיל' }, 429);
    }
  }

  const todayISO = toIsraelISODate(new Date());
  const todayHebrewDay = HEBREW_DAY_NAMES[new Date(`${todayISO}T12:00:00`).getDay()];

  const logRow: Record<string, unknown> = { user_id: user?.id ?? null, ip_address: user ? null : clientIp, query };

  try {
    let parsed;
    // סבב-הבהרה (Step 8): המשתמש כבר קיבל needsClarification עם ה-intent החלקי (parsed, אותה
    // צורה בדיוק שמוחזרת מ-sanitizeIntent), ורק סיפק עיר - אין צורך בקריאת AI נוספת ואין צורך
    // (ולא בטוח!) להריץ שוב את sanitizeIntent: הוא בנוי לקרוא שדות בצורת ה-JSON הגולמי מה-AI
    // (snake_case כמו date_label/amenity_hints) - pendingIntent כבר בצורה הסניטזת (camelCase
    // כמו dateLabel/amenityHints), אז הרצה חוזרת דרך sanitizeIntent הייתה משמיטה בשקט כל שדה
    // חוץ מ-category/location/age (התאמת-שם-שדה במקרה) - בדיוק סוג האיבוד-מידע-בשקט שאסור
    // (סעיף 24 בבקשה). במקום זה פשוט ממזגים את העיר לתוך האובייקט הסניטז הקיים.
    if (body.cityOverride && body.pendingIntent) {
      parsed = { ...body.pendingIntent, location: { ...body.pendingIntent.location, city: body.cityOverride } };
    } else {
      const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
      const message = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        // temperature 0 - זו משימת חילוץ-מובנה (structured extraction), לא כתיבה יצירתית.
        // ברירת המחדל (~1.0) גרמה לחוסר-עקביות אמיתי בפועל: "גן שעשועים צורן" (בלי מילת-יחס
        // כמו "ב-" בין הקטגוריה למיקום) חזר לפעמים עם category+city נכונים ולפעמים עם intent
        // ריק לגמרי על אותה שאילתה בדיוק (3 קריאות ישירות רצופות, כולן ריקות - נבדק 2026-09-11).
        temperature: 0,
        system: buildSystemPrompt(todayISO, todayHebrewDay),
        messages: [{ role: 'user', content: query }],
      });
      const raw = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      parsed = sanitizeIntent(parseJsonObject(raw));
    }

    const { whenOption, resolvedDate } = resolveDateLabel(parsed.dateLabel, parsed.daysOffset, parsed.explicitDate, todayISO);

    // עמימות אמיתית: רחוב הוזכר בלי עיר ובלי אזור - אי אפשר לגאוקד בלי לדעת איפה לחפש, ואסור
    // לנחש עיר (ראו שלב 8/9 בבקשה). מחזירים needsClarification ולא מנסים geocoding בכלל.
    if (parsed.location.street && !parsed.location.city && !parsed.location.region) {
      logRow.had_ambiguity = true;
      logRow.parsed_intent = parsed;
      await supabase.from('smart_search_logs').insert(logRow);
      return jsonResponse({ needsClarification: { type: 'city', message: '📍 באיזו עיר?' }, intent: parsed });
    }

    let coords: { lat: number; lng: number } | null = null;
    let geocodeAttempted = false;
    let geocodeSuccess: boolean | null = null;
    if (parsed.location.street && parsed.location.city) {
      geocodeAttempted = true;
      coords = await geocodeAddress(`${parsed.location.street}, ${parsed.location.city}`);
      geocodeSuccess = coords != null;
      // נפילה בעדינות: geocoding נכשל - עדיין יש עיר, נמשיך עם חיפוש-עיר רגיל (לא קורסים,
      // לא חוסמים את החיפוש כולו בגלל זה - ראו שלב 26 בבקשה).
    }

    const intent = {
      category: parsed.category,
      location: {
        city: parsed.location.city, region: parsed.location.region,
        street: parsed.location.street, relation: parsed.location.relation,
        coords, geocodeFailed: geocodeAttempted && !coords,
      },
      when: { option: whenOption, date: resolvedDate },
      timeRange: parsed.timeRange,
      age: parsed.age,
      childNameMentioned: parsed.childName,
      priceHint: parsed.priceHint,
      durationHint: parsed.durationHint,
      placeTypeHint: parsed.placeTypeHint,
      amenityHints: parsed.amenityHints,
      benefitsHint: parsed.benefitsHint,
      vagueIntent: parsed.vagueIntent,
    };

    logRow.parsed_intent = intent;
    logRow.had_ambiguity = false;
    logRow.geocode_attempted = geocodeAttempted;
    logRow.geocode_success = geocodeSuccess;
    await supabase.from('smart_search_logs').insert(logRow);

    return jsonResponse({ intent });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logRow.error_message = message;
    await supabase.from('smart_search_logs').insert(logRow).select();
    return jsonResponse({ error: 'לא הצלחנו להבין את החיפוש, נסו לנסח אחרת או השתמשו בסינון הרגיל' }, 502);
  }
});
