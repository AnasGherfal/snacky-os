"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode } from "react";

const nav = [
  ["Dashboard", "/dashboard"],
  ["Locations", "/locations"],
  ["Machines", "/machines"],
  ["Suppliers", "/suppliers"],
  ["Products", "/products"],
  ["Storage", "/storage-locations"],
  ["Team", "/team"],
  ["Machine Slots", "/machine-slots"],
  ["VMS Mappings", "/vms-mappings"],
  ["Inventory", "/inventory"],
  ["Refills", "/refills"],
  ["Operator", "/operator"],
  ["Issues", "/issues"],
  ["VMS Import", "/vms-import"],
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed left-0 top-0 hidden h-full w-72 overflow-y-auto border-r border-slate-200 bg-white px-6 py-7 md:block">
        <div className="mb-8">
          <div className="text-2xl font-bold tracking-tight text-slate-900">Snacky OS</div>
          <div className="text-sm text-slate-500">Vending operations control</div>
        </div>
        <nav className="space-y-1">
          {nav.map(([label, href]) => {
            const active = pathname === href;
            return (
              <Link key={href} className={active ? "nav-link-active" : "nav-link"} href={href}>
                {label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <main className="md:pl-72">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur md:hidden">
          <div className="px-4 py-3">
            <div className="text-lg font-semibold">Snacky OS</div>
            <div className="text-xs text-slate-500">Operations</div>
          </div>
          <nav className="flex gap-2 overflow-x-auto px-3 pb-3">
            {nav.map(([label, href]) => {
              const active = pathname === href;
              return (
                <Link key={href} className={active ? "pill-active" : "pill"} href={href}>
                  {label}
                </Link>
              );
            })}
          </nav>
        </header>

        <div className="mx-auto max-w-7xl p-4 md:p-8">{children}</div>
      </main>
    </div>
  );
}
