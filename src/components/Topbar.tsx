"use client";
import { usePathname } from "next/navigation";

const titles: Record<string, string> = { "/dashboard": "Dashboard" };

export function Topbar() {
  const pathname = usePathname();
  return <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur md:px-8"><div className="text-sm font-medium text-slate-900">{titles[pathname] ?? "Snacky OS"}</div><div className="text-xs text-slate-500">Internal operations</div></header>;
}
