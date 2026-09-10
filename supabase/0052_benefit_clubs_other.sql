-- TuRu - כשמשתמש בוחר "אחר" ברשימת המועדונים/כרטיסים שלו ("🎟️ ההטבות שלי" בפרופיל), נותנים לו
-- למלא בעצמו טקסט חופשי (למשל "כרטיס חבר של הפועל תל אביב") - שדה תיאורי בלבד, לא משתתף
-- בהתאמת הטבות (lib/benefits.js עדיין משווה רק לפי benefit_clubs.includes(provider), "אחר"
-- ממשיך להתאים לכל activity_benefits.provider='אחר' כרגיל) - רק כדי שהמשתמש יזכור/יראה מה יש לו.
alter table public.profiles add column if not exists benefit_clubs_other text;
