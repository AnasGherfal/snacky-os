import Link from "next/link";
import { ReactNode } from "react";

const nav = [
  ["Dashboard", "/dashboard"],
  ["Machines", "/machines"],
  ["Products", "/products"],
  ["Inventory", "/inventory"],
  ["Refills", "/refills"],
  ["Operator", "/operator"],
  ["Issues", "/issues"],
  ["VMS Import", "/vms-import"],
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <aside className="fixed left-0 top-0 hidden h-full w-64 border-r border-slate-200 bg-white p-6 md:block">
        <div className="mb-8">
          <div className="text-2xl font-bold tracking-tight">Snacky OS</div>
          <div className="text-sm text-slate-500">Vending operations</div>
        </div>
        <nav className="space-y-1">
          {nav.map(([label, href]) => (
            <Link key={href} className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100" href={href}>
              {label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="md:pl-64">
        <div className="mx-auto max-w-7xl p-4 md:p-8">{children}</div>
      </main>
    </div>
  );
}
