// TuRu - Edge Function ל"הוספת פעילות" ע"י משתמשי קצה: מקבלת קישור, שולפת את תוכן העמוד
// ומחלצת ממנו פעילות מובנית באמצעות Claude - אותה לוגיקה בדיוק כמו tools/import-tool/server.js
// (scrapeAndExtract), רק שרצה בענן כדי שלא תהיה תלות במחשב של המנהל. המשתמש מקבל את התוצאה
// לעריכה חופשית ומאשר בעצמו - שום דבר לא נשמר כאן, ה-function רק מחלצת ומחזירה.

import { createClient } from 'npm:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk@0.32';
import * as cheerio from 'npm:cheerio@1.0.0';

const CATEGORY_VALUES = [
  'גן שעשועים', "ג'ימבורי", 'משחקייה', 'סדנה', 'חוג', 'הצגה', 'מוזיאון לילדים',
  'פארק', 'חווה', 'פינת חי', 'אטרקציה', 'בריכה', 'ספורט', 'יצירה',
  'מוזיקה', 'ריקוד', 'בישול', 'מדע', 'טבע', 'בעלי חיים', 'פעילות מים',
  'טרמפולינות', 'פארק שעשועים', 'קולנוע לילדים', 'ספרייה', 'שעת סיפור',
  'פעילות קהילתית', 'פעילות עירונית', 'אחר',
];
const WEATHER_VALUES = ['מתאים ליום חם', 'מתאים ליום גשום', 'ממוזג', 'מוצל', 'מקורה', 'פעילות בחוץ בלבד'];
const AMENITIES_VALUES = [
  'חניה', 'שירותים', 'חניה נגישה', 'שירותים נגישים', 'נגיש לכיסא גלגלים',
  'מתאים לעגלה', 'עמדת החתלה', 'מקום ישיבה להורים', 'בית קפה', 'מזנון',
  'מים לשתייה', 'Wi-Fi', 'הצללה', 'מיזוג', 'תחבורה ציבורית קרובה',
];
const FAMILY_FIT_VALUES = [
  'מתאים לילד ולהורה', 'פעילות לילדים בלבד', 'הורה חייב להישאר', 'אפשר להשאיר את הילד',
  'מתאים לאחים בגילאים שונים', 'מתאים לקבוצות', 'מתאים ליום הולדת',
];
const REGION_VALUES = [
  'גוש דן והמרכז', 'השרון', 'ירושלים והסביבה', 'חיפה והקריות',
  'הצפון והעמק', 'השפלה והדרום', 'יו"ש והבנימין',
];

function buildExtractionSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `אתה עוזר שמחלץ מידע מובנה על פעילויות ואירועים לילדים מתוך טקסט גולמי של עמוד אינטרנט.
קיבלת את תוכן הטקסט של עמוד (יכול להכיל כמה פעילויות/אירועים בעמוד אחד, כמו לוח אירועים של קניון).

היום הנוכחי הוא ${today}. זה חשוב לכמה מטרות:
1. אם יש תאריך מפורש לאירוע חד-פעמי (one_time_date) שכבר עבר לפני היום הנוכחי - אל תכלול את הפעילות הזו בתשובה בכלל, היא לא רלוונטית יותר.
2. תוכן שקשור לחג ספציפי (פסח, שבועות, סוכות, פורים, חנוכה, ראש השנה, יום העצמאות וכו') בלי תאריך מפורש - היזהר מאוד: אתרי "מה עושים" רבים מפרסמים דפים כאלה פעם בשנה ולא מעדכנים אותם, כך שתוכן על "אירועי שבועות" עלול להיות משנה שעברה. אל תכלול פעילות כזו בתשובה, אלא אם כן ברור מהטקסט שמדובר במקום/פעילות שפועלים כל השנה (למשל שם של גן חיות שיש בו גם אירוע חג - את הגן עצמו כן אפשר לכלול, את "אירוע החג" הספציפי בו לא, אלא אם יש תאריך עתידי מפורש).
3. חשוב מאוד: **אל תסמכו על כותרות כמו "אירועים קרובים" / "השבוע" / "עכשיו" בעמוד עצמו כהוכחה לרלוונטיות**. אתרים רבים משאירים כותרות כאלה קבועות בעיצוב העמוד גם כשהתוכן מתחתיהן ישן ולא עודכן. הכותרת "אירועים קרובים" בפני עצמה, בלי תאריך מפורש (יום+חודש, או לפחות חודש) ליד כל פריט, היא לא ערובה לכך שמדובר במשהו שקורה בקרוב. אם פריט תחת כותרת כזו קשור לחג ספציפי (ראו סעיף 2) ואין לידו תאריך מפורש - אל תכלילו אותו, גם אם הכותרת שמעליו אומרת "קרוב" או "עכשיו".

עבור כל פעילות/אירוע/מקום שאתה מזהה בטקסט, החזר אובייקט עם השדות הבאים. אם שדה לא מופיע בטקסט בבירור - השאר אותו null, אל תמציא ערכים.

- name: שם הפעילות (מחרוזת)
- entity_type: אחד מ- "מקום_קבוע" | "פעילות" | "אירוע_קבוע" | "אירוע"
  הגדרות:
  * "מקום_קבוע" - מקום פיזי עם שעות פתיחה קבועות (schedule_type: fixed_hours)
  * "פעילות" - חוג/סדנה/פעילות חוזרת שהילדים משתתפים בה באופן פעיל (schedule_type: recurring)
  * "אירוע_קבוע" - אירוע/יריד/שוק/מופע שחוזר על עצמו בלוח זמנים קבוע אבל הוא בעיקרו אירוע להתארח בו ולא סדנה (schedule_type: recurring)
  * "אירוע" - אירוע חד-פעמי בתאריך ספציפי (schedule_type: one_time)
  חשוב: "אירוע" (בלי "קבוע") מותר רק כאשר schedule_type הוא one_time. כל דבר שחוזר על עצמו בלוח זמנים קבוע הוא "פעילות" או "אירוע_קבוע", לעולם לא "אירוע" סתם
- description: תיאור קצר (עד 2-3 משפטים), בעברית, מנוסח מחדש בקצרה מהטקסט המקורי
- schedule_type: אחד מ- "recurring" (חוזר על עצמו) | "one_time" (תאריך ושעה חד פעמיים) | "fixed_hours" (מקום עם שעות פתיחה קבועות)
- recurring_days: מערך של ימים בעברית אם schedule_type הוא recurring, למשל ["שני", "רביעי"], אחרת null
- start_time: שעת התחלה כמחרוזת "HH:MM" אם קיימת, אחרת null
- end_time: שעת סיום כמחרוזת "HH:MM" אם קיימת, אחרת null
- one_time_date: תאריך בפורמט YYYY-MM-DD אם schedule_type הוא one_time ויש תאריך מפורש בטקסט, אחרת null
- min_age: גיל מינימלי כמספר (בשנים, אפשר עשרוני כמו 0.5), אחרת null
- max_age: גיל מקסימלי כמספר, אחרת null
- price_type: אחד מ- "free" | "fixed" | "range" | null אם לא צוין
- price_amount: מספר (בשקלים) אם price_type הוא fixed, אחרת null
- location_name: שם המקום הכללי (למשל שם הקניון/הפארק), אחרת null
- location_detail: פרטי מיקום נוספים בתוך המקום (קומה, אזור וכו'), אחרת null
- city: שם היישוב/העיר שבו נמצאת הפעילות (למשל "תל אביב", "חיפה", "קרית שמונה"), אחרת null

בנוסף, סווג את הפעילות לפי השדות הבאים - **רק אם ניתן להסיק אותם בביטחון סביר מהטקסט**. אל תנחש - אם אין רמז ברור, השאר null (או מערך ריק [] עבור שדות מסוג מערך).

- category: בדיוק אחת מהאפשרויות הבאות (המתאימה ביותר), אחרת null: ${JSON.stringify(CATEGORY_VALUES)}
  שים לב: category הוא שדה שונה לגמרי מ-entity_type! לעולם אל תחזיר כאן "מקום_קבוע"/"פעילות"/"אירוע_קבוע"/"אירוע" - אלה שייכים רק לשדה entity_type. category מתאר את סוג התוכן (למשל "בישול", "פעילות קהילתית", "אחר")
- duration_minutes: משך הפעילות המשוער בדקות (מספר), אחרת null
- indoor_outdoor: אחד מ- "indoor" | "outdoor" | "both", אחרת null
- booking_requirement: אחד מ- "none" | "walk_in" | "registration_required" | "advance_booking" | "available_now", אחרת null
- weather_suitable: מערך תגיות מתוך הרשימה הבאה בלבד (אפשר כמה, אפשר מערך ריק): ${JSON.stringify(WEATHER_VALUES)}
- amenities: מערך תגיות מתוך הרשימה הבאה בלבד (רק אם מוזכרות בפירוש בטקסט): ${JSON.stringify(AMENITIES_VALUES)}
- family_fit: מערך תגיות מתוך הרשימה הבאה בלבד (אפשר כמה, אפשר מערך ריק): ${JSON.stringify(FAMILY_FIT_VALUES)}
- region: האזור הגאוגרפי בישראל שבו נמצא היישוב (city), בהתאם לידע הכללי שלך על גאוגרפיית ישראל.
  בדיוק אחת מהאפשרויות הבאות, אחרת null אם אינך בטוח לאיזה אזור שייך היישוב: ${JSON.stringify(REGION_VALUES)}
  ההנחיות הבאות מחייבות במפורש (כולל כמה מקרים שקל לטעות בהם) - כאשר יישוב מופיע ברשימה של אזור מסוים,
  יש לסווג אותו לאזור הזה בדיוק, גם אם באופן גאוגרפי כללי הוא נראה קרוב לאזור אחר:
  * "גוש דן והמרכז": תל אביב, רמת גן, גבעתיים, פתח תקווה, ראשון לציון, חולון, בת ים.
    חשוב: "הרצליה" סתם (בלי "פיתוח"/"הירוקה" בפירוש) שייכת לכאן, לגוש דן - לא לשרון.
  * "השרון": נתניה, כפר סבא, רעננה, הוד השרון, חדרה, אזור עמק חפר, וכן ספציפית "הרצליה פיתוח" או "הרצליה הירוקה" (אך לא "הרצליה" סתם - זו גוש דן, ראו למעלה)
  * "ירושלים והסביבה": ירושלים, מבשרת ציון, מעלה אדומים, בית שמש, גוש עציון
  * "חיפה והקריות": חיפה, טבעון, נשר, וכל ערי "קריית X" ליד מפרץ חיפה בלבד - קריית ביאליק, קריית אתא, קריית ים, קריית מוצקין, קריית חיים
  * "הצפון והעמק": עכו, נהריה, כרמיאל, עפולה, טבריה, קצרין, ראש פינה, קרית שמונה, מגדל העמק, בית שאן, וכלל יישובי העמקים (יזרעאל/חולה) והגליל.
    חשוב: "עכו" ו"נהריה" שייכות לכאן, לצפון - לא לחיפה והקריות, למרות הקרבה הגאוגרפית לחיפה.
  * "השפלה והדרום": רחובות, מודיעין, רמלה, לוד, אשדוד, אשקלון, באר שבע, וכלל יישובי עוטף עזה והערבה
  * "יו"ש והבנימין": אריאל, מודיעין עילית, ביתר עילית, וכלל יישובי השומרון והבנימין

בהודעת המשתמש תקבל גם "רשימת תמונות מהעמוד" - מערך של אובייקטים {url, alt, context} שנאספו מתגי <img> בעמוד.
- image_urls: מערך של כתובות URL מתוך הרשימה הזו (ורק ממנה - אסור להמציא כתובת) שמייצגות בבירור את הפעילות הספציפית הזו, על סמך alt/context שמתאימים לשם/לתיאור שלה. עד 3 כתובות. אם אין תמונה שמתאימה בבירור - החזר מערך ריק [].

החזר תשובה שהיא אך ורק מערך JSON תקני (JSON array) של אובייקטים כאלה, בלי טקסט נוסף לפני או אחרי, ובלי markdown code fences.`;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function extractCandidateImages($: cheerio.CheerioAPI, baseUrl: string) {
  const seen = new Set<string>();
  const images: { url: string; alt: string; context: string }[] = [];
  $('img').each((_, el) => {
    const $el = $(el);
    const src = [$el.attr('data-src'), $el.attr('data-lazy-src'), $el.attr('data-original'), $el.attr('src')]
      .find((s) => s && !s.startsWith('data:'));
    if (!src) return;
    let absolute: string;
    try {
      absolute = new URL(src, baseUrl).toString();
    } catch {
      return;
    }
    if (seen.has(absolute)) return;
    const lower = absolute.toLowerCase();
    if (/logo|sprite|icon|favicon|placeholder|pixel\.gif|\.svg($|\?)/.test(lower)) return;
    const width = parseInt($el.attr('width') || '0', 10);
    const height = parseInt($el.attr('height') || '0', 10);
    if ((width && width < 80) || (height && height < 80)) return;
    const alt = ($el.attr('alt') || '').trim();
    const context = ($el.closest('div, article, li, section').text() || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    seen.add(absolute);
    images.push({ url: absolute, alt, context });
  });
  return images.slice(0, 40);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'צריך להתחבר כדי להשתמש בזה' }), {
        status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'צריך להתחבר כדי להשתמש בזה' }), {
        status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const { url } = await req.json();
    if (!url || typeof url !== 'string') {
      return new Response(JSON.stringify({ error: 'חסר קישור' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return new Response(JSON.stringify({ error: 'הקישור לא תקין' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const pageRes = await fetch(parsedUrl.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WabbitBot/1.0)' },
    });
    if (!pageRes.ok) {
      return new Response(JSON.stringify({ error: `לא הצלחנו לטעון את הדף (סטטוס ${pageRes.status})` }), {
        status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    const html = await pageRes.text();
    const $ = cheerio.load(html);
    const candidateImages = extractCandidateImages($, parsedUrl.toString());
    $('script, style, noscript, nav, footer, header, svg, form').remove();
    const text = $('body').text().replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, 18000);

    if (!text) {
      return new Response(JSON.stringify({ error: 'לא מצאנו טקסט קריא בעמוד הזה' }), {
        status: 422, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system: buildExtractionSystemPrompt(),
      messages: [
        {
          role: 'user',
          content: `כתובת המקור: ${parsedUrl.toString()}\n\nתוכן הדף:\n${text}\n\nרשימת תמונות מהעמוד:\n${JSON.stringify(candidateImages)}`,
        },
      ],
    });

    const raw = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return new Response(JSON.stringify({ error: 'המודל לא החזיר תשובה תקינה, נסו שוב' }), {
        status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    let activities;
    let truncated = false;
    try {
      activities = JSON.parse(jsonMatch[0]);
    } catch {
      // כנראה שהתשובה נקטעה (הרבה פעילויות בעמוד אחד) - ננסה לשחזר את כל האובייקטים השלמים שכן הגיעו
      const text2 = jsonMatch[0];
      const lastCompleteObjEnd = text2.lastIndexOf('},');
      if (lastCompleteObjEnd === -1) {
        return new Response(JSON.stringify({ error: 'המודל החזיר תשובה פגומה, נסו שוב' }), {
          status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      try {
        activities = JSON.parse(text2.slice(0, lastCompleteObjEnd + 1) + ']');
        truncated = true;
      } catch {
        return new Response(JSON.stringify({ error: 'המודל החזיר תשובה פגומה, נסו שוב' }), {
          status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    }

    // רשת ביטחון ברמת הקוד (לא רק בפרומפט) - תאריך חד-פעמי שכבר עבר לא רלוונטי יותר,
    // גם אם המודל בכל זאת החזיר אותו.
    const todayStr = new Date().toISOString().slice(0, 10);
    activities = activities.filter((a: any) => (
      !(a.schedule_type === 'one_time' && a.one_time_date && a.one_time_date < todayStr)
    ));

    return new Response(JSON.stringify({ sourceUrl: parsedUrl.toString(), activities, truncated }), {
      status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'שגיאה לא צפויה' }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
