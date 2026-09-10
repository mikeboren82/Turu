// TuRu - Edge Function ל"הוספת פעילות" ע"י משתמשי קצה: מקבלת קישור, שולפת את תוכן העמוד
// ומחלצת ממנו פעילות מובנית באמצעות Claude - אותה לוגיקה בדיוק כמו tools/import-tool/server.js
// (scrapeAndExtract), רק שרצה בענן כדי שלא תהיה תלות במחשב של המנהל. המשתמש מקבל את התוצאה
// לעריכה חופשית ומאשר בעצמו - שום דבר לא נשמר כאן, ה-function רק מחלצת ומחזירה.
//
// הפרומפט/פרסור-התשובה/חילוץ-התמונות משותפים עם scan-source (הסריקה האוטומטית) דרך
// _shared/extraction.ts - ריפקטור פנימי בלבד, אין שינוי בהתנהגות/contract החיצוני של הפונקציה
// הזו לעומת הגרסה הקודמת.

import { createClient } from 'npm:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk@0.32';
import * as cheerio from 'npm:cheerio@1.0.0';
import {
  buildExtractionSystemPrompt, extractCandidateImages, parseExtractionResponse,
  filterPastOneTimeActivities,
} from '../_shared/extraction.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TuruBot/1.0)' },
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
    let activities: unknown[];
    let truncated: boolean;
    try {
      ({ activities, truncated } = parseExtractionResponse(raw));
    } catch (err) {
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'המודל החזיר תשובה פגומה, נסו שוב' }), {
        status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    activities = filterPastOneTimeActivities(activities as never[], todayStr);

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
