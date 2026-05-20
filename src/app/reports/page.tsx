import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";

const reportLinks = [
  { title: "Sales Dashboard", href: "/sales", description: "VMS sales by day, machine, location, product, and payment type." },
  { title: "Product Dashboard", href: "/products-dashboard", description: "Velocity, revenue, margins, stockouts, and storage coverage." },
  { title: "Machine Dashboard", href: "/machines-dashboard", description: "Machine sales, NSM, refills, cash variance, issues, and rent-aware profit." },
  { title: "Inventory Dashboard", href: "/inventory-dashboard", description: "Ledger stock, reserved route stock, low storage, and purchase suggestions." },
];

export default async function ReportsPage() {
  await requireCurrentProfileForPath("/reports");
  return (
    <>
      <PageHeader title="Reports" subtitle="KPI dashboards for sales, products, machines, and inventory." />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {reportLinks.map((item) => (
          <Link key={item.href} href={item.href} className="surface-card block transition hover:border-slate-300 hover:shadow-md">
            <div className="text-base font-semibold text-slate-900">{item.title}</div>
            <p className="mt-2 text-sm leading-6 text-slate-500">{item.description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
