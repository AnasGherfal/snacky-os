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

function snapshotKey(productId: string | null | undefined, productName: string | null | undefined) {
  return `${productId ?? ""}::${productName ?? ""}`.toLowerCase();
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
  const [{ data: mappings }, { data: snapshots }] = supabase
    ? await Promise.all([
        supabase
          .from("vms_product_mappings")
          .select("id, vms_product_id, vms_product_name, product_id, match_status, updated_at, product:products(id, name, sku)")
          .order("updated_at", { ascending: false }),
        supabase
          .from("vms_stock_snapshots")
          .select("vms_product_id, vms_product_name, captured_at")
          .order("captured_at", { ascending: false })
          .limit(1000),
      ])
    : [{ data: [] }, { data: [] }];

  const lastSeenByMapping = new Map<string, string>();
  (snapshots ?? []).forEach((snapshot: any) => {
    const key = snapshotKey(snapshot.vms_product_id, snapshot.vms_product_name);
    if (!lastSeenByMapping.has(key)) lastSeenByMapping.set(key, snapshot.captured_at);
  });

  const rows = (mappings ?? [])
    .filter((mapping: any) => activeStatus === "all" || mapping.match_status === activeStatus)
    .filter((mapping: any) => {
      if (!search) return true;
      return (
        String(mapping.vms_product_name ?? "").toLowerCase().includes(search) ||
        String(mapping.product?.name ?? "").toLowerCase().includes(search)
      );
    });

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
              placeholder="Search VMS or Snacky product name..."
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
            <div className="mb-2"><StatusBadge status="confirmed" /></div>
            <p className="text-sm text-slate-600">Confirmed: mapping is trusted and used by imports.</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-2"><StatusBadge status="needs_review" /></div>
            <p className="text-sm text-slate-600">Needs Review: imported product needs manual matching.</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-2"><StatusBadge status="ignored" /></div>
            <p className="text-sm text-slate-600">Ignored: product should not affect operations.</p>
          </div>
        </div>
      </section>

      {!mappings?.length ? (
        <EmptyState title="No VMS products imported yet." body="Upload a VMS report to detect products." />
      ) : !rows.length ? (
        <EmptyState title="No mappings match these filters" body="Adjust the search or status filter to view more VMS products." />
      ) : (
        <DataTable headers={["VMS Product ID", "VMS Product Name", "Snacky Product", "Match Status", "Last Seen", "Actions"]}>
          {rows.map((mapping: any) => {
            const lastSeen = lastSeenByMapping.get(snapshotKey(mapping.vms_product_id, mapping.vms_product_name));
            return (
              <tr key={mapping.id}>
                <td>{mapping.vms_product_id ?? "-"}</td>
                <td className="font-medium text-slate-900">{mapping.vms_product_name}</td>
                <td>{mapping.product?.name ?? <span className="text-slate-400">Unmapped</span>}</td>
                <td><StatusBadge status={mapping.match_status} /></td>
                <td>{formatDate(lastSeen)}</td>
                <td>
                  <Link className="link-secondary" href={`/vms-mappings/${mapping.id}/edit`}>
                    Edit
                  </Link>
                </td>
              </tr>
            );
          })}
        </DataTable>
      )}
    </AppShell>
  );
}
