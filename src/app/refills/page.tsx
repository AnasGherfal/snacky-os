import { DataTable, EmptyState, MobileCardList, MobileField, MobileRecordCard, PageHeader, StatusBadge } from "@/components/ui";
import { requireCurrentProfileForPath } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function formatRecommendationQty(value: number | null | undefined) {
  return value === null || value === undefined ? "Capacity missing" : value;
}

type RefillRecommendationRow = {
  machine_name: string | null;
  slot_code: string | null;
  product_name: string | null;
  current_qty: number | null;
  capacity: number | null;
  par_qty: number | null;
  suggested_qty: number | null;
  final_qty_to_take: number | null;
  available_storage_qty: number | null;
  priority: string | null;
  imported_at: string | null;
};

export default async function RefillsPage() {
  await requireCurrentProfileForPath("/refills");
  const supabase = getSupabaseServerClient();
  const [recommendationsResult, stockCountResult, historyResult, historyCountResult, historyIssueCountResult] = supabase
    ? await Promise.all([
        supabase
          .from("refill_recommendations")
          .select("machine_name, slot_code, product_name, current_qty, capacity, par_qty, suggested_qty, final_qty_to_take, available_storage_qty, priority, latest_vms_at, imported_at")
          .order("suggested_qty", { ascending: false }),
        supabase
          .from("vms_stock_snapshots")
          .select("id", { count: "exact", head: true })
          .eq("import_row_status", "imported"),
        supabase
          .from("machine_refill_history")
          .select("id, legacy_refill_id, refill_at, machine_name, operator_email, fill_status, issues_found, issue_notes, machine_photo_url, machine_photo_path, linked_issue_id, machine:machines(name, machine_code), operator:team_members(full_name, email)")
          .order("refill_at", { ascending: false })
          .limit(100),
        supabase
          .from("machine_refill_history")
          .select("id", { count: "exact", head: true }),
        supabase
          .from("machine_refill_history")
          .select("id", { count: "exact", head: true })
          .eq("issues_found", true),
      ])
    : [{ data: null, error: null }, { count: 0, error: null }, { data: null, error: null }, { count: 0, error: null }, { count: 0, error: null }];
  const { data: recommendations, error } = recommendationsResult;
  const recommendationRows = (recommendations ?? []) as RefillRecommendationRow[];
  const hasVmsStock = Boolean((stockCountResult.count ?? 0) > 0);
  const historyUnavailable = historyResult.error?.code === "PGRST205";
  const historyRows = historyUnavailable ? [] : ((historyResult.data ?? []) as any[]);

  if (error ?? stockCountResult.error) console.error("[refills] Failed to load refill recommendations", error ?? stockCountResult.error);
  if (historyResult.error && !historyUnavailable) console.error("[refills] Failed to load machine refill history", historyResult.error);

  return (
    <>
      <PageHeader title="Refills" subtitle="System recommendations plus machine refill completion proofs from imported history and live operator work." />
      {!supabase ? (
        <EmptyState title="Connect Supabase to activate refills" body="Add environment variables and restart the app." />
      ) : (
        <div className="space-y-6">
          <section>
            <div className="mb-3 flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-slate-900">Refill recommendations</h2>
              <p className="text-sm text-slate-500">Generated from imported VMS machine goods stock and current storage availability.</p>
            </div>
            {!hasVmsStock ? (
              <EmptyState title="No VMS stock synced yet" body="Sync XY VMS Machine Goods to generate refill recommendations." />
            ) : !recommendationRows.length ? (
              <EmptyState title="No refill recommendations yet" body="All synced VMS stock is either full, inactive, or waiting on product mapping review." />
            ) : (
              <DataTable headers={["Machine", "VMS slot", "Product", "Current", "Capacity", "Need", "Take", "Storage", "Priority", "Latest import"]}>
                {recommendationRows.map((row, index) => (
                  <tr key={`${row.machine_name}-${row.slot_code}-${row.product_name}-${index}`}>
                    <td className="font-medium">{row.machine_name}</td>
                    <td>{row.slot_code ?? "VMS item"}</td>
                    <td>{row.product_name}</td>
                    <td>{row.current_qty}</td>
                    <td>{formatRecommendationQty(row.capacity ?? row.par_qty)}</td>
                    <td>{formatRecommendationQty(row.suggested_qty)}</td>
                    <td className="font-semibold text-slate-900">{formatRecommendationQty(row.final_qty_to_take ?? row.suggested_qty)}</td>
                    <td>{row.available_storage_qty}</td>
                    <td><StatusBadge status={row.priority} /></td>
                    <td>{row.imported_at ? new Date(row.imported_at).toLocaleString("en-US") : "-"}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </section>

          <section>
            <div className="mb-3 flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-slate-900">Machine refill history</h2>
              <p className="text-sm text-slate-500">Imported old operator forms and live completion proofs. Imported CSV rows stay as history only; live operator stops also create inventory movements.</p>
            </div>
            {historyUnavailable ? (
              <EmptyState title="Refill history not installed" body="Run the machine_refill_history migration to save refill completion proofs." />
            ) : !historyRows.length ? (
              <EmptyState title="No refill history yet" body="Complete an operator machine stop or import old machine refill forms." />
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="surface-card"><div className="text-sm text-slate-500">Total refill proofs</div><div className="mt-1 text-3xl font-semibold text-slate-900">{historyCountResult.count ?? historyRows.length}</div></div>
                  <div className="surface-card"><div className="text-sm text-slate-500">Issue flags</div><div className="mt-1 text-3xl font-semibold text-slate-900">{historyIssueCountResult.count ?? 0}</div></div>
                  <div className="surface-card"><div className="text-sm text-slate-500">Latest refill</div><div className="mt-1 text-lg font-semibold text-slate-900">{historyRows[0]?.refill_at ? new Date(historyRows[0].refill_at).toLocaleDateString("en-US") : "-"}</div></div>
                </div>
                <MobileCardList>
                  {historyRows.map((row: any) => (
                    <MobileRecordCard key={row.id}>
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="break-words font-semibold text-slate-900">{row.machine?.name ?? row.machine_name}</h3>
                          <p className="mt-1 text-sm text-slate-500">{row.refill_at ? new Date(row.refill_at).toLocaleString("en-US") : "-"}</p>
                        </div>
                        <StatusBadge status={row.fill_status || "unknown"} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <MobileField label="Operator">{row.operator?.full_name ?? row.operator_email ?? "-"}</MobileField>
                        <MobileField label="Issue">{row.issues_found ? "Yes" : "No"}</MobileField>
                      </div>
                      {row.issue_notes ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{row.issue_notes}</p> : null}
                      {row.machine_photo_url ? (
                        <a className="mt-3 inline-flex text-sm font-semibold text-amber-700" href={row.machine_photo_url} target="_blank" rel="noreferrer">Open photo</a>
                      ) : row.machine_photo_path ? (
                        <p className="mt-3 break-all text-xs text-slate-500">{row.machine_photo_path}</p>
                      ) : null}
                    </MobileRecordCard>
                  ))}
                </MobileCardList>
                <DataTable className="hidden md:block" headers={["Date", "Machine", "Operator", "Status", "Issue", "Photo", "Source ID"]}>
                  {historyRows.map((row: any) => (
                    <tr key={row.id}>
                      <td>{row.refill_at ? new Date(row.refill_at).toLocaleString("en-US") : "-"}</td>
                      <td className="font-medium">{row.machine?.name ?? row.machine_name}</td>
                      <td>{row.operator?.full_name ?? row.operator_email ?? "-"}</td>
                      <td><StatusBadge status={row.fill_status || "unknown"} /></td>
                      <td>{row.issues_found ? <StatusBadge status="review" /> : <StatusBadge status="ok" />}{row.issue_notes ? <div className="mt-1 max-w-xs text-xs text-slate-500">{row.issue_notes}</div> : null}</td>
                      <td>{row.machine_photo_url ? <a className="link-secondary" href={row.machine_photo_url} target="_blank" rel="noreferrer">Open</a> : row.machine_photo_path ? <span className="text-xs text-slate-500">{row.machine_photo_path}</span> : "-"}</td>
                      <td>{row.legacy_refill_id}</td>
                    </tr>
                  ))}
                </DataTable>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
