import { ar } from "@/lib/i18n/ar";
import { en } from "@/lib/i18n/en";

export const supportedLocales = ["en", "ar"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];
export type TextDirection = "ltr" | "rtl";

export type TranslationDictionary = {
  app: {
    name: string;
    subtitle: string;
    operationsSystem: string;
  };
  language: {
    english: string;
    arabic: string;
  };
  shell: {
    account: string;
    logout: string;
    signingOut: string;
    navigation: string;
    openNavigation: string;
    closeNavigation: string;
    closeNavigationOverlay: string;
    switchLanguage: string;
    back: string;
  };
  nav: {
    dashboardGroup: string;
    dashboard: string;
    sales: string;
    productsDashboard: string;
    machinesDashboard: string;
    inventoryDashboard: string;
    reports: string;
    admin: string;
    account: string;
    operations: string;
    refillRecommendations: string;
    routes: string;
    operatorView: string;
    assets: string;
    machinesGroup: string;
    machines: string;
    locations: string;
    locationsPipeline: string;
    machinePlanograms: string;
    planograms: string;
    inventory: string;
    storage: string;
    storageLocations: string;
    restockPriority: string;
    products: string;
    storageInventory: string;
    movementLog: string;
    movements: string;
    purchases: string;
    suppliers: string;
    pickLists: string;
    vms: string;
    vmsImport: string;
    productMapping: string;
    control: string;
    finance: string;
    financeOverview: string;
    financeTransactions: string;
    financeCleanup: string;
    financeImport: string;
    financeReports: string;
    activityLog: string;
    cashCollections: string;
    issues: string;
    team: string;
    settings: string;
    install: string;
    operatorProgress: string;
    myRoutes: string;
    availableRoutes: string;
    todaysRoute: string;
    payroll: string;
    operators: string;
  };
  actions: {
    add: string;
    edit: string;
    save: string;
    cancel: string;
    delete: string;
    search: string;
    filter: string;
    archive: string;
    update: string;
    confirm: string;
    retry: string;
    select: string;
  };
  common: {
    status: string;
    active: string;
    inactive: string;
    available: string;
    unavailable: string;
    loading: string;
    noData: string;
    required: string;
    date: string;
    amount: string;
    quantity: string;
    notes: string;
    source: string;
    filesUsed: string;
  };
  phrases: Record<string, string>;
};

export type Dictionary = TranslationDictionary;

export const dictionaries: Record<SupportedLocale, TranslationDictionary> = { en, ar };
export const defaultLocale: SupportedLocale = "ar";
export const languageStorageKey = "snacky_os_language";
export const languageCookieKey = "snacky_os_language";

export function isSupportedLocale(locale: string | null | undefined): locale is SupportedLocale {
  return supportedLocales.includes(locale as SupportedLocale);
}

export function getTextDirection(locale: string | null | undefined): TextDirection {
  return locale === "ar" ? "rtl" : "ltr";
}

export function getAppLocale(locale: string | null | undefined = process.env.NEXT_PUBLIC_APP_LOCALE): SupportedLocale {
  return isSupportedLocale(locale) ? locale : defaultLocale;
}

export function getDictionary(locale: SupportedLocale) {
  return dictionaries[locale];
}

function resolvePathValue(dictionary: TranslationDictionary, key: string) {
  return key.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || !(segment in current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, dictionary);
}

export function translateDictionaryEntry(dictionary: TranslationDictionary, key: string, fallback?: string) {
  const pathValue = key.includes(".") ? resolvePathValue(dictionary, key) : undefined;
  if (typeof pathValue === "string") return pathValue;
  if (dictionary.phrases[key]) return dictionary.phrases[key];

  const trimmedKey = key.trim();
  if (trimmedKey !== key && dictionary.phrases[trimmedKey]) return dictionary.phrases[trimmedKey];

  const punctuationMatch = trimmedKey.match(/^(.*?)([.!?])$/);
  if (punctuationMatch) {
    const normalizedKey = punctuationMatch[1]?.trim() ?? "";
    const punctuation = punctuationMatch[2] ?? "";
    if (normalizedKey && dictionary.phrases[normalizedKey]) {
      return `${dictionary.phrases[normalizedKey]}${punctuation}`;
    }
  }

  return fallback ?? key;
}

export function translateText(locale: SupportedLocale, text: string) {
  return translateDictionaryEntry(dictionaries[locale], text, text);
}
