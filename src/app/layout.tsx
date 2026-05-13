import type { Metadata } from "next";
import { I18nProvider } from "@/components/I18nProvider";
import { getAppLocale, getTextDirection } from "@/lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "Snacky OS",
  description: "Operating system for Snacky vending operations",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = getAppLocale();

  return (
    <html lang={locale} dir={getTextDirection(locale)}>
      <body><I18nProvider initialLocale={locale}>{children}</I18nProvider></body>
    </html>
  );
}
