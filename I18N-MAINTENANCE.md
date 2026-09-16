# Turu i18n — maintenance guide

Turu is bilingual: **Hebrew (default, RTL)** and **English (LTR)**. Every piece of UI text goes through one
system in `lib/i18n`. This document describes that system as it is actually implemented, and how to keep it
healthy as the app grows.

---

## 1. Architecture at a glance

| Piece | Path | What it does |
|---|---|---|
| Core | `lib/i18n/index.js` | Locale store, `t()`, plurals, fallback, `useI18n()`, `createStyles()`, direction tokens, `listJoin`, `formatDate`, `formatNumber`, web `<html lang dir>` |
| Locale registry | `lib/i18n/locales/index.js` | `LOCALES` (dir, BCP-47 tag, native name, short name) and `RESOURCES` (imports every namespace JSON) |
| Strings | `lib/i18n/locales/{he,en}/<namespace>.json` | One file per namespace, identical key trees in every locale |
| Domain display helpers | `lib/i18n/format.js` | `categoryLabel`, `regionLabel`, `placeName`, `relativeDate`, `locationSummaryText`, `compactLocationText`, `categoriesSummary`, `scheduleHoursLabel`, `dayLetterLabel`, `formatKm` |
| English place names | `constants/placeNamesEn.json` | Hebrew settlement name (normalized) → canonical English name. Generated from `settlements.name_en` + manual overrides |
| Language switcher | `components/LanguageSwitcher.js` | Compact `עב \| EN` control on Home (via `Header showLanguageSwitcher`) |
| Settings row | `app/profile.js` | "Language" row (logged-in settings and logged-out card), same `setLocale` |
| Guardrails | `scripts/i18n-check.js`, `scripts/i18n-scan.js` | Key parity + hard-coded-Hebrew scanner |
| Tests | `tests/i18n.test.js` | Node tests (`npm run test:i18n`) |

### Namespaces (key counts in `he`)

`common` 34 · `domain` 175 · `nav` 40 · `home` 61 · `activities` 83 · `filters` 30 · `location` 22 ·
`activity` 155 · `saved` 68 · `profile` 143 · `auth` 88 · `pages` 32 · `legal` 138 · `contribute` 55

- `common` — shared buttons (`common.actions.*`), states (`common.states.*`), list joining, language labels, login-required defaults.
- `domain` — Turu vocabulary: categories, regions, filter option labels, filter section titles, summaries, location phrases, distances, relative time, schedule text, child ages, age/price text.
- All other namespaces belong to one screen area (see file names). Reuse `common`/`domain` before adding a new key.

---

## 2. How it works

### Locale state
- Module-level store: `getLocale()`, `setLocale(locale, { persist })`, `initLocale()`.
- Default is `he`. The choice is stored in AsyncStorage under **`turu_locale`** (localStorage on web).
- `app/_layout.js` awaits `initLocale()` before first render (no flash of the wrong language).
- `useI18n()` subscribes with `useSyncExternalStore`, so **switching language re-renders every subscribed component immediately** — no reload, no remount.

### `t(key, params)`
- Keys are dot paths starting with the namespace: `t('activities.header.count', { count })`.
- Interpolation: `{{name}}`. The same param names must exist in every locale.
- Plurals: `key_one`, `key_two` (Hebrew dual, optional), `key_other` (required). Pass `count`. Rules are hand-written in `PLURAL_RULES` (Hermes has no `Intl.PluralRules`).
- Fallback: missing in current locale → Hebrew value (and a one-time dev warning) → in dev the raw key, in production `''`.
- `t()` only resolves **string leaves** — no arrays. Model lists as keyed objects (`s1.title`, `s1.p1`, …) and keep the order in code (see `app/terms.js`).

### Where to call what
- **Components:** `const { t, dir, locale, formatDate, listJoin } = useI18n();`
- **Plain helpers called during render** (lib code): `import { t } from '../lib/i18n'` — they read the current locale at call time. Never compute display text at module load.
- **Option labels** in `constants/filterSchema.js` are **getters** (`label` resolves on access). FILTER_SCHEMA section `title`s too.
- **Activity objects** from `lib/activities.js` expose `ageRange`, `price`, `hours` as **getters**. Spreading (`{...a}`) freezes their current value → any `useMemo` that copies activities must include `locale` in its deps (see `app/activities.js`).

### Direction (RTL/LTR)
The app **does not use `I18nManager` RTL** (it would flip Android layouts that were built by hand). Direction is
emulated per component, locale-driven:

```js
import { createStyles } from '../lib/i18n';
const styles = createStyles((d) => ({
  row: { flexDirection: d.row, alignItems: 'center' },
  label: { textAlign: d.textAlign, writingDirection: d.writingDirection },
  badge: { position: 'absolute', [d.start]: 8 },
}));
```

`createStyles` returns a Proxy that builds and caches one `StyleSheet` per locale; `styles.foo` always resolves to
the active locale. Tokens (`d.*`, also `dir` from `useI18n()` for inline styles):

| Token | he | en | Use for |
|---|---|---|---|
| `row` | `row-reverse` | `row` | any row laid out in reading order |
| `rowReverse` | `row` | `row-reverse` | a row whose `row` order was a deliberate RTL choice |
| `textAlign` / `textAlignEnd` | right / left | left / right | text alignment |
| `writingDirection` | rtl | ltr | inputs and generated prose |
| `alignStart` / `alignEnd` | flex-end / flex-start | flex-start / flex-end | push to reading start/end |
| `start` / `end` | right / left | left / right | absolute positions, side margins |
| `forwardRotate` | 0deg | 180deg | chevrons drawn pointing left that mean "open / next" |
| `isRTL`, `sign` | true, 1 | false, -1 | conditionals, translate math |

Rules that were decided during the migration:
- Hebrew must look exactly as before; English is the semantic mirror.
- **Header is physical in both languages**: back ← top-left, menu top-right, sun mascot top-left (`components/Header.js`). This matches English convention and the approved Hebrew layout.
- **FiltersSheet header** is fixed `row-reverse`: Hebrew keeps its approved order, English gets title-left / "Clear all"-right.
- Symmetric rows ("line — or — line"), digit/PIN boxes, photos, maps, logos, emoji and numbers never mirror.
- Email / phone / URL / numeric inputs are always `textAlign: 'left'`, `writingDirection: 'ltr'`.
- Web: `<html lang dir>` follows the locale, but `body` and the root `View` are pinned to `direction: ltr` so the browser does not flip flex rows a second time. RN-web `Text` uses `dir="auto"`, so Hebrew DB text inside English UI still renders correctly. When **UI-language prose embeds Hebrew data at its start** (e.g. the generated description on Activity Detail), set `writingDirection: dir.writingDirection` explicitly, otherwise bidi auto-detection flips the English sentence.

### Canonical data vs. display
- **Canonical values stay Hebrew**, everywhere they are stored, compared, sent to the server or used as IDs: categories, regions, city names, day names, entity types, benefit providers, report reasons (saved in Hebrew via `t(key, params, DEFAULT_LOCALE)`).
- Display them through helpers: `categoryLabel(value)`, `regionLabel(value)`, `placeName(city)`. Unknown values fall back to the raw value.
- **Place names**: one source of truth, `constants/placeNamesEn.json`. Lookup via `normalizePlaceKey` (strips niqqud, quotes, hyphens, "(שבט)/(יישוב)"). Never transliterate in a component. `CityAutocomplete` shows `placeName(value)` and maps an exact English name back to the Hebrew city.
- **Never translate**: activity titles/descriptions, venue names, addresses (DB content — shown as-is, the defined fallback), user input (search queries, recent searches, notes, nicknames, child names), emails, URLs, phone numbers, brand names.
- **Never show raw backend errors**: map to `common.states.errorGeneric`/a screen-specific friendly key (`lib/authErrors.js` for auth).

### Search
The `smart-search` Edge Function (Claude) parses free text in either language into the **same canonical Hebrew intent**. Its prompt carries a small English→canonical glossary for ambiguous terms (e.g. "playground" = גן שעשועים, "play center" = משחקייה). Add to that glossary if an English term maps to the wrong category — don't build a second search path.

---

## 3. Everyday workflow

### Adding or changing UI text
1. Pick the namespace of the screen (or `common`/`domain` if shared). Look for an existing key first.
2. Add the key to **both** `he/<ns>.json` and `en/<ns>.json` with the same tree.
3. Use it: `t('ns.section.key', params)`. For counts add `_one` / `_other` (and `_two` in Hebrew where natural).
4. If the text is composed with data, make **one** parameterized key (`"{{place}} · {{category}}"`), never concatenate translated fragments.
5. If you touched layout, use `createStyles` tokens; never write `row-reverse` / `textAlign: 'right'` literals for reading direction.
6. Run the checks (below).

### Adding a new screen / component
- Call `useI18n()` in the component (and in any `React.memo` / FlatList item component that renders text).
- Use `createStyles((d) => ({ ... }))` instead of `StyleSheet.create`.
- `useMemo`/`useCallback` returning display text or copied activities → add `locale` to deps.
- Module-scope constants may hold **keys**, never copy.

### Checks
```bash
npm run i18n:check          # he/en parity, plural _other, same {{params}}, every literal t('…') key exists
npm run i18n:scan           # hard-coded Hebrew in app/ + components/ (comments ignored)
npm run i18n:scan -- --changed   # only lines you changed vs HEAD (+ untracked files) — use this before every commit
npm run test:i18n           # unit tests
```
Canonical Hebrew data lines in UI code get a trailing `// i18n-ignore` (use sparingly; each one should be data, not copy).
The scanner only looks for Hebrew — English copy hard-coded in JSX is not caught automatically, so review diffs for
string literals too.

### Pre-merge checklist
- [ ] New text lives in `lib/i18n/locales/{he,en}` — no literal copy in components
- [ ] `npm run i18n:check`, `npm run i18n:scan -- --changed`, `npm run test:i18n` pass
- [ ] Canonical values (category/region/city/day) stored/compared in Hebrew; displayed via `categoryLabel`/`regionLabel`/`placeName`
- [ ] Plurals use `count`; composed sentences are single parameterized keys
- [ ] New styles use `createStyles` tokens; chevrons meaning "forward" use `forwardRotate`
- [ ] `locale` in memo deps where display text or activity copies are memoized
- [ ] No raw backend error text reaches the user
- [ ] Looked at the screen in **both** languages at 320–375px (English is ~20–40% longer)

---

## 4. Prompt for a future agent

> You are working on Turu (Expo 54 / React Native + react-native-web, Hebrew default + English). All UI text must go
> through `lib/i18n` — read `I18N-MAINTENANCE.md` first. For any text you add or change: add keys to both
> `lib/i18n/locales/he/<ns>.json` and `en/<ns>.json` (same tree, same `{{params}}`, plurals as `_one/_other` with
> `count`), call `t()` from `useI18n()` in components, and use `createStyles((d) => …)` direction tokens instead of
> `row-reverse`/`textAlign:'right'`. Keep canonical data (categories, regions, cities, day names) in Hebrew and display
> it via `categoryLabel`/`regionLabel`/`placeName`. Never translate DB content or user input, never show raw backend
> errors. Hebrew must stay visually identical. Before finishing run `npm run i18n:check`,
> `npm run i18n:scan -- --changed` and `npm run test:i18n`, and report any direction decision you were unsure about.

---

## 5. Adding a new locale (e.g. Arabic or Russian)

1. **Register it** in `lib/i18n/locales/index.js`: add `ar: { dir: 'rtl', tag: 'ar-IL', nativeName: 'العربية', shortName: 'ع' }` to `LOCALES` and import its namespace files into `RESOURCES.ar`. `SUPPORTED_LOCALES` derives from `LOCALES`.
2. **Copy the resources**: `cp -r lib/i18n/locales/en lib/i18n/locales/ar`, then translate every value. `npm run i18n:check` fails until all keys and params match.
3. **Plural rules**: add a function to `PLURAL_RULES` in `lib/i18n/index.js` returning the CLDR category names you use as suffixes (`zero/one/two/few/many/other`). The checker already accepts all six suffixes.
4. **Direction**: `dirTokens` derives from `LOCALES[x].dir`, so an RTL locale automatically gets the Hebrew geometry.
5. **Domain data**:
   - Place names: extend `constants/placeNamesEn.json` into a per-locale map (e.g. `placeNames.ar.json`) and branch in `placeName()`.
   - Category/region labels come from `domain.categories` / `domain.regions` — translate them in the new `domain.json`.
6. **Switcher**: `LanguageSwitcher` and the Profile row iterate `SUPPORTED_LOCALES`; with three locales, check the Home pill still fits at 320px (consider a menu instead).
7. **Search**: add a short glossary line for the new language to the `smart-search` prompt if test queries map to the wrong category.
8. **Legal**: the legal namespace needs a faithful translation plus the `bindingNotice` value.
9. Add the locale to `tests/i18n.test.js` expectations (parity test already loops over all locales) and QA every screen at 320/360/375px.

---

## 6. Known limitations / deliberate fallbacks

- **DB content is Hebrew-only** (5,758 activities; titles/descriptions, venue names, addresses). English UI shows it as-is. A translation layer (e.g. `name_en`/`description_en` columns filled by batch AI translation, ~229k chars) was estimated but **not run** — it needs an explicit owner decision.
- Server-provided Hebrew prose (smart-search clarification of a type other than `city`, daily-limit message) is replaced by a generic localized message in English.
- The link-reader (add activity) maps only 400/401/422 statuses to specific messages; other failures show a generic message.
- `constants/mockActivities.js` is unused mock data and was not localized.
- `lib/scheduleSummary.js` still returns a Hebrew `hours` string for its Node parity test; the app displays `scheduleHoursLabel()` instead.
- The admin account-deletion email body (`lib/legal.js`) is intentionally Hebrew (internal recipient).
- Legal pages: English is a convenience translation; `legal.*.bindingNotice` states the Hebrew version prevails (empty in Hebrew).
