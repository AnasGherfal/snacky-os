import Link from "next/link";
import { redirect } from "next/navigation";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { LocalDraftForm } from "@/components/LocalDraft";
import { DataTable, ErrorState, FormField, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { applyHistoricalRouteDeduction, cancelHistoricalRouteDeduction, previewHistoricalRouteDeduction } from "@/lib/historical-route-deduction-actions";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { formatMachineDisplayName } from "@/lib/machine-site-display";

export const dynamic = "force-dynamic";

type SearchParams = {
  batchId?: string;
  error?: string;
  applied?: string;
  cancelled?: string;
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "-";
}

function StatCard({ label, value, note, tone = "default" }: { label: string; value: string | number; note?: string; tone?: "default" | "warn" | "ok" }) {
  const toneClass = tone === "warn" ? "border-amber-200 bg-amber-50" : tone === "ok" ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white";
  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {note ? <div className="mt-1 text-xs leading-5 text-slate-600">{note}</div> : null}
    </div>
  );
}

function InlineEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
      <div className="font-semibold text-slate-900">{title}</div>
      <p className="mt-1 leading-6 text-slate-500">{body}</p>
    </div>
  );
}

function productLabel(line: any) {
  const product = Array.isArray(line.product) ? line.product[0] : line.product;
  return product?.name ?? line.product_alias ?? "Unknown product";
}

function machineLabel(line: any) {
  const machine = Array.isArray(line.machine) ? line.machine[0] : line.machine;
  const machineName = formatMachineDisplayName(machine as any, { includeArea: true });
  return machineName === "Unknown machine" ? line.machine_alias ?? line.section_name ?? machineName : machineName;
}

function storageLabel(line: any) {
  const storage = Array.isArray(line.storage) ? line.storage[0] : line.storage;
  return storage?.name ?? "-";
}

function groupReadyLines(lines: any[]) {
  const groups = new Map<string, { key: string; machineName: string; sectionName: string | null; totalQuantity: number; lines: any[] }>();
  for (const line of lines.filter((item) => item.status === "ready" || item.status === "applied")) {
    const key = line.machine_id ?? line.machine_alias ?? line.section_name ?? "unknown";
    const group = groups.get(key) ?? {
      key,
      machineName: machineLabel(line),
      sectionName: line.section_name ?? null,
      totalQuantity: 0,
      lines: [] as any[],
    };
    group.lines.push(line);
    group.totalQuantity += Number(line.quantity ?? 0);
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((a, b) => a.machineName.localeCompare(b.machineName));
}

function reviewGroupKey(line: any) {
  const reason = String(line.review_reason ?? "Needs review");
  const lower = reason.toLowerCase();
  if (lower.includes("machine")) return `machine:${line.machine_alias ?? line.section_name ?? "missing"}`;
  if (lower.includes("product")) return `product:${line.product_alias ?? "missing"}`;
  if (lower.includes("quantity")) return `quantity:${line.product_alias ?? line.original_text}`;
  return `review:${reason}:${line.product_alias ?? line.machine_alias ?? ""}`;
}

function groupReviewLines(lines: any[]) {
  const groups = new Map<string, { key: string; reason: string; machineAlias: string; productAlias: string; count: number; lineNumbers: number[]; examples: string[] }>();
  for (const line of lines.filter((item) => item.status === "needs_review")) {
    const key = reviewGroupKey(line);
    const group = groups.get(key) ?? {
      key,
      reason: String(line.review_reason ?? "Needs review"),
      machineAlias: line.machine_alias ?? line.section_name ?? "-",
      productAlias: line.product_alias ?? "-",
      count: 0,
      lineNumbers: [] as number[],
      examples: [] as string[],
    };
    group.count += 1;
    group.lineNumbers.push(Number(line.line_number ?? 0));
    if (group.examples.length < 3) group.examples.push(String(line.original_text ?? ""));
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function batchTitle(batch: any) {
  return `Batch ${shortId(batch.id)}`;
}

export default async function HistoricalRouteDeductionPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const profile = await getCurrentProfile();
  if (!isOwnerAdminRole(profile)) redirect("/unauthorized");

  const params = await searchParams;
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return <ErrorState title="Historical deduction unavailable" body="Supabase is not configured, so Snacky OS cannot preview or apply storage deductions." />;
  }

  const [{ data: batches, error: batchesError }, selectedBatchResult, selectedLinesResult] = await Promise.all([
    supabase
      .from("historical_route_deduction_batches")
      .select("id, status, row_count, ready_row_count, needs_review_count, total_quantity, created_by, applied_by, created_at, previewed_at, applied_at, notes")
      .order("created_at", { ascending: false })
      .limit(20),
    params.batchId
      ? supabase
          .from("historical_route_deduction_batches")
          .select("id, status, original_text, row_count, ready_row_count, needs_review_count, total_quantity, created_by, applied_by, cancelled_by, created_at, previewed_at, applied_at, cancelled_at, notes")
          .eq("id", params.batchId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    params.batchId
      ? supabase
          .from("historical_route_deduction_lines")
          .select("id, line_number, section_name, machine_alias, machine_id, product_alias, product_id, quantity, original_text, status, review_reason, storage_qty_before, storage_qty_after, storage_negative_warning, movement_id, applied_at, product:products(id, name, sku), machine:machines(id, name, machine_code, location:locations(id, name)), storage:storage_locations(id, name)")
          .eq("import_batch_id", params.batchId)
          .order("line_number", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ]);

  const loadError = batchesError ?? selectedBatchResult.error ?? selectedLinesResult.error;
  if (loadError) {
    console.error("[historical-route-deduction] Failed to load page", loadError);
    return <ErrorState title="Could not load historical deduction" body="Snacky OS could not load deduction batches or preview rows." action={<SecondaryButton href="/admin/historical-route-deduction">Retry</SecondaryButton>} />;
  }

  const selectedBatch = selectedBatchResult.data;
  const lines = selectedLinesResult.data ?? [];
  const readyGroups = groupReadyLines(lines);
  const reviewGroups = groupReviewLines(lines);
  const warningCount = lines.filter((line: any) => line.storage_negative_warning).length;
  const userIds = Array.from(new Set((batches ?? []).flatMap((batch: any) => [batch.created_by, batch.applied_by]).filter(Boolean)));
  const { data: users } = userIds.length
    ? await supabase.from("team_members").select("id, full_name").in("id", userIds)
    : { data: [] };
  const userById = new Map((users ?? []).map((user: any) => [String(user.id), user.full_name]));

  return (
    <>
      <PageHeader
        title="Historical Route Deduction"
        subtitle="One-time storage correction for old route/refill notes that were filled manually but never deducted from storage."
        action={<SecondaryButton href="/inventory/movements?reason=historical_route_deduction">View ledger entries</SecondaryButton>}
      />

      {params.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{params.error}</div> : null}
      {params.applied ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Applied {params.applied} historical storage deduction movement(s).</div> : null}
      {params.cancelled ? <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-medium text-slate-700">Batch cancelled.</div> : null}

      <section className="mb-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <LocalDraftForm action={previewHistoricalRouteDeduction} formType="historical-route-deduction" draftKeyParts={["preview"]} className="surface-card space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Paste Old Route Text</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              Sections can start with @location names such as @الخليج, @التحدي, @الاستقلال, @مواصفات, or اتش مول. Previewing does not change inventory.
            </p>
          </div>
          <FormField label="Old route/refill text" required>
            <textarea name="original_text" required rows={16} className="field-input font-mono text-sm" placeholder="@الخليج&#10;دوريتوس ز 5&#10;1 ميه&#10;&#10;@التحدي&#10;بيبسي 3" />
          </FormField>
          <FormField label="Batch note">
            <input name="notes" className="field-input" placeholder="Optional reference for this historical correction" />
          </FormField>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
            This feature creates inventory movements only. It does not create purchases, sales, cash entries, or finance transactions.
          </div>
          <button className="btn-primary">Preview deduction</button>
        </LocalDraftForm>

        <section className="surface-card">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Recent Batches</h2>
          {!batches?.length ? (
            <InlineEmpty title="No historical batches yet" body="Paste old route data to create the first preview batch." />
          ) : (
            <div className="space-y-3">
              {batches.map((batch: any) => (
                <Link key={batch.id} href={`/admin/historical-route-deduction?batchId=${batch.id}`} className="block rounded-lg border border-slate-200 bg-white p-3 transition hover:border-slate-300">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-900">{batchTitle(batch)}</div>
                      <div className="mt-1 text-xs text-slate-500">{formatDateTime(batch.created_at)}</div>
                    </div>
                    <StatusBadge status={batch.status} />
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-600">
                    <div><span className="block font-semibold text-slate-900">{batch.ready_row_count}</span>Ready</div>
                    <div><span className="block font-semibold text-slate-900">{batch.needs_review_count}</span>Review</div>
                    <div><span className="block font-semibold text-slate-900">{batch.total_quantity}</span>Qty</div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </section>

      {selectedBatch ? (
        <section className="space-y-5">
          <section className="surface-card">
            <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">{batchTitle(selectedBatch)}</h2>
                <p className="mt-1 text-sm leading-6 text-slate-500">
                  Previewed {formatDateTime(selectedBatch.previewed_at ?? selectedBatch.created_at)}
                  {selectedBatch.created_by ? ` by ${userById.get(String(selectedBatch.created_by)) ?? "Unknown"}` : ""}.
                </p>
                {selectedBatch.notes ? <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-amber-800">{selectedBatch.notes}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={selectedBatch.status} />
                {selectedBatch.status === "previewed" && selectedBatch.ready_row_count > 0 ? (
                  <ConfirmDialog
                    action={applyHistoricalRouteDeduction}
                    triggerLabel="Apply deduction"
                    title="Apply historical storage deduction?"
                    description="This can only be applied once. Snacky OS will create inventory ledger movements from storage to historical route correction and will not create purchases, sales, cash entries, or finance transactions."
                    confirmLabel="Apply once"
                    buttonClassName="btn-danger px-3 py-2"
                    confirmButtonClassName="btn-danger"
                    hiddenFields={[{ name: "batch_id", value: selectedBatch.id }]}
                    requireReason={false}
                  />
                ) : null}
                {selectedBatch.status !== "applied" && selectedBatch.status !== "cancelled" ? (
                  <ConfirmDialog
                    action={cancelHistoricalRouteDeduction}
                    triggerLabel="Cancel"
                    title="Cancel historical deduction batch?"
                    description="This leaves the preview and audit trail in place, but no storage movements will be created."
                    confirmLabel="Cancel batch"
                    buttonClassName="btn-secondary px-3 py-2"
                    hiddenFields={[{ name: "batch_id", value: selectedBatch.id }]}
                  />
                ) : null}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <StatCard label="Parsed rows" value={selectedBatch.row_count} />
              <StatCard label="Ready rows" value={selectedBatch.ready_row_count} tone="ok" />
              <StatCard label="Needs review" value={selectedBatch.needs_review_count} tone={selectedBatch.needs_review_count ? "warn" : "default"} />
              <StatCard label="Ready quantity" value={selectedBatch.total_quantity} />
              <StatCard label="Negative warnings" value={warningCount} tone={warningCount ? "warn" : "default"} note={warningCount ? "Resolve before applying." : undefined} />
            </div>
          </section>

          {readyGroups.length ? (
            <section className="space-y-4">
              {readyGroups.map((group) => (
                <section key={group.key} className="surface-card">
                  <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h3 className="text-base font-semibold text-slate-900">{group.machineName}</h3>
                      <p className="mt-1 text-sm text-slate-500">Section: {group.sectionName ?? "-"} - Total quantity {group.totalQuantity}</p>
                    </div>
                    <StatusBadge status={selectedBatch.status === "applied" ? "applied" : "ready"} />
                  </div>
                  <DataTable headers={["Line", "Product", "Alias", "Qty", "Storage", "After", "Warning", "Original text"]}>
                    {group.lines.map((line) => (
                      <tr key={line.id}>
                        <td>{line.line_number}</td>
                        <td className="font-medium text-slate-900">{productLabel(line)}</td>
                        <td>{line.product_alias ?? "-"}</td>
                        <td className="font-semibold">{line.quantity}</td>
                        <td>{storageLabel(line)} ({line.storage_qty_before ?? 0})</td>
                        <td>{line.storage_qty_after ?? "-"}</td>
                        <td>{line.storage_negative_warning ? <StatusBadge status="negative storage warning" /> : "-"}</td>
                        <td className="max-w-sm">{line.original_text}</td>
                      </tr>
                    ))}
                  </DataTable>
                </section>
              ))}
            </section>
          ) : (
            <InlineEmpty title="No ready rows" body="Every parsed row needs review, so nothing can be applied yet." />
          )}

          <section className="surface-card">
            <h2 className="mb-4 text-lg font-semibold text-slate-900">Needs Review</h2>
            {!reviewGroups.length ? (
              <InlineEmpty title="No review groups" body="All parsed rows have a clear machine, product, and quantity." />
            ) : (
              <DataTable headers={["Issue", "Count", "Machine value", "Product value", "Lines", "Examples"]}>
                {reviewGroups.map((group) => (
                  <tr key={group.key}>
                    <td className="max-w-md">{group.reason}</td>
                    <td className="font-semibold">{group.count}</td>
                    <td>{group.machineAlias}</td>
                    <td>{group.productAlias}</td>
                    <td>{group.lineNumbers.join(", ")}</td>
                    <td className="max-w-md">{group.examples.join(" | ")}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </section>
        </section>
      ) : null}
    </>
  );
}
