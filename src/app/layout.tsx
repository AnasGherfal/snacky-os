import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Snacky OS",
  description: "Operating system for Snacky vending operations",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
