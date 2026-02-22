import i18next from 'i18next';
import { createSignal } from 'solid-js';
import type { JSX } from 'solid-js';

type TranslationModules = Record<string, { default: Record<string, any> }>;

const translationModules = 
  import.meta.glob('../translations/*.json', { eager: true }) satisfies TranslationModules;

const resources: Record<string, Record<string, any>> = {};
for (const [path, mod] of Object.entries(translationModules)) {
  let locale = path.replace('../translations/', '').replace('.json', '');
  const candidate = { translation: mod.default ?? mod };
  
  if (locale === 'be-TARASK') locale = 'be_TARASK';
  if (candidate.translation != null && Object.keys(candidate.translation).length > 0) 
    resources[locale] = candidate;
}

export function normalizeLocale(locale: string): string {
  return locale.replaceAll('_', '-');
}

export function getLanguageDisplayName(locale: string, displayLocale = 'en'): string {
  const normalized = normalizeLocale(locale);
  displayLocale = normalizeLocale(displayLocale);
  const { language, script, region } = new Intl.Locale(normalized);

  const languageNames = new Intl.DisplayNames([displayLocale], { type: 'language' });
  const regionNames = new Intl.DisplayNames([displayLocale], { type: 'region' });
  const scriptNames = new Intl.DisplayNames([displayLocale], { type: 'script' });

  const languageName = languageNames
    .of(language)
    ?.replace(/^\p{L}/u, c => c.toUpperCase());
  const qualifier = region
    ? regionNames.of(region)
    : script
    ? scriptNames.of(script)
    : null;

  return qualifier ? `${languageName} (${qualifier})` : languageName ?? locale;
}

export function getFlagEmoji(locale: string): string | null {
  const normalized = normalizeLocale(locale);
  try {
    const { region } = new Intl.Locale(normalized).maximize();
    if (!region) return null;
    return [...region]
      .map(char => String.fromCodePoint(0x1F1E6 - 65 + char.charCodeAt(0)))
      .join('');
  } catch {
    return null;
  }
}

export const LOCALE_FLAGS: Record<string, string | null> = Object.fromEntries(
  Object.keys(resources).map(locale => [locale, getFlagEmoji(locale)])
);
export const AVAILABLE_LOCALES = Object.keys(resources);

const STORAGE_KEY = 'locale';

function getInitialLocale(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && resources[stored]) return stored;

  // match browser locale
  const navLang = navigator.language;
  if (resources[navLang]) return navLang;

  // mainly for "zh-Hans" matching "zh"
  const prefix = navLang.split('-')[0];
  const match = AVAILABLE_LOCALES.find(l => l.startsWith(prefix));
  if (match) return match;

  return 'en-US';
}

// TODO: make this a context maybe?
const [locale, _setLocale] = createSignal<string>(getInitialLocale());
const normalizedLocale = () => normalizeLocale(locale());
export { locale, normalizedLocale };

i18next.init({
  lng: locale(),
  fallbackLng: 'en-US',
  resources,
  interpolation: {
    escapeValue: false,
  },
});

export function setLocale(lang: string) {
  localStorage.setItem(STORAGE_KEY, lang);
  i18next.changeLanguage(lang);
  _setLocale(lang);
}

export function t(key: string, options?: Record<string, any>): string {
  locale();
  return i18next.t(key, options) as string;
}

export function tJsx(key: string, slots: Record<string, JSX.Element>): JSX.Element {
  locale();
  const raw = i18next.t(key) as string;
  const parts: JSX.Element[] = [];
  let remaining = raw;

  while (remaining.length > 0) {
    const start = remaining.indexOf('{{');
    if (start === -1) {
      parts.push(remaining);
      break;
    }
    if (start > 0) parts.push(remaining.slice(0, start));

    const end = remaining.indexOf('}}', start);
    if (end === -1) {
      parts.push(remaining.slice(start));
      break;
    }

    const slotKey = remaining.slice(start + 2, end);
    parts.push(slotKey in slots ? slots[slotKey] : `{{${slotKey}}}`);
    remaining = remaining.slice(end + 2);
  }

  return parts as unknown as JSX.Element;
}
