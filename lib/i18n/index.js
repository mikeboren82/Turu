// Turu i18n - the single localization system for the app. See I18N-MAINTENANCE.md.
//
// - UI strings live in lib/i18n/locales/<locale>/<namespace>.json and are read with t('ns.key').
// - The current locale is a small module-level store, so plain helpers (lib/*.js) can call t()
//   directly; React components call useI18n() so they re-render when the locale changes.
// - Layout direction is emulated in code (the app keeps I18nManager RTL disabled, see app/_layout.js),
//   so direction-aware styles come from createStyles() / useI18n().dir instead of hard-coded
//   'row-reverse' / textAlign:'right'.
import { useSyncExternalStore } from 'react';
import { Platform, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RESOURCES, LOCALES, DEFAULT_LOCALE } from './locales';

export { LOCALES, DEFAULT_LOCALE };
export const SUPPORTED_LOCALES = Object.keys(LOCALES);
const STORAGE_KEY = 'turu_locale';
const IS_DEV = typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';

let current = DEFAULT_LOCALE;
const listeners = new Set();

export function getLocale() {
  return current;
}

export function isRTLLocale(locale = current) {
  return LOCALES[locale]?.dir === 'rtl';
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function applyDocumentLanguage(locale) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.documentElement.dir = LOCALES[locale].dir;
  // Layout direction is emulated per component, so CSS direction must stay LTR for flexbox -
  // including Modal portals, which mount directly under <body>. Text still gets correct bidi
  // because react-native-web renders Text with dir="auto".
  if (document.body) document.body.style.direction = 'ltr';
}

export function setLocale(locale, { persist = true } = {}) {
  if (!LOCALES[locale] || locale === current) return;
  current = locale;
  applyDocumentLanguage(locale);
  if (persist) AsyncStorage.setItem(STORAGE_KEY, locale).catch(() => {});
  listeners.forEach((l) => l());
}

// Called once at startup (app/_layout.js). Resolves before first render so there is no flash of
// the wrong language. Precedence: explicit stored choice → Hebrew default. Device language is
// deliberately ignored (product decision: Hebrew is the default for everyone).
export async function initLocale() {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored && LOCALES[stored] && stored !== current) {
      current = stored;
      listeners.forEach((l) => l());
    }
  } catch {
    // storage unavailable - keep the default
  }
  applyDocumentLanguage(current);
  return current;
}

// ---- lookup / interpolation / plurals ----

function lookup(locale, key) {
  let node = RESOURCES[locale];
  for (const part of key.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

// Hermes (Android) has no Intl.PluralRules, so the locales we ship define their rules here.
// A future locale falls back to Intl.PluralRules when available, else one/other.
const PLURAL_RULES = {
  he: (n) => (n === 1 ? 'one' : n === 2 ? 'two' : 'other'),
  en: (n) => (n === 1 ? 'one' : 'other'),
};
function pluralCategory(locale, n) {
  if (PLURAL_RULES[locale]) return PLURAL_RULES[locale](n);
  try {
    return new Intl.PluralRules(locale).select(n);
  } catch {
    return n === 1 ? 'one' : 'other';
  }
}

function resolve(locale, key, params) {
  if (params && typeof params.count === 'number') {
    const cat = pluralCategory(locale, params.count);
    return lookup(locale, `${key}_${cat}`) ?? lookup(locale, `${key}_other`) ?? lookup(locale, key);
  }
  return lookup(locale, key);
}

const warned = new Set();
function warnMissing(locale, key) {
  const id = `${locale}:${key}`;
  if (!IS_DEV || warned.has(id)) return;
  warned.add(id);
  console.warn(`[i18n] missing translation "${key}" for locale "${locale}"`);
}

function interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => (params[name] != null ? String(params[name]) : m));
}

// t('home.search.title'), t('activities.count', { count: 3 }), t('location.fromCity', { minutes, city })
// Missing in the active locale → Hebrew (default) fallback, never a raw key in production.
export function t(key, params, locale = current) {
  let value = resolve(locale, key, params);
  if (value == null) {
    warnMissing(locale, key);
    if (locale !== DEFAULT_LOCALE) value = resolve(DEFAULT_LOCALE, key, params);
  }
  if (value == null) return IS_DEV ? key : '';
  return interpolate(value, params);
}

// ---- formatting ----

export function localeTag(locale = current) {
  return LOCALES[locale].tag;
}

// "a", "a ו-b"-style natural list join, per locale grammar (see common.list* keys).
export function listJoin(items, locale = current) {
  const list = (items || []).filter((x) => x != null && x !== '');
  if (list.length <= 1) return list[0] || '';
  const last = list[list.length - 1];
  const head = list.slice(0, -1).join(t('common.listSeparator', null, locale));
  return t('common.listAnd', { head, last }, locale);
}

export function formatDate(value, options = { day: 'numeric', month: 'numeric', year: 'numeric' }, locale = current) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleDateString(localeTag(locale), options);
  } catch {
    return d.toLocaleDateString();
  }
}

export function formatNumber(n, options, locale = current) {
  try {
    return Number(n).toLocaleString(localeTag(locale), options);
  } catch {
    return String(n);
  }
}

// ---- direction ----

// Tokens used instead of hard-coded RTL emulation. "row" follows reading direction, "rowReverse"
// is its opposite; "textAlign" is the reading-start side.
export function dirTokens(locale = current) {
  const rtl = isRTLLocale(locale);
  return {
    isRTL: rtl,
    row: rtl ? 'row-reverse' : 'row',
    rowReverse: rtl ? 'row' : 'row-reverse',
    textAlign: rtl ? 'right' : 'left',
    textAlignEnd: rtl ? 'left' : 'right',
    writingDirection: rtl ? 'rtl' : 'ltr',
    alignStart: rtl ? 'flex-end' : 'flex-start',
    alignEnd: rtl ? 'flex-start' : 'flex-end',
    start: rtl ? 'right' : 'left',
    end: rtl ? 'left' : 'right',
    // multiply a horizontal offset/translate that was written for RTL
    sign: rtl ? 1 : -1,
    // rotation for a chevron/arrow icon that points "forward" (towards the reading end) when drawn pointing left
    forwardRotate: rtl ? '0deg' : '180deg',
  };
}

// Direction-aware StyleSheet. Write the factory against the tokens (d.row, d.textAlign, ...):
//   const styles = createStyles((d) => ({ row: { flexDirection: d.row }, title: { textAlign: d.textAlign } }));
// `styles.row` resolves for the current locale at render time (one cached StyleSheet per locale),
// so existing `styles.x` references keep working unchanged.
export function createStyles(factory) {
  const cache = {};
  const sheet = () => {
    const locale = current;
    if (!cache[locale]) cache[locale] = StyleSheet.create(factory(dirTokens(locale)));
    return cache[locale];
  };
  return new Proxy({}, {
    get: (_, prop) => sheet()[prop],
    has: (_, prop) => prop in sheet(),
    ownKeys: () => Reflect.ownKeys(sheet()),
    getOwnPropertyDescriptor: (_, prop) => ({ configurable: true, enumerable: true, value: sheet()[prop] }),
  });
}

// ---- React ----

export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return {
    locale,
    t: (key, params) => t(key, params, locale),
    isRTL: isRTLLocale(locale),
    dir: dirTokens(locale),
    setLocale,
    listJoin: (items) => listJoin(items, locale),
    formatDate: (value, options) => formatDate(value, options, locale),
    formatNumber: (n, options) => formatNumber(n, options, locale),
  };
}
