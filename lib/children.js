import { AGE_OPTIONS } from '../constants/filterSchema';

// גיל מחושב מתאריך לידה בכל טעינה (לא מאוחסן) - זו הסיבה שביקשנו תאריך לידה ולא גיל שטוח:
// גיל שנשמר "קופא" בזמן, תאריך לידה נשאר נכון תמיד. מתחת לשנה מחזירים חודשים.
export function calculateAge(birthdate) {
  if (!birthdate) return null;
  const birth = new Date(birthdate);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let years = now.getFullYear() - birth.getFullYear();
  const beforeBirthdayThisYear = (
    now.getMonth() < birth.getMonth()
    || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())
  );
  if (beforeBirthdayThisYear) years--;
  if (years < 1) {
    let months = (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth());
    if (now.getDate() < birth.getDate()) months--;
    return { years: 0, months: Math.max(0, months) };
  }
  return { years, months: 0 };
}

const HEBREW_ORDINAL_YEARS = { 1: 'שנה', 2: 'שנתיים' };

function yearsPhrase(years) {
  return HEBREW_ORDINAL_YEARS[years] || `${years}`;
}

// "בן שנתיים"/"בת 5" - עם gender; "גיל 3" ניטרלי בלי gender (לא חובה לספק אותו).
export function formatChildAge(child) {
  const age = calculateAge(child?.birthdate);
  if (!age) return '';
  if (age.years === 0) {
    const m = age.months;
    return child.gender === 'female' ? `בת ${m} חודשים` : child.gender === 'male' ? `בן ${m} חודשים` : `${m} חודשים`;
  }
  const phrase = yearsPhrase(age.years);
  if (child.gender === 'female') return `בת ${phrase}`;
  if (child.gender === 'male') return `בן ${phrase}`;
  return `גיל ${age.years}`;
}

// ממפה גיל בשנים לטווח המתאים מתוך AGE_OPTIONS הקיים (constants/filterSchema.js) - כדי
// שהילדים יזרמו ישירות לאותו מנגנון פילטרים שכבר קיים, בלי מבנה נתונים מקביל.
export function childAgeToBand(birthdate) {
  const age = calculateAge(birthdate);
  if (!age) return null;
  const band = AGE_OPTIONS.find((o) => age.years >= o.min && age.years <= o.max);
  return band ? band.id : null;
}

// filters.age כבר מצפה למערך מזהי AGE_OPTIONS (ראו constants/filterSchema.js) - זה בדיוק
// הפלט כאן, כך שאפשר להזין ישירות ל-filters.age בלי המרה נוספת.
export function childrenToDefaultAgeFilter(children) {
  const bands = (children || []).map((c) => childAgeToBand(c.birthdate)).filter(Boolean);
  return [...new Set(bands)];
}
