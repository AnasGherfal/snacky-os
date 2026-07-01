import { cookies } from "next/headers";
import { type SupportedLocale, getAppLocale, getDictionary, getTextDirection, languageCookieKey, translateDictionaryEntry } from "@/lib/i18n";

export async function getRequestLocale(): Promise<SupportedLocale> {
  const cookieStore = await cookies();
  return getAppLocale(cookieStore.get(languageCookieKey)?.value);
}

export async function getServerI18n() {
  const locale = await getRequestLocale();
  const dictionary = getDictionary(locale);

  return {
    locale,
    direction: getTextDirection(locale),
    dictionary,
    t: (key: string, fallback?: string) => translateDictionaryEntry(dictionary, key, fallback),
  };
}
