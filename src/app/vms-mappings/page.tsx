import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DataTable, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const filters = [
  { label: "All", value: "all" },
  { label: "Confirmed", value: "confirmed" },
  { label: "Needs Review", value: "needs_review" },
  { label: "Ignored", value: "ignored" },
] as const;

function formatDate(value: string | null | undefined) {
  if (!value) return "Not seen yet";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatMoney(value: number | string | null | undefined, decimals = 2) {
  if (value === null || value === undefined || value === "") return "-";
  return Number(value).toFixed(decimals);
}

export default async function VmsProductMappingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile?.role)) redirect("/unauthorized");

  const { status = "all", q = "", error } = await searchParams;
  const activeStatus = filters.some((filter) => filter.value === status) ? status : "all";
  const search = q.trim().toLowerCase();

  const supabase = getSupabaseServerClient();
  const { data: mappings } = supabase
    ? await supabase
        .from("vms_product_mappings")
        .select("id, vms_product_id, vms_product_name, product_id, match_status, vms_selling_price_lyd, vms_cost_price_lyd, latest_machine_name, last_seen_at, updated_at, product:products(id, name, sku)")
        .order("updated_at", { ascending: false })
    : { data: [] };

  const rows = (mappings ?? [])
    .filter((mapping: any) => activeStatus === "all" || mapping.match_status === activeStatus)
    .filter((mapping: any) => {
      if (!search) return true;
      return (
        String(mapping.vms_product_id ?? "").toLowerCase().includes(search) ||
        String(mapping.vms_product_name ?? "").toLowerCase().includes(search) ||
        String(mapping.product?.sku ?? "").toLowerCase().includes(search) ||
        String(mapping.product?.name ?? "").toLowerCase().includes(search)
      );
    });
  const needsReviewCount = (mappings ?? []).filter((mapping: any) => mapping.match_status === "needs_review").length;
  const confirmedCount = (mappings ?? []).filter((mapping: any) => mapping.match_status === "confirmed").length;
  const ignoredCount = (mappings ?? []).filter((mapping: any) => mapping.match_status === "ignored").length;

  return (
    <AppShell>
      <PageHeader
        title="VMS Product Mapping"
        subtitle="Match product names from VMS reports to Snacky products so sales, stock, and refill recommendations work correctly."
      />

      <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
        Unmapped VMS products will not appear correctly in sales or refill recommendations.
      </div>

      {error ? (
        <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">
          {error}
        </div>
      ) : null}

      <section className="surface-card mb-6 space-y-4">
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <form className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <input type="hidden" name="status" value={activeStatus} />
            <input
              name="q"
              defaultValue={q}
              placeholder="Search VMS ID, VMS name, SKU, or Snacky product..."
              className="field-input"
            />
            <button className="btn-secondary">Search</button>
          </form>
          <div className="flex flex-wrap gap-2">
            {filters.map((filter) => {
              const href = `/vms-mappings?status=${filter.value}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
              const active = activeStatus === filter.value;
              return (
                <Link key={filter.value} href={href} className={active ? "btn-primary" : "btn-secondary"}>
                  {filter.label}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between gap-2"><StatusBadge status="confirmed" /><span className="text-lg font-semibold text-slate-900">{confirmedCount}</span></div>
            <p className="text-sm text-slate-600">Confirmed mappings are trusted and used by imports and reprocessing.</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between gap-2"><StatusBadge status="needs_review" /><span className="text-lg font-semibold text-slate-900">{needsReviewCount}</span></div>
            <p className="text-sm text-slate-600">Needs Review entries are created from imported VMS product IDs or names that could not be matched.</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between gap-2"><StatusBadge status="ignored" /><span className="text-lg font-semibold text-slate-900">{ignoredCount}</span></div>
            <p className="text-sm text-slate-600">Ignored: product should not affect operations.</p>
          </div>
        </div>
      </section>

      {!mappings?.length ? (
        <EmptyState title="No VMS products imported yet." body="Upload a VMS report to detect products." />
      ) : !rows.length ? (
        <EmptyState title="No mappings match these filters" body="Adjust the search or status filter to view more VMS products." />
      ) : (
        <DataTable headers={["VMS Product ID", "VMS Product Name", "Snacky Product", "VMS Selling", "VMS Cost", "Latest Machine", "Match Status", "Last Seen", "Actions"]}>
          {rows.map((mapping: any) => (
            <tr key={mapping.id}>
              <td>{mapping.vms_product_id ?? "-"}</td>
              <td className="font-medium text-slate-900">{mapping.vms_product_name}</td>
              <td>{mapping.product?.name ?? <span className="text-slate-400">Unmapped</span>}</td>
              <td>{formatMoney(mapping.vms_selling_price_lyd)}</td>
              <td>{formatMoney(mapping.vms_cost_price_lyd, 4)}</td>
              <td>{mapping.latest_machine_name ?? "-"}</td>
              <td><StatusBadge status={mapping.match_status} /></td>
              <td>{formatDate(mapping.last_seen_at)}</td>
              <td>
                <Link className="link-secondary" href={`/vms-mappings/${mapping.id}/edit`}>
                  Edit
                </Link>
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </AppShell>
  );
}
