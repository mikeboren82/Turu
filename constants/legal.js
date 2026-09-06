// מקור אמת יחיד לגרסאות המסמכים המשפטיים - עדכון גרסה (למשל ל-"1.1") נעשה כאן בלבד,
// בלי צורך לחפש בקוד. שינוי כאן לא "מהגר" בעצמו הסכמות ישנות - הן פשוט ייחשבו כלא-עדכניות
// (ראו lib/legal.js, recordLegalConsentIfNeeded).
export const TERMS_VERSION = '1.0';
export const PRIVACY_VERSION = '1.0';

// תאריך "עדכון אחרון" המוצג בשני המסמכים - לעדכן ידנית כשמעדכנים את הטקסט המשפטי בפועל.
export const LEGAL_LAST_UPDATED = '06.09.2026';

// כתובת יצירת הקשר האמיתית שהאפליקציה כבר משתמשת בה היום (CONTACT_EMAIL ב-
// supabase/functions/send-contact-email) - לא כתובת חדשה/מומצאת.
export const LEGAL_CONTACT_EMAIL = 'mborenmusic@gmail.com';

// שם בעל השירות - נכון לעכשיו אין ישות עסקית רשומה בקוד/בפרויקט, אז נעשה שימוש בשם
// המוצר עצמו. יש להחליף לשם עוסק/חברה רשמי אם וכשיירשם (ראו סיכום המשימה).
export const LEGAL_ENTITY_NAME = 'תורו (TuRu)';
