// TuRu - עותק Node/CommonJS מדויק של supabase/functions/_shared/placeholderGroup.ts (Deno) -
// אותו עיקרון-שכפול-מכוון כמו playgroundNaming.js/cityNaming.js (שני runtimes לא יכולים
// לחלוק קובץ אחד). כל שינוי כאן דורש שינוי מקביל שם, ולהפך.

const DIRECT_MAP = {
  'גן שעשועים': 'PLAY_AND_FUN', "ג'ימבורי": 'PLAY_AND_FUN', 'משחקייה': 'PLAY_AND_FUN',
  'פארק שעשועים': 'PLAY_AND_FUN', 'טרמפולינות': 'PLAY_AND_FUN',

  'חווה': 'NATURE_AND_ANIMALS', 'פינת חי': 'NATURE_AND_ANIMALS', 'בעלי חיים': 'NATURE_AND_ANIMALS',
  'טבע': 'NATURE_AND_ANIMALS',

  'סדנה': 'CULTURE_CREATIVITY', 'הצגה': 'CULTURE_CREATIVITY', 'מוזיאון לילדים': 'CULTURE_CREATIVITY',
  'יצירה': 'CULTURE_CREATIVITY', 'מוזיקה': 'CULTURE_CREATIVITY', 'ריקוד': 'CULTURE_CREATIVITY',
  'בישול': 'CULTURE_CREATIVITY', 'מדע': 'CULTURE_CREATIVITY', 'שעת סיפור': 'CULTURE_CREATIVITY',
  'ספרייה': 'CULTURE_CREATIVITY', 'קולנוע לילדים': 'CULTURE_CREATIVITY', 'פעילות עירונית': 'CULTURE_CREATIVITY',
  'פעילות קהילתית': 'CULTURE_CREATIVITY',

  'ספורט': 'SPORTS_ADVENTURE', 'בריכה': 'SPORTS_ADVENTURE', 'פעילות מים': 'SPORTS_ADVENTURE',
};

const AMBIGUOUS_CATEGORIES = new Set(['פארק', 'אטרקציה', 'אחר', 'הפעלה', 'חוג', 'קייטנה']);

const KEYWORD_GROUPS = [
  { group: 'SPORTS_ADVENTURE', keywords: [
    "נינג'ה", 'טיפוס', 'קיר טיפוס', 'חבלים', 'טרקטורון', "ריינג'ר", 'רייזר', 'באגי', 'אתגר',
    'אקסטרים', 'אדרנלין', 'לייזר טאג', 'לייזר גיים', 'קליעה', 'חץ וקשת', 'מצנח', 'רחיפה',
    'חדר בריחה', 'חדרי בריחה', 'ספורט', 'כדורסל', 'כדורגל', 'פארק אקסטרים', 'סקייטפארק', 'סקייט פארק',
  ] },
  { group: 'NATURE_AND_ANIMALS', keywords: [
    'טבע', 'נחל', 'שמורה', 'גן לאומי', 'יער', 'ספארי', 'פינת חי', 'חווה', 'בעלי חיים', 'גן חיות',
    'חיות', 'ציפורים', 'בוטני', 'מצפור', 'אקולוגי', 'חקלאות', 'עולם המימי', 'ימי',
  ] },
  { group: 'CULTURE_CREATIVITY', keywords: [
    'מוזיאון', 'הצגה', 'תיאטרון', 'קולנוע', 'גלריה', 'תערוכה', 'הופעה', 'סדנה', 'יצירה',
    'קוסם', 'קסמים', 'סיפור', 'ספרייה', 'מדע', 'בישול', 'קולינרי', 'יריד אמנים',
  ] },
  { group: 'PLAY_AND_FUN', keywords: [
    'שעשועים', 'משחקים', 'משחקייה', 'טרמפולינ', "ג'ימבורי", 'מיני גולף', 'רכבת ילדים',
    'קרנבל', 'מתנפח', 'בילוי', 'אטרקציות',
  ] },
];

function classifyByKeywords(text) {
  const lower = text.toLowerCase();
  for (const { group, keywords } of KEYWORD_GROUPS) {
    if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) return group;
  }
  return null;
}

const FALLBACK_GROUP = 'PLAY_AND_FUN';

function classifyPlaceholderGroup({ category, name, description }) {
  if (category && DIRECT_MAP[category]) return DIRECT_MAP[category];
  if (!category || AMBIGUOUS_CATEGORIES.has(category) || !DIRECT_MAP[category]) {
    const text = [name, description].filter(Boolean).join(' ');
    const byKeyword = text ? classifyByKeywords(text) : null;
    if (byKeyword) return byKeyword;
  }
  return FALLBACK_GROUP;
}

module.exports = { classifyPlaceholderGroup };
