import { ar } from "@/lib/i18n/ar";
import { en } from "@/lib/i18n/en";

export const supportedLocales = ["en", "ar"] as const;

export type SupportedLocale = (typeof supportedLocales)[number];
export type TextDirection = "ltr" | "rtl";
export type Dictionary = typeof en;

export const dictionaries: Record<SupportedLocale, Dictionary> = { en, ar };
export const defaultLocale: SupportedLocale = "en";
export const languageStorageKey = "snacky-os-language";

export function isSupportedLocale(locale: string | null | undefined): locale is SupportedLocale {
  return supportedLocales.includes(locale as SupportedLocale);
}

export function getTextDirection(locale: string | null | undefined): TextDirection {
  return locale === "ar" ? "rtl" : "ltr";
}

export function getAppLocale(locale: string | null | undefined = process.env.NEXT_PUBLIC_APP_LOCALE): SupportedLocale {
  return isSupportedLocale(locale) ? locale : defaultLocale;
}
