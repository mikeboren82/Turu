// TuRu - Edge Function לטופס "צור קשר": שולחת מייל בפועל (דרך Resend) במקום לפתוח
// אפליקציית מייל במכשיר של המשתמש, וגם שומרת את הפנייה ב-contact_messages (0026) כדי שתופיע
// בפינת הניהול "הודעות ממשתמשים" - לא דורשת התחברות, הטופס פתוח גם לאורחים.

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CONTACT_EMAIL = 'mborenmusic@gmail.com';
const MAX_MESSAGE_LENGTH = 5000;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const { email, message } = await req.json();

    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return jsonResponse({ error: 'כתובת אימייל לא תקינה' }, 400);
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return jsonResponse({ error: 'חסרה הודעה' }, 400);
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return jsonResponse({ error: 'ההודעה ארוכה מדי' }, 400);
    }

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) {
      return jsonResponse({ error: 'שליחת מייל לא מוגדרת בצד השרת (חסר RESEND_API_KEY)' }, 500);
    }

    const cleanEmail = email.trim();
    const cleanMessage = message.trim();

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'TuRu <onboarding@resend.dev>',
        to: [CONTACT_EMAIL],
        reply_to: cleanEmail,
        subject: 'פנייה חדשה מהאפליקציה - TuRu',
        html: `<div dir="rtl" style="font-family: Arial, sans-serif; font-size: 15px; line-height: 1.6;">` +
          `<p><b>מאת:</b> ${escapeHtml(cleanEmail)}</p>` +
          `<p><b>הודעה:</b></p>` +
          `<p>${escapeHtml(cleanMessage).replace(/\n/g, '<br>')}</p>` +
          `</div>`,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Resend error:', res.status, errText);
      return jsonResponse({ error: 'שליחת המייל נכשלה, נסו שוב מאוחר יותר' }, 502);
    }

    // שמירה ב-DB - בכוונה best-effort ולא חוסמת: אם זה נכשל, המייל כבר יצא בהצלחה,
    // אין סיבה להראות למשתמש שגיאה על משהו שהוא לא אחראי עליו.
    try {
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!);
      await supabase.from('contact_messages').insert({ email: cleanEmail, message: cleanMessage });
    } catch (dbErr) {
      console.error('שמירת הפנייה ב-DB נכשלה (המייל כן נשלח):', dbErr);
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : 'שגיאה לא צפויה' }, 500);
  }
});
