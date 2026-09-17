// SOCIAL content semantics (brief §66-§70, §92) - fixtures, no live platform access.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifySocialItem, resolveRelativeDates, israelDate, associateWithCanonical, toPipelinePage, type SocialItem } from "./socialContent.ts";
import { distinctiveSharedWords } from "./matching.ts";

const post = (caption: string, publishedAt: string, extra: Partial<SocialItem> = {}): SocialItem => ({ platform: "instagram", account: "venue_il", permalink: "https://www.instagram.com/p/ABC123/", caption, publishedAt, ...extra });
// 2026-09-17 is a Thursday
const THU = "2026-09-17T09:00:00+03:00";

Deno.test("relative dates resolve against the POST's publication time in Israel - never against scan time", () => {
  assertEquals(resolveRelativeDates("מחר אצלנו הצגת ילדים", THU).map((d) => d.date), ["2026-09-18"]);
  assertEquals(resolveRelativeDates("היום ב-17:00 שעת סיפור", THU)[0].date, "2026-09-17");
  assertEquals(resolveRelativeDates("ביום שישי הקרוב הפנינג", THU)[0].date, "2026-09-18");
  assertEquals(resolveRelativeDates("ביום ראשון סדנת יצירה", THU)[0].date, "2026-09-20");
  assertEquals(resolveRelativeDates("בסופ\"ש מחכים לכם", THU).map((d) => d.date), ["2026-09-18", "2026-09-19"]);
  assertEquals(resolveRelativeDates("הצגה ב-25.9 וגם ב 3/10/2026", THU).map((d) => d.date), ["2026-09-25", "2026-10-03"]);
  assertEquals(resolveRelativeDates("ניפגש ב-5 בינואר", THU)[0].date, "2027-01-05", "no year: the first such date after publication");
  // a post published 23:30 UTC on the 16th is already the 17th in Israel -> "מחר" is the 18th
  assertEquals(israelDate("2026-09-16T23:30:00Z"), "2026-09-17");
  assertEquals(resolveRelativeDates("מחר!", "2026-09-16T23:30:00Z")[0].date, "2026-09-18");
});

Deno.test("an OLD post that says 'מחר' is EXPIRED - it never becomes a future event today", () => {
  const old = post("מחר אצלנו הצגת ילדים לכל המשפחה, כניסה חופשית! מוזמנים", "2026-08-02T10:00:00+03:00");
  const v = classifySocialItem(old, "2026-09-17");
  assertEquals(v.klass, "EXPIRED"); assertEquals(v.dates[0].date, "2026-08-03"); assertEquals(v.nextDate, null);
  // the very same caption published yesterday is a live candidate for today
  const fresh = classifySocialItem(post(old.caption, "2026-09-16T10:00:00+03:00"), "2026-09-17");
  assertEquals(fresh.klass, "ACTIVITY_CANDIDATE"); assertEquals(fresh.nextDate, "2026-09-17");
});

Deno.test("not every post is an activity: marketing, staff, greetings, recaps and image-only posts are IRRELEVANT", () => {
  for (const c of ["דרושים עובדים למשמרות ערב בקניון! שלחו קורות חיים", "חג שמח ושנה טובה לכל הלקוחות שלנו מכל צוות הקניון", "סייל סוף עונה! 50% הנחה על כל הקולקציה בחנויות נבחרות", "תודה לכל מי שהגיע אתמול, היה מדהים! תמונות מהאירוע בסטורי", "📸"])
    assertEquals(classifySocialItem(post(c, THU), "2026-09-17").klass, "IRRELEVANT", c);
});

Deno.test("a valid event, an ambiguous date, an update and a cancellation are told apart", () => {
  assertEquals(classifySocialItem(post("הצגת ילדים 'פיטר פן' ביום שישי 25.9 בשעה 11:00 באולם המרכזי. כרטיסים בקישור בביו", THU), "2026-09-17").klass, "ACTIVITY_CANDIDATE");
  const amb = classifySocialItem(post("סדנת יצירה מיוחדת לילדים מחכה לכם אצלנו, בהרשמה מראש! כל הפרטים בתמונה", THU), "2026-09-17");
  assertEquals(amb.klass, "AMBIGUOUS"); assert(amb.reason.includes("SOCIAL_AMBIGUOUS_DATE"));
  assertEquals(classifySocialItem(post("שימו לב! שינוי בשעה: הצגת פיטר פן ביום שישי 25.9 עברה ל-12:00", THU), "2026-09-17").klass, "UPDATE");
  assertEquals(classifySocialItem(post("לצערנו ההצגה פיטר פן ב-25.9 בוטלה. כרטיסים יוחזרו", THU), "2026-09-17").klass, "CANCELLATION");
  assertEquals(classifySocialItem(post("פעילות לילדים בקרוב אצלנו, מוזמנים להתעדכן", "2026-08-01T10:00:00+03:00"), "2026-09-17").klass, "EXPIRED", "undated and six weeks old");
});

Deno.test("update / cancellation association: exactly ONE strongly tied canonical event, otherwise no write", () => {
  const v = classifySocialItem(post("לצערנו ההצגה פיטר פן ב-25.9 בוטלה. כרטיסים יוחזרו", THU), "2026-09-17");
  const caption = "לצערנו ההצגה פיטר פן ב-25.9 בוטלה. כרטיסים יוחזרו";
  const events = [{ id: "e1", name: "פיטר פן - הצגת ילדים", dates: ["2026-09-25"], samePublisher: true }, { id: "e2", name: "עליסה בארץ הפלאות - הצגת ילדים", dates: ["2026-09-25"], samePublisher: true }];
  assertEquals(associateWithCanonical(v, caption, events, distinctiveSharedWords).eventId, "e1");
  // the same title from ANOTHER publisher is not this publisher's event
  assertEquals(associateWithCanonical(v, caption, [{ ...events[0], samePublisher: false }], distinctiveSharedWords).confidence, "NONE");
  // a vague "ההצגה בוטלה" names nothing distinctive -> never cancels anything
  const vague = classifySocialItem(post("לצערנו ההצגה של יום שישי בוטלה, מתנצלים", THU), "2026-09-17");
  const a = associateWithCanonical(vague, "לצערנו ההצגה של יום שישי בוטלה, מתנצלים", events, distinctiveSharedWords);
  assertEquals(a.eventId, null); assert(a.reason.includes("UNCERTAIN"));
  // two events of that title on that publisher -> uncertain, not a guess
  const twins = [events[0], { id: "e3", name: "פיטר פן - המחזמר", dates: ["2026-09-25"], samePublisher: true }];
  assertEquals(associateWithCanonical(v, caption, twins, distinctiveSharedWords).eventId, null);
});

Deno.test("the pipeline page states what the model must not guess; a venue is asserted only for a VERIFIED publisher", () => {
  const item = post("מחר ב-17:00 שעת סיפור לילדים, כניסה חופשית", THU);
  const v = classifySocialItem(item, "2026-09-17");
  const page = toPipelinePage(item, v, { name: "ספריית העיר", venueName: "ספריית העיר", city: "רעננה", verified: true });
  assertEquals(page.url, item.permalink, "the permalink is the provenance url");
  assert(page.text.includes("תאריך פרסום הפוסט: 2026-09-17")); assert(page.text.includes("מחר = 2026-09-18")); assert(page.text.includes("ספריית העיר, רעננה"));
  const unverified = toPipelinePage(item, v, { name: "חשבון כלשהו", venueName: "ספריית העיר", city: "רעננה", verified: false });
  assert(!unverified.text.includes("מקום ברירת-מחדל"), "an unverified account never implies a venue or an address");
});
