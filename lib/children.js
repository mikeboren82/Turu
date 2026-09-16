import { AGE_OPTIONS } from '../constants/filterSchema';
import { t } from './i18n';

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

// "בת שנתיים" / "3 years old" - gendered where the locale needs it (Hebrew), neutral otherwise.
export function formatChildAge(child) {
  const age = calculateAge(child?.birthdate);
  if (!age) return '';
  const g = child.gender === 'female' ? 'Female' : child.gender === 'male' ? 'Male' : 'Neutral';
  if (age.years === 0) return t(`domain.childAge.months${g}`, { count: age.months });
  return t(`domain.childAge.years${g}`, { count: age.years });
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
