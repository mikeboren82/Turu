// זמן יחסי בעברית ("היום"/"אתמול"/"לפני X ימים/שבועות/חודשים") - חולץ מ-app/activity/[id].js
// (שם שימש להערות קהילה) לקובץ משותף, כדי שגם עמוד "המשפחה שלי" (הערות אישיות) ישתמש באותה
// לוגיקה בדיוק בלי לשכפל אותה.
export function relativeDate(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'היום';
  if (days === 1) return 'אתמול';
  if (days < 7) return `לפני ${days} ימים`;
  if (days < 30) return `לפני ${Math.floor(days / 7)} שבועות`;
  return `לפני ${Math.floor(days / 30)} חודשים`;
}
