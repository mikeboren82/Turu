// TuRu - מנרמל HTML לפני חישוב גיבוב, כדי שרעש טכני (scripts/tracking/timestamps-בתגיות, לא
// בטקסט-תוכן חופשי) לא יגרום ל"שינוי מזויף" שגורר קריאת-AI מיותרת. **לא** מנקה תאריך/טקסט
// חופשי בגוף הדף - זה תוכן אמיתי, לא רעש. רק scripts/style/הערות-HTML/attributes של tracking
// ותכונות-מזהה-אקראיות שמשתנות בכל טעינה בלי קשר לתוכן הפעילות עצמו.

// deno-lint-ignore no-explicit-any
export function normalizeHtmlForHash($: any): string {
  const $clone = $.root().clone();
  $clone.find('script, style, noscript, svg, iframe, link, meta').remove();

  // תכונות tracking/רנדומליות שמשתנות בכל טעינה - לא חלק מ"תוכן" הדף.
  $clone.find('*').each((_: number, el: any) => {
    const attribs = el.attribs || {};
    for (const name of Object.keys(attribs)) {
      if (/^data-ga|^data-gtm|^data-track|^nonce$|^data-reactid|^data-testid/.test(name)) {
        $clone.find(el).removeAttr(name);
      }
    }
  });
  // פרמטרי tracking בתוך href (utm_*, fbclid, gclid) - לא משפיעים על תוכן הדף עצמו.
  $clone.find('a[href]').each((_: number, el: unknown) => {
    const $el = $clone.find ? $(el) : null;
    if (!$el) return;
    const href = $el.attr('href');
    if (!href) return;
    try {
      const u = new URL(href, 'https://x.invalid');
      let changed = false;
      for (const key of Array.from(u.searchParams.keys())) {
        if (/^utm_|^fbclid$|^gclid$/.test(key)) { u.searchParams.delete(key); changed = true; }
      }
      if (changed) $el.attr('href', u.pathname + (u.search || ''));
    } catch { /* יחסי/לא-URL תקין - משאירים כמו שהוא */ }
  });

  return $clone.html() ?? '';
}

export async function computeContentHash(normalizedHtml: string): Promise<string> {
  const data = new TextEncoder().encode(normalizedHtml);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
