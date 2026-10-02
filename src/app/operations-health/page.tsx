
import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function fmt(value: unknown) {
  if (!value) return "-";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Tripoli" }).format(d);
}
function daysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

export default async function OperationsHealthPage() {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !hasAnyRole(profile, ["owner", "admin", "supervisor"])) redirect("/unauthorized");
  const db = getSupabaseAdminClient();
  if (!db) return <EmptyState title="Data Health unavailable" body="The server database connection is unavailable." />;

  const staleRefillCutoff = daysAgo(2);
  const cashCurrentCutoff = daysAgo(30);
  const cashStaleCutoff = daysAgo(3);
  const vmsRecentCutoff = daysAgo(30);
  const legacyCutoff = daysAgo(14);

  const [
    machinesResult,
    locationsResult,
    negativeInventoryResult,
    staleRefillsResult,
    cashCurrentResult,
    cashLegacyResult,
    vmsRecentResult,
    vmsLegacyResult,
  ] = await Promise.all([
    db.from("machines").select("id,machine_code,name,status,location_id,location:locations(id,name,address,distance_from_storage_km)").order("machine_code"),
    db.from("locations").select("id,name,address,status,distance_from_storage_km").eq("status", "active").order("name"),
    db.from("current_inventory_by_location").select("product_id,product_name,location_type,location_id,location_name,quantity_on_hand").lt("quantity_on_hand", 0).order("quantity_on_hand", { ascending: true }).limit(100),
    db.from("refill_orders").select("id,machine_id,status,generated_at,route_id,notes,machine:machines(name,machine_code)").not("status", "in", "(completed,cancelled)").lt("generated_at", staleRefillCutoff).order("generated_at", { ascending: true }).limit(100),
    db.from("cash_collections").select("id,machine_id,reconciliation_status,variance,collected_at,actual_cash_collected,vms_expected_cash").is("voided_at", null).in("reconciliation_status", ["pending","variance_review"]).gte("collected_at", cashCurrentCutoff).lt("collected_at", cashStaleCutoff).order("collected_at", { ascending: true }).limit(100),
    db.from("cash_collections").select("id,reconciliation_status,collected_at").is("voided_at", null).in("reconciliation_status", ["pending","variance_review"]).lt("collected_at", cashCurrentCutoff).order("collected_at", { ascending: true }).limit(500),
    db.from("vms_import_batches").select("id,file_name,original_file_name,report_type,status,error_count,rows_needing_review,latest_error,imported_at,uploaded_at,is_active,deleted_at").is("deleted_at", null).in("status", ["failed","partially_imported","imported_with_warnings"]).gte("uploaded_at", vmsRecentCutoff).order("uploaded_at", { ascending: false }).limit(100),
    db.from("vms_import_batches").select("id,status,uploaded_at").is("deleted_at", null).in("status", ["draft","previewed"]).lt("uploaded_at", legacyCutoff).order("uploaded_at", { ascending: true }).limit(500),
  ]);

  const machines = machinesResult.data ?? [];
  const locations = locationsResult.data ?? [];
  const missingMachineLocation = machines.filter((m: any) => !m.location_id);
  const missingDistance = locations.filter((l: any) => l.distance_from_storage_km === null || l.distance_from_storage_km === undefined);
  const negativeInventory = negativeInventoryResult.data ?? [];
  const staleRefills = staleRefillsResult.data ?? [];
  const cashCurrent = cashCurrentResult.data ?? [];
  const cashLegacy = cashLegacyResult.data ?? [];
  const vmsRecent = vmsRecentResult.data ?? [];
  const vmsLegacy = vmsLegacyResult.data ?? [];

  const currentExceptions = [
    { label: "Machines missing site", value: missingMachineLocation.length, href: "/machines/setup", critical: true },
    { label: "Active sites missing distance", value: missingDistance.length, href: "/machines/setup", critical: true },
    { label: "Negative stock balances", value: negativeInventory.length, href: "/inventory/reconciliation", critical: true },
    { label: "Stale refill orders (>48h)", value: staleRefills.length, href: "/refills", critical: staleRefills.length > 0 },
    { label: "Cash actions 3–30 days old", value: cashCurrent.length, href: "/cash-collections", critical: cashCurrent.length > 0 },
    { label: "Recent VMS failures / partial", value: vmsRecent.length, href: "/vms-import", critical: vmsRecent.length > 0 },
  ];

  return <div className="space-y-6">
    <PageHeader
      title="Data Health"
      subtitle="Owner exception center: fix current operational data first, then clean legacy backlog without mixing the two."
      action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/machines/setup">Machine setup</SecondaryButton><SecondaryButton href="/dashboard">Dashboard</SecondaryButton></div>}
    />

    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {currentExceptions.map((item) => <Link key={item.label} href={item.href} className={"rounded-xl border p-4 "+(item.critical && item.value > 0 ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-white")}>
        <div className="text-xs font-medium text-slate-500">{item.label}</div>
        <div className="mt-1 text-3xl font-semibold text-slate-950">{item.value}</div>
        <div className="mt-2 text-xs text-sky-800">Open records →</div>
      </Link>)}
    </section>

    <section className="surface-card">
      <div className="mb-4"><h2 className="text-lg font-semibold">Machine & location setup</h2><p className="mt-1 text-sm text-slate-500">Operating machines need a current site; active sites need one-way distance from storage.</p></div>
      {!missingMachineLocation.length && !missingDistance.length ? <EmptyState title="Machine setup is complete" body="Every machine has a site and every active site has a distance." /> :
      <div className="grid gap-5 xl:grid-cols-2">
        <div><h3 className="mb-2 font-medium">Machines without site</h3>{!missingMachineLocation.length ? <p className="text-sm text-slate-500">None.</p> :
          <div className="space-y-2">{missingMachineLocation.map((m: any) => <div key={m.id} className="rounded-lg border border-slate-200 p-3"><div className="font-medium">{m.name}</div><div className="text-xs text-slate-500">{m.machine_code} · {m.status}</div></div>)}</div>}
        </div>
        <div><h3 className="mb-2 font-medium">Sites missing distance</h3>{!missingDistance.length ? <p className="text-sm text-slate-500">None.</p> :
          <div className="space-y-2">{missingDistance.map((l: any) => <div key={l.id} className="rounded-lg border border-slate-200 p-3"><div className="font-medium">{l.name}</div><div className="text-xs text-slate-500">{l.address ?? "No address recorded"}</div></div>)}</div>}
        </div>
      </div>}
    </section>

    <section className="surface-card">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Negative inventory</h2><p className="mt-1 text-sm text-slate-500">Negative physical stock should be reconciled, not silently carried forward.</p></div><SecondaryButton href="/inventory/reconciliation">Open inventory reconciliation</SecondaryButton></div>
      {!negativeInventory.length ? <EmptyState title="No negative stock" body="Current inventory has no negative balances." /> :
      <DataTable headers={["Location","Type","Product","Quantity"]}>{negativeInventory.map((row: any, index: number) => <tr key={[row.location_type,row.location_id,row.product_id,index].join("-")}><td>{row.location_name ?? "-"}</td><td>{row.location_type}</td><td>{row.product_name}</td><td className="font-semibold text-rose-700">{Number(row.quantity_on_hand)}</td></tr>)}</DataTable>}
    </section>

    <section className="surface-card">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Stale refill work</h2><p className="mt-1 text-sm text-slate-500">Draft, assigned or picked refill orders older than 48 hours may still reserve stock or confuse today’s work.</p></div><SecondaryButton href="/refills">Open refills</SecondaryButton></div>
      {!staleRefills.length ? <EmptyState title="No stale refill orders" body="All unfinished refill work is recent." /> :
      <DataTable headers={["Generated","Machine","Status","Route","Notes"]}>{staleRefills.map((row: any) => <tr key={row.id}><td>{fmt(row.generated_at)}</td><td>{row.machine?.name ?? row.machine?.machine_code ?? row.machine_id ?? "-"}</td><td><StatusBadge status={row.status} /></td><td>{row.route_id ? <Link className="link-secondary" href={"/routes/"+row.route_id}>Open route</Link> : "-"}</td><td>{row.notes ?? "-"}</td></tr>)}</DataTable>}
    </section>

    <section className="surface-card">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Cash reconciliation</h2><p className="mt-1 text-sm text-slate-500">Current work is separated from older legacy backlog so today’s cash controls stay usable.</p></div><SecondaryButton href="/cash-collections">Open cash</SecondaryButton></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="text-xs font-medium text-amber-800">Actionable: 3–30 days old</div><div className="mt-1 text-3xl font-semibold">{cashCurrent.length}</div></div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="text-xs font-medium text-slate-600">Legacy: older than 30 days</div><div className="mt-1 text-3xl font-semibold">{cashLegacy.length}</div><p className="mt-1 text-xs text-slate-500">Backfill/archive separately; do not mix with current daily queue.</p></div>
      </div>
      {cashCurrent.length ? <div className="mt-4"><DataTable headers={["Collected","Status","Counted","Expected","Variance","Record"]}>{cashCurrent.slice(0,20).map((row: any)=><tr key={row.id}><td>{fmt(row.collected_at)}</td><td><StatusBadge status={row.reconciliation_status}/></td><td>{row.actual_cash_collected ?? "-"}</td><td>{row.vms_expected_cash ?? "-"}</td><td>{row.variance ?? "-"}</td><td><Link className="link-secondary" href={"/cash-collections/"+row.id}>Open</Link></td></tr>)}</DataTable></div> : null}
    </section>

    <section className="surface-card">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">VMS import health</h2><p className="mt-1 text-sm text-slate-500">Recent failed/partial imports are operational exceptions; old draft/preview batches are legacy cleanup.</p></div><SecondaryButton href="/vms-import">Open VMS imports</SecondaryButton></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4"><div className="text-xs font-medium text-rose-800">Recent failures / partial / warnings</div><div className="mt-1 text-3xl font-semibold">{vmsRecent.length}</div></div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="text-xs font-medium text-slate-600">Old draft / preview batches</div><div className="mt-1 text-3xl font-semibold">{vmsLegacy.length}</div></div>
      </div>
      {vmsRecent.length ? <div className="mt-4"><DataTable headers={["Uploaded","File","Type","Status","Errors","Review rows","Record"]}>{vmsRecent.slice(0,25).map((row: any)=><tr key={row.id}><td>{fmt(row.uploaded_at)}</td><td>{row.original_file_name ?? row.file_name ?? "-"}</td><td>{row.report_type ?? "-"}</td><td><StatusBadge status={row.status}/></td><td>{Number(row.error_count ?? 0)}</td><td>{Number(row.rows_needing_review ?? 0)}</td><td><Link className="link-secondary" href={"/vms-import/"+row.id}>Open</Link></td></tr>)}</DataTable></div>:null}
    </section>
  </div>;
}
