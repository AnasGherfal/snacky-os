import type { Metadata, Viewport } from "next";
import { I18nProvider } from "@/components/I18nProvider";
import { PwaRegister } from "@/components/PwaRegister";
import { getAppLocale, getTextDirection } from "@/lib/i18n";
import "./globals.css";

function getMetadataBase() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return undefined;

  try {
    return new URL(appUrl);
  } catch {
    return undefined;
  }
}

export const metadata: Metadata = {
  metadataBase: getMetadataBase(),
  applicationName: "Snacky OS",
  title: "Snacky OS",
  description: "Operating system for Snacky vending operations",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Snacky OS",
  },
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: [{ url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" }],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#3f6f3f",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = getAppLocale();

  return (
    <html lang={locale} dir={getTextDirection(locale)}>
      <body>
        <I18nProvider initialLocale={locale}>{children}</I18nProvider>
        <PwaRegister />
      </body>
    </html>
  );
}
