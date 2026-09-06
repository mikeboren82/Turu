import { supabase } from './supabase';

// בודקת אם המשתמש חסום, ואם כן - מנתקת אותו מיד. נקראת בכל נקודת כניסה לאפליקציה
// (קוד SMS, PIN, טביעת אצבע) כדי שחסימה תיכנס לתוקף גם למי שכבר יש לו כניסה מהירה על המכשיר.
export async function enforceNotBanned(userId) {
  const { data, error } = await supabase.from('profiles').select('banned').eq('id', userId).maybeSingle();
  if (error || !data?.banned) return false;
  await supabase.auth.signOut();
  return true;
}
