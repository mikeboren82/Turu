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
import { WEEKDAY_LABEL_TO_DOW, buildSystemPrompt, parseJsonObject, sanitizeIntent } from '../_shared/smartSearchIntent.ts';
import { geocodeAddress } from '../_shared/geocoding.ts';
import { matchRegionAlias } from '../_shared/regionAliases.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
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
      parsed = sanitizeIntent(parseJsonObject(raw), query);
      // רשת-ביטחון דטרמיניסטית (ראו _shared/regionAliases.ts): המודל התבקש להחזיר ערך קנוני מדויק
      // מ-REGION_VALUES, ו-sanitizeIntent מוחק בשקט כל דבר אחר - כך "פינות חי בשרון" יכול היה לצאת
      // בלי שום מיקום. רק כשאין גם עיר וגם אזור מנסים למפות כינוי מוכר ("בשרון", "גוש דן", "ביו״ש")
      // מהטקסט הגולמי לערך הקנוני. מוגבל בכוונה (התאמת-מילה-שלמה, לא substring; מונחי-כיוון קצרים
      // רק בסוף השאילתה; שני אזורים שונים → null) - אזור שגוי גרוע יותר מהיעדר אזור.
      if (!parsed.location.city && !parsed.location.region) {
        const alias = matchRegionAlias(query);
        if (alias) parsed = { ...parsed, location: { ...parsed.location, region: alias, regionSource: 'alias' } };
      }
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
      // ראיה/סיבת-דחייה לקטגוריה מוסקת (smartSearchIntent.ts#validateCategoryEvidence) - נשמר ב-
      // smart_search_logs.parsed_intent למדידה; הקליינט לא צריך אותם, הקטגוריה כבר מסוננת כאן.
      categoryEvidence: parsed.categoryEvidence ?? null,
      categoryRejectedReason: parsed.categoryRejectedReason ?? null,
      location: {
        city: parsed.location.city, region: parsed.location.region,
        street: parsed.location.street, relation: parsed.location.relation,
        coords, geocodeFailed: geocodeAttempted && !coords,
        // 'alias' כשהאזור הגיע מה-fallback הדטרמיניסטי ולא מהמודל (נשמר ב-smart_search_logs.parsed_intent
        // למדידה של כמה שאילתות המודל פספס) - הקליינט (lib/smartSearch.js) מתעלם מהשדה.
        regionSource: parsed.location.regionSource ?? null,
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
      residualQuery: parsed.residualQuery ?? null,
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
