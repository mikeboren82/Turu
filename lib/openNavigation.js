import { Linking } from 'react-native';

// חולץ מ-app/activity/[id].js (openNavigation מקומית) כדי שגם כרטיסי "היעדים שלי" ישתמשו
// באותו קישור בדיוק - חיפוש Google Maps לפי שם+מיקום (לא קואורדינטות, כי לא לכל פעילות יש
// lat/lng, והחיפוש-בשם עדיין עובד היטב כשיש).
export function openNavigationTo({ title, locationName, city }) {
  const query = encodeURIComponent(`${title}, ${locationName || ''} ${city || ''}`.trim());
  Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${query}`);
}
