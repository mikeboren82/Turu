-- WABBIT - מוסיף סטטוס 'archived' לפעילויות: פעילויות שקיימות במאגר אבל לא מוצגות באפליקציה
-- מסיבות מדיניות (כרגע: כל מה שמצריך הרשמה/התחייבות במקום ביקור חופשי - חוגים וכו'),
-- בשונה מ-'rejected' שנשאר מיועד לפסילה בגלל איכות/רלוונטיות ירודה.
alter table public.activities drop constraint if exists activities_status_check;
alter table public.activities add constraint activities_status_check
  check (status in ('pending', 'approved', 'rejected', 'archived'));
