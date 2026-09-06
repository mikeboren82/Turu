// TuRu - Edge Function שמאפשרת לאדמין (מכלי הניהול, tools/import-tool) לשלוח תשובה בפועל
// למשתמש שכתב ב"צרו קשר", ולסמן את הפנייה כ"נענתה" ב-contact_messages. מעביר הלאה את
// ה-Authorization header של הקורא (בדיוק כמו extract-activity) כדי ש-RLS על contact_messages
// (0026: is_admin() או is_trusted_uploader()) יאכוף בעצמו מי מורשה - אין פה בדיקת הרשאה
// ידנית כפולה.

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonResponse({ error: 'לא מחובר' }, 401);

    const { messageId, replyText } = await req.json();
    if (!messageId || typeof messageId !== 'string') return jsonResponse({ error: 'חסר מזהה הודעה' }, 400);
    if (!replyText || typeof replyText !== 'string' || !replyText.trim()) return jsonResponse({ error: 'חסר תוכן תשובה' }, 400);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: original, error: fetchErr } = await supabase
      .from('contact_messages')
      .select('id, email')
      .eq('id', messageId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    // maybeSingle מחזיר null גם כשההודעה קיימת אבל ה-RLS חוסמת קריאה (לא אדמין/importer) -
    // אין דרך להבדיל, וזה בסדר: בשני המקרים התשובה הנכונה היא "אין הרשאה", לא לחשוף מידע.
    if (!original) return jsonResponse({ error: 'ההודעה לא נמצאה, או שאין הרשאה' }, 404);

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return jsonResponse({ error: 'שליחת מייל לא מוגדרת בצד השרת (חסר RESEND_API_KEY)' }, 500);

    const cleanReply = replyText.trim();
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'TuRu תורו <onboarding@resend.dev>',
        to: [original.email],
        subject: 'תשובה לפנייה שלכם - TuRu תורו',
        html: `<div dir="rtl" style="font-family: Arial, sans-serif; font-size: 15px; line-height: 1.6;">` +
          `<p>${escapeHtml(cleanReply).replace(/\n/g, '<br>')}</p>` +
          `</div>`,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Resend error:', res.status, errText);
      return jsonResponse({ error: 'שליחת המייל נכשלה, נסו שוב מאוחר יותר' }, 502);
    }

    const { error: updateErr } = await supabase
      .from('contact_messages')
      .update({ status: 'replied', admin_reply: cleanReply, replied_at: new Date().toISOString() })
      .eq('id', messageId);
    if (updateErr) throw updateErr;

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : 'שגיאה לא צפויה' }, 500);
  }
});
