import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";

const adminLinks = [
  {
    title: "Admin Tools",
    href: "/admin/tools",
    description:
      "Recover stuck routes, reconcile ledgers, manage VMS import state, and refresh dashboards.",
  },
  {
    title: "Diagnostics",
    href: "/admin/diagnostics",
    description:
      "Pilot-readiness checks for environment, Supabase, imports, and core table counts.",
  },
  {
    title: "Finance Health",
    href: "/admin/finance-health",
    description:
      "Audit ledger schema drift, transaction counts, and purchase/cash finance sync gaps.",
  },
  {
    title: "System Health",
    href: "/admin/system-health",
    description:
      "See failed imports, finance sync gaps, stuck routes, missing product costs, and unmapped VMS records in one place.",
  },
  {
    title: "Team",
    href: "/team",
    description: "Users, roles, operator accounts, and access status.",
  },
  {
    title: "Settings",
    href: "/settings",
    description: "Business settings and operating configuration.",
  },
  {
    title: "XY VMS API",
    href: "/admin/vms-api",
    description:
      "Sync Xingyuan machines, products, stock, and status server-side.",
  },
  {
    title: "VMS Import",
    href: "/vms-import",
    description: "Upload stock or sales CSV files from the vending system.",
  },
  {
    title: "VMS Data Sources",
    href: "/vms-import/sources",
    description:
      "View imported files, dashboard usage, original uploads, and safe disable/restore/reprocess controls.",
  },
  {
    title: "KPI Definitions",
    href: "/admin/kpi-definitions",
    description:
      "Reference definitions for VMS sales, profit, velocity, NSM, variance, and growth metrics.",
  },
  {
    title: "Historical Route Deduction",
    href: "/admin/historical-route-deduction",
    description:
      "Preview and apply one-time storage deductions for old manually recorded route/refill data.",
  },
  {
    title: "Product Mapping",
    href: "/vms-mappings",
    description: "Connect VMS product names to Snacky products.",
  },
  {
    title: "Activity Log",
    href: "/activity",
    description: "Audit user actions and operational changes.",
  },
  {
    title: "Storage Locations",
    href: "/storage-locations",
    description: "Manage storage rooms and stockholding locations.",
  },
  {
    title: "Suppliers",
    href: "/suppliers",
    description: "Supplier records used by purchases and product setup.",
  },
];

export default async function AdminPage() {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");

  return (
    <>
      <PageHeader
        title="Admin"
        subtitle="Owner/admin tools for setup, access, imports, and audit history."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {adminLinks.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="surface-card block transition hover:border-slate-300 hover:shadow-md"
          >
            <div className="text-base font-semibold text-slate-900">
              {item.title}
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              {item.description}
            </p>
          </Link>
        ))}
      </div>
    </>
  );
}
