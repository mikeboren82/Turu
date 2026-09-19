// 🏠 לוגיקה טהורה (בלי React) שתומכת בייצוב-התנהגות של עמוד הבית, לפני ה-refactor המבני
// (ראו הביקורת הארכיטקטונית): שלוש הכרעות קטנות ונפרדות, שכל אחת מהן הייתה קודם מוטמעת בתוך
// app/index.js עצמו בלי להיות ניתנת לבדיקה עצמאית. שום דבר כאן לא נוגע ב-UI/state של React -
// כל פונקציה מקבלת קלט מפורש ומחזירה פלט, בלי side-effects, כדי שאפשר יהיה לבדוק אותה עם
// node --test בלי תשתית-בדיקה חדשה (jest/testing-library).

// --- 1. ניווט בסרגל התחתון (components/BottomNav.js) ---
// שלב א' (מקורי) תיקן רק את "בית": router.push('/') תמיד דחף מופע-Home חדש למחסנית, גם כש-Home
// כבר קיים בה - אומת בדפדפן: ספירת מופעי-Home מחוברים ל-DOM (כולל מוסתרים) גדלה בלי-גבול על
// פני סבבי "פעילויות→בית" חוזרים. router.dismissTo (מיפוי-1:1 ל-event:'POP_TO' ב-StackRouter,
// node_modules/@react-navigation/routers/.../StackRouter.js) הוא הפעולה הנכונה: סורק אחורה על
// פני המחסנית לחיפוש מסך קיים בשם הזה, ואם נמצא חותך את המחסנית עד אליו ומחזיר את אותו route-
// instance בדיוק (לא remount). router.navigate נבדק ונמצא *לא מספיק* - NAVIGATE-רגיל מזהה-קיים
// רק כש-היעד==המסך הנוכחי עצמו, לא מסך-אחר-שכבר-במחסנית.
//
// שלב ב' (2026-09-19, בקשת-אימות ממוקדת: "does repeated navigation among [Activities/Saved/
// Profile] cause the same practical stack/instance accumulation problem?") - נבדק בדפדפן, לא
// הונח: אותה בעיה בדיוק קיימת גם בשאר פריטי-הסרגל, לא רק ב-"בית":
//   - "פעילויות" (app/activities.js): useEffect(() => {...}, []) קבוע-mount (לא useFocusEffect)
//     קורא ל-fetchApprovedActivities - אותה פונקציית-קטלוג-כבד-מדף בדיוק כמו Home. נמדד: ספירת
//     "כל הפעילויות" ב-DOM גדלה 1→2→3 על פני 2 סבבי "פרופיל→פעילויות", ומספר קריאות-ה-fetch
//     בפועל ל-/rest/v1/activities?status=eq.approved גדל 9→10→11→13 (כל מופע חדש מריץ מחדש
//     את כל לולאת-הpagination העצמאית שלו) - זהה במהות לבאג-ה-fetch המקורי של Home.
//   - "פרופיל" (app/profile.js): ספירת "עדיין לא מחוברים" ב-DOM גם גדלה 1→2→3 באותם סבבים -
//     אותה הצטברות-מופעים, כולל (לפי app/profile.js/components/Header.js, מרונדר בכל מסך)
//     מנוי supabase.auth.onAuthStateChange עצמאי לכל מופע-Header ש"נדבק" חי גם הוא, בלי unsubscribe
//     (cleanup רץ רק ב-unmount אמיתי, שלא קורה כש-push משאיר את המסך הקודם מוסתר-אך-מחובר).
//   - "שמורים" (app/my-things.js): לא נגיש דרך הסרגל למשתמש-אורח (BottomNav.js חוסם עם
//     LoginRequiredModal לפני שקורא בכלל ל-router.push) - לא נמדד ישירות (אין credentials
//     לבדיקה כמשתמש מחובר בסביבה הזו), אבל המנגנון (אותו push גנרי על אותו <Stack> שטוח, ראו
//     handlePress למטה) זהה-במבנה לחלוטין לשני האחרים - אין שום קוד-ייחודי-למסך שמונע ממנו
//     להצטבר באותה צורה בדיוק עבור משתמש מחובר.
//   - Back אחרי כמה מעברי-סרגל: נבדק - עובד טכנית (לא נשבר/קורס), אבל "נסוג" דרך *כל* לחיצת-
//     סרגל שנעשתה בנפרד (7 לחיצות-Back כדי לחזור להתחלה אחרי 3 סבבי פעילויות/פרופיל) - לא
//     סמנטיקת-טאבים רגילה ("Back אמור להרגיש אינטואיטיבי" בבקשה המקורית).
// מסקנה: זו לא "עקביות ארכיטקטונית גרידא" (שהבקשה הזו במפורש אסרה "לתקן רק בשביל") - זה אותו
// class-של-באג מדיד, בשני מתוך שלושה יעדים שניתן היה למדוד ישירות, ובעל אותו מנגנון-שורש
// בדיוק בשלישי. המדיניות המינימלית-העקבית: כל פריטי-הסרגל (כולל "בית") משתמשים ב-dismissTo -
// לא עוד ענף-החלטה per-item (היה כאן resolveBottomNavAction עם שני מקרים; עכשיו יש רק פעולה
// אחת לכולם, אז הפונקציה שהבחינה ביניהן הוסרה - components/BottomNav.js קורא ל-router.dismissTo
// ישירות, בלי needing עוד "resolve" את הפעולה מה-key).

// --- 2. אתחול-ברירות-מחדל של Home מול "רענון-במיקוד" (useFocusEffect) ---
// הבאג שאותר: ה-focus effect (app/index.js) טוען prefs.defaultHomeFilters/ילדים-נבחרים בכל
// חזרה-למיקוד של Home, לא רק בפעם הראשונה - מה שדורס בחירות מפורשות שהמשתמש כבר עשה ב"בחירה
// מהירה" באותו session (לדוגמה: שינה מיקום מ-ינוב לנתניה, חיפש, לחץ Back - ואז ה-focus effect
// שדרס את זה בחזרה לינוב). הכלל המוצרי: ברירות-מחדל שמורות הן נתוני-אתחול (מאתחלות session
// חדש), לא נתונים שדורסים עריכה פעילה. shouldApplyHomeDefaults מכריעה את זה ע"פ דגל בודד -
// "האם כבר אתחלנו את ה-session הזה פעם אחת" (ref שחי לכל אורך חיי מופע ה-HomeScreen, לא state -
// אין צורך שישפיע על רינדור). true פעם אחת בלבד למופע-Home נתון; אחרי זה false לתמיד, גם אם
// המשתמש מתנתק/מתחבר מחדש/עורך את ברירת-המחדל השמורה שלו בפרופיל תוך כדי - כל אלה לא אמורים
// לדרוס עריכה פעילה רק כי Home חזר למיקוד. הנתונים ש*כן* אמורים להמשיך להתרענן בכל מיקוד
// (session/flags/notes/children/excludedCategories/excludedCities/excludedRegions/benefitClubs/
// visibleHomeFilters) לא עוברים דרך הפונקציה הזו כלל - הם אף פעם לא היו "בחירה מפורשת שנעשתה
// ב-Home עצמו", אז אין להם את אותה בעיה (ראו ההערה המלאה ב-app/index.js ליד ה-effect עצמו).
export function shouldApplyHomeDefaults(alreadyInitialized) {
  return !alreadyInitialized;
}

// --- 3. הפרדת קרוסלת-הגילוי מטיוטת "בחירה מהירה" ---
// הבאג שאותר: קרוסלת-ההמלצות (recommendations, app/index.js) דירגה עד עכשיו לפי אותו filters
// שגם "בחירה מהירה" עורכת בלייב - כך שבחירת קטגוריה/מיקום חדשים בפאנל, עוד *לפני* לחיצה על
// "מצאו פעילויות", כבר שינתה את הקרוסלה שמתחתיו. buildCarouselFilters בונה את קבוצת-הפילטרים
// הנפרדת שהקרוסלה משתמשת בה בפועל:
//   - category: תמיד [] - הקרוסלה היא תוכן-גילוי כללי של Home, לא "קרוסלת-מוזיאונים" זמנית
//     כי זה מה שנבחר עכשיו ב"מה עושים?" הבלתי-מוגש. הבקשה לא מנתה category בין הקלטים
//     ה"לגיטימיים" שהקרוסלה כן רשאית להמשיך ולהשתמש בהם (בניגוד למיקום, ראו למטה) - אין "category
//     מחויב" מקביל ל-homeLocation, רק ריקון מוחלט.
//   - location: homeLocation (המיקום *המחויב* - ראו resolveCommittedHomeLocation למטה) אם קיים,
//     אחרת defaultLocation (DEFAULT_FILTERS.location, "בלי מיקום" - עדיין גורם ל-!locationKnown
//     שמציג את כרטיסי-ה-Preview המטושטשים, לא שגיאה).
//   - כל שאר השדות (age/when/hour/price/placeType/וכו') מגיעים כמו שהם מ-filters הרגיל: הם
//     אף פעם לא ניתנים לעריכה-מיידית מתוך Home עצמו (רק דרך handleAdvancedFilters שמנווט
//     ל-/activities, או דרך toggleChild שמעדכן age לפי גילאי-הילדים *הנבחרים* - "personalization
//     לגיטימית", בדיוק כמו שהבקשה מתירה "child ages"), אז אין להם את אותה בעיית-טיוטה בכלל.
export function buildCarouselFilters(filters, homeLocation, defaultLocation) {
  return { ...filters, category: [], location: homeLocation || defaultLocation };
}

// מיקום "מחויב" (homeLocation) מתעדכן בשתי דרכים שונות בכוונה (ראו קריאות ב-app/index.js):
//   א. "פתרון ראשוני" - הפעם הראשונה שמיקום כלשהו נודע ב-session הזה (GPS/עיר-אורח/ברירת-מחדל
//      שמורה, או הבחירה הראשונה שהמשתמש עצמו עושה כשעדיין אין שום מיקום ידוע - למשל לחיצה על
//      כרטיס-ה-Preview הנעול "בחרו מיקום") - resolveCommittedHomeLocation *לא* דורסת מיקום
//      מחויב קיים (prevHomeLocation || candidateLocation), כך שעריכת "איפה?" ב"בחירה מהירה"
//      *אחרי* שכבר יש מיקום מחויב לא "מדליפה" את הטיוטה לקרוסלה באמצעות הערוץ הזה.
//   ב. "commit מפורש" (handleGo/goToSmartSearchResults/navigateToCategoryResults) - קורא ל-
//      setHomeLocation(loc) ישירות (לא דרך הפונקציה הזו) בכל פעולת-חיפוש/ניווט מפורשת - זו
//      בדיוק הנקודה שבה "טיוטה" הופכת ל"מיקום מחויב חדש", תואם את "כשלוחצים על 'מצאו פעילויות',
//      החיפוש מתבצע כרגיל" (הבקשה לא אסרה על הקרוסלה להשתקף בהמשך אחרי commit אמיתי - רק אסרה
//      על שינוי-לייב מטיוטה לא-מוגשת).
export function resolveCommittedHomeLocation(prevHomeLocation, candidateLocation) {
  return prevHomeLocation || candidateLocation;
}

// --- 4. בניית params ל-router.push({pathname:'/activities', params}) (Home Refactor Phase 2A) ---
// הצעד הדטרמיניסטי-האחרון שכל 6 נתיבי-הניווט מ-Home ל-/activities חולקים (handleGo/
// handleAdvancedFilters/handleSpontaneous/goNearMe/navigateToCategoryResults/goToSmartSearchResults,
// כולם ב-app/index.js) - homeFilters/homeChildAges תמיד נוכחים כ-JSON.stringify, בתוספת homeCoords
// (אופציונלי) ושאר ה-flags (openFilters/spontaneous/nearMe - כל נתיב מזין לכל היותר אחד מהם).
// coordsMode משמר בכוונה שני כללי-השמטה *שונים* שכבר היו קיימים בקוד המקורי, לא מאחד אותם לכלל
// אחד: 5 מ-6 האתרים (ברירת-המחדל, 'always') תמיד כללו homeCoords, עם '' כשאין קואורדינטות;
// goToSmartSearchResults בלבד ('omit-if-absent') השמיט את המפתח *כליל* כשאין קואורדינטות - הבדל
// קיים, נבדק ונשמר במפורש (לא "ניקוי" כביכול-מיותר).
export function buildResultsParams({
  filters, coords, childAges, coordsMode = 'always', extra,
}) {
  const params = { homeFilters: JSON.stringify(filters) };
  if (coordsMode === 'always') {
    params.homeCoords = coords ? JSON.stringify(coords) : '';
  } else if (coords) {
    params.homeCoords = JSON.stringify(coords);
  }
  params.homeChildAges = JSON.stringify(childAges);
  if (extra) Object.assign(params, extra);
  return params;
}

// goToSmartSearchResults בלבד: אילו קואורדינטות (אם בכלל) מלוות ניווט חיפוש-חכם, בסדר-עדיפות
// קבוע שהיה קיים inline בקוד המקורי - קואורדינטות-כתובת שה-Edge Function עצמה זיהתה בתוך הטקסט
// (builtFilters.location.mode==='address', צורת {lat,lng} - מומרת כאן ל-{latitude,longitude} כמו
// שאר האפליקציה מצפה), אחרת deviceCoords הרגיל (GPS/עיר-אורח) אם ידוע, אחרת undefined (ואז
// buildResultsParams עם coordsMode:'omit-if-absent' משמיט את homeCoords כליל - לא '').
export function resolveSmartSearchCoords(builtFilters, deviceCoords) {
  if (builtFilters.location?.mode === 'address' && builtFilters.location.coords) {
    return {
      latitude: builtFilters.location.coords.lat, longitude: builtFilters.location.coords.lng,
    };
  }
  return deviceCoords || undefined;
}
