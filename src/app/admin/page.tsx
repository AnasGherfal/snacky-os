import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";

const adminLinks = [
  { title: "Team", href: "/team", description: "Users, roles, operator accounts, and access status." },
  { title: "Settings", href: "/settings", description: "Business settings and operating configuration." },
  { title: "VMS Import", href: "/vms-import", description: "Upload stock or sales CSV files from the vending system." },
  { title: "Product Mapping", href: "/vms-mappings", description: "Connect VMS product names to Snacky products." },
  { title: "Activity Log", href: "/activity", description: "Audit user actions and operational changes." },
  { title: "Storage Locations", href: "/storage-locations", description: "Manage storage rooms and stockholding locations." },
  { title: "Suppliers", href: "/suppliers", description: "Supplier records used by purchases and product setup." },
];

export default async function AdminPage() {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile?.role)) redirect("/unauthorized");

  return (
    <AppShell>
      <PageHeader title="Admin" subtitle="Owner/admin tools for setup, access, imports, and audit history." />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {adminLinks.map((item) => (
          <Link key={item.href} href={item.href} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow-md">
            <div className="text-base font-semibold text-slate-900">{item.title}</div>
            <p className="mt-2 text-sm leading-6 text-slate-500">{item.description}</p>
          </Link>
        ))}
      </div>
    </AppShell>
  );
}
