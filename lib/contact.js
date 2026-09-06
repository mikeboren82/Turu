import { supabase } from './supabase';

// שולחת מייל בפועל (דרך Edge Function + Resend) במקום לפתוח אפליקציית מייל במכשיר.
export async function sendContactMessage(email, message) {
  const { data, error } = await supabase.functions.invoke('send-contact-email', { body: { email, message } });
  if (error) {
    // FunctionsHttpError נותן הודעה גנרית - הפרטים האמיתיים יושבים בגוף התשובה עצמו
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
  return data;
}
