import i18next from 'i18next';
import { createSignal } from 'solid-js';
import type { JSX } from 'solid-js';

type TranslationModules = Record<string, { default: Record<string, any> }>;

const translationModules = 
  import.meta.glob('../translations/*.json', { eager: true }) satisfies TranslationModules;

const resources: Record<string, Record<string, any>> = {};
for (const [path, mod] of Object.entries(translationModules)) {
  const locale = path.replace('../translations/', '').replace('.json', '');
  resources[locale] = { translation: mod.default ?? mod };
}

export const LOCALE_NAMES: Record<string, string> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'zh-Hans': '中文（简体）',
  'zh-Hant': '中文（繁體）',
  'zh-Hant-HK': '中文（繁體，香港）',
  'es': 'Español',
  'fr': 'Français',
  'de': 'Deutsch',
  'pt-BR': 'Português (Brasil)',
  'ru': 'Русский',
  'ja': '日本語',
  'ko': '한국어',
  'tr': 'Türkçe',
  'vi': 'Tiếng Việt',
  'be_TARASK': 'Беларуская (тарашкевіца)',
};

export const LOCALE_FLAGS: Record<string, string> = {
  'en-US': '🇺🇸',
  'en-GB': '🇬🇧',
  'zh-Hans': '🇨🇳',
  'zh-Hant': '🇹🇼',
  'zh-Hant-HK': '🇭🇰',
  'es': '🇪🇸',
  'fr': '🇫🇷',
  'de': '🇩🇪',
  'pt-BR': '🇧🇷',
  'ru': '🇷🇺',
  'ja': '🇯🇵',
  'ko': '🇰🇷',
  'tr': '🇹🇷',
  'vi': '🇻🇳',
  'be_TARASK': '🇧🇾',
};

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
export { locale };

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
