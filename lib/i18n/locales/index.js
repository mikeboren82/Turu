// Locale registry. Each locale = one folder of namespace JSON files with IDENTICAL key trees
// (checked by `npm run i18n:check`). To add a namespace: create <ns>.json in EVERY locale folder,
// import it below and add it to RESOURCES for every locale.
import heCommon from './he/common.json';
import enCommon from './en/common.json';
import heDomain from './he/domain.json';
import enDomain from './en/domain.json';
import heNav from './he/nav.json';
import enNav from './en/nav.json';
import heHome from './he/home.json';
import enHome from './en/home.json';
import heActivities from './he/activities.json';
import enActivities from './en/activities.json';
import heFilters from './he/filters.json';
import enFilters from './en/filters.json';
import heLocation from './he/location.json';
import enLocation from './en/location.json';
import heActivity from './he/activity.json';
import enActivity from './en/activity.json';
import heSaved from './he/saved.json';
import enSaved from './en/saved.json';
import heProfile from './he/profile.json';
import enProfile from './en/profile.json';
import heAuth from './he/auth.json';
import enAuth from './en/auth.json';
import hePages from './he/pages.json';
import enPages from './en/pages.json';
import heLegal from './he/legal.json';
import enLegal from './en/legal.json';
import heContribute from './he/contribute.json';
import enContribute from './en/contribute.json';

export const DEFAULT_LOCALE = 'he';

// dir drives layout direction; tag is the BCP-47 tag for Intl date/number formatting
// (en-IL keeps Israeli day/month order). nativeName/shortName are shown in language pickers.
export const LOCALES = {
  he: { dir: 'rtl', tag: 'he-IL', nativeName: 'עברית', shortName: 'עב' },
  en: { dir: 'ltr', tag: 'en-IL', nativeName: 'English', shortName: 'EN' },
};

export const RESOURCES = {
  he: { common: heCommon, domain: heDomain, nav: heNav, home: heHome, activities: heActivities, filters: heFilters, location: heLocation, activity: heActivity, saved: heSaved, profile: heProfile, auth: heAuth, pages: hePages, legal: heLegal, contribute: heContribute },
  en: { common: enCommon, domain: enDomain, nav: enNav, home: enHome, activities: enActivities, filters: enFilters, location: enLocation, activity: enActivity, saved: enSaved, profile: enProfile, auth: enAuth, pages: enPages, legal: enLegal, contribute: enContribute },
};
