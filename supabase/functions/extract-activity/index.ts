// TuRu - Edge Function ל"הוספת פעילות" ע"י משתמשי קצה: מקבלת קישור, שולפת את תוכן העמוד
// ומחלצת ממנו פעילות מובנית באמצעות Claude - אותה לוגיקה בדיוק כמו tools/import-tool/server.js
// (scrapeAndExtract), רק שרצה בענן כדי שלא תהיה תלות במחשב של המנהל. המשתמש מקבל את התוצאה
// לעריכה חופשית ומאשר בעצמו - שום דבר לא נשמר כאן, ה-function רק מחלצת ומחזירה.
//
// הפרומפט/פרסור-התשובה/חילוץ-התמונות/ה-fetch משותפים עם scan-source דרך _shared/extraction.ts.

import { createClient } from 'npm:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk@0.32';
import * as cheerio from 'npm:cheerio@1.0.0';
import {
  buildExtractionSystemPrompt, extractCandidateImages, parseExtractionResponse,
  filterPastOneTimeActivities, fetchHtml, pageTextForExtraction, EXTRACTION_MODEL, EXTRACTION_MAX_TOKENS,
} from '../_shared/extraction.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'צריך להתחבר כדי להשתמש בזה' }, 401);
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) return json({ error: 'צריך להתחבר כדי להשתמש בזה' }, 401);

    const { url } = await req.json();
    if (!url || typeof url !== 'string') return json({ error: 'חסר קישור' }, 400);
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) return json({ error: 'הקישור לא תקין' }, 400);

    const pageRes = await fetchHtml(parsedUrl.toString(), { timeoutMs: 20000, retries: 1 });
    if (!pageRes.ok || !pageRes.html) {
      return json({ error: `לא הצלחנו לטעון את הדף (${pageRes.status ? 'סטטוס ' + pageRes.status : pageRes.fetchError || 'שגיאת רשת'})` }, 502);
    }
    const $ = cheerio.load(pageRes.html);
    const candidateImages = extractCandidateImages($, parsedUrl.toString());
    const text = pageTextForExtraction($);
    if (!text) return json({ error: 'לא מצאנו טקסט קריא בעמוד הזה' }, 422);

    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
    const message = await anthropic.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: EXTRACTION_MAX_TOKENS,
      system: buildExtractionSystemPrompt(),
      messages: [{
        role: 'user',
        content: `כתובת המקור: ${parsedUrl.toString()}\n\nתוכן הדף:\n${text}\n\nרשימת תמונות מהעמוד:\n${JSON.stringify(candidateImages)}`,
      }],
    });

    const raw = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    let activities: unknown[];
    let truncated: boolean;
    try {
      ({ activities, truncated } = parseExtractionResponse(raw));
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'המודל החזיר תשובה פגומה, נסו שוב' }, 502);
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    activities = filterPastOneTimeActivities(activities as never[], todayStr);

    return json({ sourceUrl: parsedUrl.toString(), activities, truncated }, 200);
  } catch (err) {
    console.error(err);
    return json({ error: err instanceof Error ? err.message : 'שגיאה לא צפויה' }, 500);
  }
});
