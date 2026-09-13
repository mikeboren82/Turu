// TuRu - Node mirror of supabase/functions/_shared/extraction.ts assessChildRelevance (same
// two-runtime copy pattern as cityNaming/venueNaming). Keep the marker lists identical.
const ADULT_MARKERS = [
  'הרצאה', 'הרצאת', 'סטנדאפ', 'סטנד אפ', 'מנוי', 'סדרת', 'גיל הזהב', 'ותיקים', 'ותיקות', 'אזרחים ותיקים', 'גמלאים', 'פנסיונרים',
  'קפה עסקי', 'נטוורקינג', 'צ׳יקונג', "צ'יקונג", 'טאי צ׳י', "טאי צ'י", 'יוגה למבוגרים', 'פילאטיס', 'הכר את הנייד', 'סמארטפון למבוגרים',
  'ערב נשים', 'לנשים בלבד', 'מסיבת רווקים', 'טעימות יין', 'סיור יין', 'יקב', 'אלכוהול', 'בירה', 'מועדון לילה', 'קונצרט ערב', 'ישיבת מועצה',
  'קורס', 'סדנת הורים', 'הורים בלבד', 'ערב הורים', 'קבלת קהל', 'הודעה לתושבים', 'סיור מקצועי', '18+', 'למבוגרים בלבד', 'לגיל השלישי',
];
const CHILD_MARKERS = [
  'ילדים', 'ילדה', 'לילד', 'פעוט', 'תינוק', 'משפחה', 'משפחות', 'הורים וילדים', 'גיל הרך', 'גני ילדים', 'שעת סיפור', 'הצגת ילדים',
  'תיאטרון ילדים', 'סדנת יצירה', 'קטנטנים', 'בייבי', 'לכל הגילאים', 'לכל המשפחה', 'הפעלה', 'מתנפחים', 'קוסם', 'ליצן', 'בובות',
  'גילאי', 'כיתות', 'נוער', 'קייטנה', 'חופש הגדול', 'חנוכה לילדים', 'פורים', 'סוכות', 'שעשועים', 'משחקים', 'משחקייה',
];

function assessChildRelevance(candidate) {
  const text = `${candidate.name ?? ''} ${candidate.description ?? ''}`.toLowerCase();
  const hasChild = CHILD_MARKERS.some((m) => text.includes(m.toLowerCase())) || (typeof candidate.max_age === 'number' && candidate.max_age <= 18) || (typeof candidate.min_age === 'number' && candidate.min_age <= 12);
  const hasAdult = ADULT_MARKERS.some((m) => text.includes(m.toLowerCase()));
  if (candidate.audience === 'adults') return 'reject';
  if (hasAdult && !hasChild) return 'reject';
  if (candidate.audience === 'children' || candidate.audience === 'family') return hasAdult ? 'review' : 'ok';
  return hasChild ? 'ok' : 'review';
}

module.exports = { assessChildRelevance, ADULT_MARKERS, CHILD_MARKERS };
