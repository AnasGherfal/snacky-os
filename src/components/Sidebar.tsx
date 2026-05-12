"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navGroups = [
  { title: "Dashboard", items: [{ label: "Dashboard", href: "/dashboard" }] },
  { title: "Operations", items: [{ label: "Refill Recommendations", href: "/refills" }, { label: "Routes", href: "/routes" }, { label: "Operator View", href: "/operator" }] },
  { title: "Assets", items: [{ label: "Machines", href: "/machines" }, { label: "Locations", href: "/locations" }, { label: "Machine Slots", href: "/machine-slots" }] },
  { title: "Inventory", items: [{ label: "Products", href: "/products" }, { label: "Storage Inventory", href: "/inventory" }, { label: "Suppliers", href: "/suppliers" }] },
  { title: "VMS", items: [{ label: "VMS Import", href: "/vms-import" }, { label: "Product Mapping", href: "/vms-mappings" }] },
  { title: "Control", items: [{ label: "Cash Collections", href: "/cash-collections" }, { label: "Issues", href: "/issues" }, { label: "Team", href: "/team" }] },
] as const;

export function Sidebar() { const pathname = usePathname(); return <aside className="hidden w-72 shrink-0 border-r border-slate-200 bg-white md:block"><div className="sticky top-0 h-screen overflow-y-auto p-6"><h2 className="text-xl font-semibold">Snacky OS</h2><p className="mb-6 text-xs text-slate-500">Operations system</p>{navGroups.map((g)=><div key={g.title} className="mb-5"><div className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{g.title}</div><div className="space-y-1">{g.items.map((i)=><Link key={i.href} href={i.href} className={pathname===i.href?"nav-link-active":"nav-link"}>{i.label}</Link>)}</div></div>)}</div></aside>; }
