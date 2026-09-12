import { Linking } from 'react-native';

// חולץ מ-app/activity/[id].js (openNavigation מקומית) כדי שגם כרטיסי "היעדים שלי" ישתמשו
// באותו קישור בדיוק. בעבר תמיד חיפוש-בשם (טקסט חופשי) - נמצא בפועל (דיווח משתמש, 2026-09-14)
// שזה לא אמין: "ארץ עוץ" (שם גנרי-משותף) שלח משתמש לחריש במקום פרדסיה, כי Google Maps מפרש
// query טקסטואלי כחיפוש-עסקים רגיל שיכול להתאים למקום אחר לגמרי עם שם דומה/זהה. עכשיו: אם יש
// lat/lng אמיתיים (רוב הפעילויות - ראו lib/activities.js mapActivityRow) שולחים אותם ישירות
// כ-query ("lat,lng") - Google Maps מזהה את הפורמט הזה כנקודה מדויקת, לא כחיפוש טקסט, ופותח
// בדיוק שם. חיפוש-בשם נשאר fallback רק לפעילויות בלי קואורדינטות בכלל.
export function openNavigationTo({ title, locationName, city, lat, lng }) {
  const query = lat != null && lng != null
    ? `${lat},${lng}`
    : `${title}, ${locationName || ''} ${city || ''}`.trim();
  Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`);
}
