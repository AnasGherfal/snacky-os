"use client";

import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import {
  Dictionary,
  SupportedLocale,
  dictionaries,
  defaultLocale,
  getTextDirection,
  isSupportedLocale,
  languageStorageKey,
} from "@/lib/i18n";

type I18nContextValue = {
  locale: SupportedLocale;
  direction: "ltr" | "rtl";
  dictionary: Dictionary;
  setLocale: (locale: SupportedLocale) => void;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children, initialLocale = defaultLocale }: { children: ReactNode; initialLocale?: SupportedLocale }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(initialLocale);

  useEffect(() => {
    const storedLocale = window.localStorage.getItem(languageStorageKey);
    if (isSupportedLocale(storedLocale)) {
      setLocaleState(storedLocale);
    }
  }, []);

  useEffect(() => {
    const direction = getTextDirection(locale);
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;
    window.localStorage.setItem(languageStorageKey, locale);
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      direction: getTextDirection(locale),
      dictionary: dictionaries[locale],
      setLocale: setLocaleState,
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used inside I18nProvider");
  }

  return context;
}
