/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { DataTable, EmptyState, ErrorState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { getAuthenticatedSupabaseServerClient, requireCurrentProfileForPath } from "@/lib/auth";
import { lyd } from "@/lib/format";
import {
  reconciliationConfidenceExplanation,
  reconciliationNumber,
  reconciliationQuantity,
  reconciliationSalesSourceLabel,
  reconciliationStatusLabel,
  reconciliationStatusTone,
  reconciliationWholeNumber,
  type StockReconciliationVarianceRow,
} from "@/lib/stock-reconciliation";

export const dynamic = "force-dynamic";

const SESSION_TABLE = "stock_reconciliation_sessions";
const COUNT_TABLE = "stock_reconciliation_counts";
const CASE_TABLE = "stock_reconciliation_variance_cases";

type ReconciliationSearchParams = {
  session?: string;
  filter?: string;
  q?: string;
  product?: string;
  saved?: string;
  error?: string;
};

type SessionRow = {
  id: string;
  name: string;
  period_start: string;
  period_end: string;
  baseline_at: string;
  cutoff_at: string | null;
  status: string;
  notes: string | null;
  created_at: string;
};

type CountRow = {
  id: string;
  session_id: string;
  count_phase: "opening" | "closing";
  entity_type: "storage" | "machine" | "operator_bag";
  entity_id: string | null;
  entity_key: string;
  product_id: string;
  quantity_counted: number | string | null;
  count_source: "manual" | "ledger" | "vms";
  source_at: string | null;
  is_confirmed: boolean | null;
  counted_at: string | null;
  notes: string | null;
};

function text(value: unknown, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function dateOnly(value: unknown) {
  const candidate = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function currentMonthRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = now.toISOString().slice(0, 10);
  return { start, end };
}

function formatDateTime(value: unknown) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function errorText(error: any) {
  return [error?.code, error?.message, error?.details, error?.hint].map((value) => String(value ?? "").trim()).filter(Boolean).join(" - ");
}

function missingReconciliationSchema(error: any) {
  const value = errorText(error).toLowerCase();
  return ["stock_reconciliation", "snacky_stock_reconciliation", "snacky_create_stock_reconciliation", "snacky_capture_stock_reconciliation"].some((token) => value.includes(token))
    || error?.code === "PGRST202"
    || error?.code === "PGRST205"
    || error?.code === "42P01";
}

function reconciliationHref(sessionId: string | null, filter = "all", q = "", productId = "") {
  const params = new URLSearchParams();
  if (sessionId) params.set("session", sessionId);
  if (filter !== "all") params.set("filter", filter);
  if (q.trim()) params.set("q", q.trim());
  if (productId) params.set("product", productId);
  const query = params.toString();
  return query ? `/inventory/reconciliation?${query}` : "/inventory/reconciliation";
}

function manualCountValue(
  counts: CountRow[],
  productId: string,
  entityType: CountRow["entity_type"],
) {
  const row = counts.find((count) => count.product_id === productId
    && count.count_phase === "closing"
    && count.entity_type === entityType
    && count.count_source === "manual"
    && count.is_confirmed);
  return row ? String(reconciliationWholeNumber(row.quantity_counted)) : "";
}

function autoCountValue(
  counts: CountRow[],
  productId: string,
  entityType: CountRow["entity_type"],
) {
  return counts
    .filter((count) => count.product_id === productId
      && count.count_phase === "closing"
      && count.entity_type === entityType
      && count.count_source !== "manual")
    .reduce((sum, count) => sum + reconciliationWholeNumber(count.quantity_counted), 0);
}

function caseStatusOptions() {
  return [
    ["open", "Open"],
    ["investigating", "Investigating"],
    ["resolved", "Resolved"],
    ["adjusted", "Inventory adjusted"],
    ["accepted_loss", "Accepted loss"],
  ] as const;
}

async function createReconciliationSession(formData: FormData) {
  "use server";
  const profile = await requireCurrentProfileForPath("/inventory/reconciliation");
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) redirect("/inventory/reconciliation?error=Supabase%20is%20not%20configured");

  const periodStart = dateOnly(formData.get("period_start"));
  const periodEnd = dateOnly(formData.get("period_end"));
  const name = text(formData.get("name"));
  if (!name || !periodStart || !periodEnd || periodEnd < periodStart) {
    redirect(`/inventory/reconciliation?error=${encodeURIComponent("Enter a name and a valid reconciliation date range.")}`);
  }

  const { data, error } = await supabase.rpc("snacky_create_stock_reconciliation_session", {
    p_name: name,
    p_period_start: periodStart,
    p_period_end: periodEnd,
    p_created_by: profile.team_member_id ?? profile.id ?? null,
    p_notes: text(formData.get("notes")) || null,
  });
  if (error || !data) {
    console.error("[stock-reconciliation] Could not create session", error);
    const message = missingReconciliationSchema(error)
      ? "Apply the stock reconciliation migration before creating the first baseline."
      : "Could not create the stock reconciliation baseline.";
    redirect(`/inventory/reconciliation?error=${encodeURIComponent(message)}`);
  }

  const sessionId = Array.isArray(data) ? String(data[0] ?? "") : String(data);
  revalidatePath("/inventory/reconciliation");
  redirect(`/inventory/reconciliation?session=${encodeURIComponent(sessionId)}&saved=baseline`);
}

async function captureClosingSnapshot(formData: FormData) {
  "use server";
  const profile = await requireCurrentProfileForPath("/inventory/reconciliation");
  const sessionId = text(formData.get("session_id"));
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase || !sessionId) redirect("/inventory/reconciliation?error=Missing%20reconciliation%20session");

  const { error } = await supabase.rpc("snacky_capture_stock_reconciliation_closing", {
    p_session_id: sessionId,
    p_counted_by: profile.team_member_id ?? profile.id ?? null,
  });
  if (error) {
    console.error("[stock-reconciliation] Closing capture failed", error);
    const message = missingReconciliationSchema(error)
      ? "Apply the stock reconciliation migration before capturing closing stock."
      : "Could not capture closing stock from the ledger and latest VMS machine snapshot.";
    redirect(`/inventory/reconciliation?session=${encodeURIComponent(sessionId)}&error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/inventory/reconciliation");
  redirect(`/inventory/reconciliation?session=${encodeURIComponent(sessionId)}&saved=closing`);
}

async function savePhysicalCounts(formData: FormData) {
  "use server";
  const profile = await requireCurrentProfileForPath("/inventory/reconciliation");
  const sessionId = text(formData.get("session_id"));
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase || !sessionId) redirect("/inventory/reconciliation?error=Missing%20reconciliation%20session");

  const productIds = Array.from(new Set(formData.getAll("product_id").map((value) => text(value)).filter(Boolean)));
  const now = new Date().toISOString();
  const actorId = profile.team_member_id ?? profile.id ?? null;
  const payloads: Record<string, unknown>[] = [];

  for (const productId of productIds) {
    for (const entityType of ["storage", "machine", "operator_bag"] as const) {
      const raw = text(formData.get(`${entityType}__${productId}`));
      if (raw === "") continue;
      const quantity = Number(raw);
      if (!Number.isFinite(quantity) || quantity < 0) continue;
      payloads.push({
        session_id: sessionId,
        count_phase: "closing",
        entity_type: entityType,
        entity_id: null,
        entity_key: "manual-total",
        product_id: productId,
        quantity_counted: Math.floor(quantity),
        count_source: "manual",
        source_at: now,
        is_confirmed: true,
        counted_by: actorId,
        counted_at: now,
        notes: "Physical company total entered from Missing Items reconciliation",
        updated_at: now,
      });
    }
  }

  if (!payloads.length) {
    redirect(`/inventory/reconciliation?session=${encodeURIComponent(sessionId)}&error=${encodeURIComponent("Enter at least one physical count before saving.")}`);
  }

  const { error } = await supabase.from(COUNT_TABLE).upsert(payloads, {
    onConflict: "session_id,count_phase,entity_type,entity_key,product_id",
  });
  if (error) {
    console.error("[stock-reconciliation] Manual count save failed", error);
    const message = missingReconciliationSchema(error)
      ? "Apply the stock reconciliation migration before saving physical counts."
      : "Could not save physical stock counts.";
    redirect(`/inventory/reconciliation?session=${encodeURIComponent(sessionId)}&error=${encodeURIComponent(message)}`);
  }

  await supabase.from(SESSION_TABLE).update({ status: "review", updated_at: now }).eq("id", sessionId).neq("status", "closed");
  revalidatePath("/inventory/reconciliation");
  redirect(`/inventory/reconciliation?session=${encodeURIComponent(sessionId)}&saved=counts`);
}

async function saveVarianceCases(formData: FormData) {
  "use server";
  const profile = await requireCurrentProfileForPath("/inventory/reconciliation");
  const sessionId = text(formData.get("session_id"));
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase || !sessionId) redirect("/inventory/reconciliation?error=Missing%20reconciliation%20session");

  const productIds = Array.from(new Set(formData.getAll("case_product_id").map((value) => text(value)).filter(Boolean)));
  const now = new Date().toISOString();
  const payloads = productIds.map((productId) => {
    const status = text(formData.get(`case_status__${productId}`), "open");
    return {
      session_id: sessionId,
      product_id: productId,
      case_status: ["open", "investigating", "resolved", "adjusted", "accepted_loss"].includes(status) ? status : "open",
      resolution_reason: text(formData.get(`resolution_reason__${productId}`)) || null,
      notes: text(formData.get(`case_notes__${productId}`)) || null,
      reviewed_by: profile.team_member_id ?? profile.id ?? null,
      reviewed_at: now,
      updated_at: now,
    };
  });

  if (payloads.length) {
    const { error } = await supabase.from(CASE_TABLE).upsert(payloads, { onConflict: "session_id,product_id" });
    if (error) {
      console.error("[stock-reconciliation] Variance case save failed", error);
      redirect(`/inventory/reconciliation?session=${encodeURIComponent(sessionId)}&error=${encodeURIComponent("Could not save variance review cases.")}`);
    }
  }

  revalidatePath("/inventory/reconciliation");
  redirect(`/inventory/reconciliation?session=${encodeURIComponent(sessionId)}&saved=cases`);
}

async function closeReconciliationSession(formData: FormData) {
  "use server";
  const profile = await requireCurrentProfileForPath("/inventory/reconciliation");
  const sessionId = text(formData.get("session_id"));
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase || !sessionId) redirect("/inventory/reconciliation?error=Missing%20reconciliation%20session");

  const now = new Date().toISOString();
  const { error } = await supabase.from(SESSION_TABLE).update({
    status: "closed",
    closed_at: now,
    closed_by: profile.team_member_id ?? profile.id ?? null,
    updated_at: now,
  }).eq("id", sessionId);
  if (error) {
    console.error("[stock-reconciliation] Session close failed", error);
    redirect(`/inventory/reconciliation?session=${encodeURIComponent(sessionId)}&error=${encodeURIComponent("Could not close this reconciliation.")}`);
  }

  revalidatePath("/inventory/reconciliation");
  redirect(`/inventory/reconciliation?session=${encodeURIComponent(sessionId)}&saved=closed`);
}

export default async function StockReconciliationPage({ searchParams }: { searchParams: Promise<ReconciliationSearchParams> }) {
  await requireCurrentProfileForPath("/inventory/reconciliation");
  const params = await searchParams;
  const q = text(params.q).toLowerCase();
  const filter = ["all", "missing", "review", "balanced"].includes(text(params.filter)) ? text(params.filter) : "all";
  const selectedProductId = text(params.product);
  const supabase = await getAuthenticatedSupabaseServerClient();
  const defaults = currentMonthRange();

  if (!supabase) {
    return <ErrorState title="Stock reconciliation unavailable" body="Supabase is not configured." />;
  }

  const sessionsResult = await supabase
    .from(SESSION_TABLE)
    .select("id, name, period_start, period_end, baseline_at, cutoff_at, status, notes, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (sessionsResult.error && missingReconciliationSchema(sessionsResult.error)) {
    return (
      <>
        <PageHeader title="Missing Items & Stock Reconciliation" subtitle="Find unexplained stock loss by comparing opening stock, purchases, successful sales, approved losses, and closing physical stock." action={<SecondaryButton href="/inventory">Back to Inventory</SecondaryButton>} />
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">
          <div className="font-semibold">Stock reconciliation setup is not installed</div>
          <p className="mt-2">Apply migration <code>202607170001_stock_reconciliation_missing_items.sql</code>. Existing inventory, VMS, purchase, route, and finance rows are preserved.</p>
        </div>
      </>
    );
  }

  if (sessionsResult.error) {
    console.error("[stock-reconciliation] Session load failed", sessionsResult.error);
    return <ErrorState title="Missing Items could not load" body="Snacky OS could not load stock reconciliation sessions." />;
  }

  const sessions = (sessionsResult.data ?? []) as SessionRow[];
  const requestedSessionId = text(params.session);
  const selectedSession = sessions.find((session) => session.id === requestedSessionId) ?? sessions[0] ?? null;

  let varianceRows: StockReconciliationVarianceRow[] = [];
  let counts: CountRow[] = [];
  let varianceError: any = null;
  let selectedProductMovements: any[] = [];

  if (selectedSession) {
    const [varianceResult, countsResult] = await Promise.all([
      supabase.rpc("snacky_stock_reconciliation_variance", { p_session_id: selectedSession.id }),
      supabase
        .from(COUNT_TABLE)
        .select("id, session_id, count_phase, entity_type, entity_id, entity_key, product_id, quantity_counted, count_source, source_at, is_confirmed, counted_at, notes")
        .eq("session_id", selectedSession.id)
        .order("count_phase")
        .order("entity_type")
        .limit(20000),
    ]);
    varianceError = varianceResult.error ?? countsResult.error;
    varianceRows = (varianceResult.data ?? []) as StockReconciliationVarianceRow[];
    counts = (countsResult.data ?? []) as CountRow[];

    if (selectedProductId) {
      const movementsResult = await supabase
        .from("inventory_movements")
        .select("id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, related_route_id, notes, created_at")
        .eq("product_id", selectedProductId)
        .gte("created_at", `${selectedSession.period_start}T00:00:00.000Z`)
        .lt("created_at", `${new Date(Date.parse(`${selectedSession.period_end}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`)
        .order("created_at", { ascending: true })
        .limit(2000);
      if (!movementsResult.error) selectedProductMovements = movementsResult.data ?? [];
    }
  }

  if (varianceError) {
    console.error("[stock-reconciliation] Reconciliation data load failed", varianceError);
  }

  const filteredRows = varianceRows.filter((row) => {
    const matchesSearch = !q || [row.product_name, row.sku, row.category].some((value) => text(value).toLowerCase().includes(q));
    if (!matchesSearch) return false;
    if (filter === "missing") return reconciliationWholeNumber(row.missing_units) > 0;
    if (filter === "review") return ["confirmed_missing", "suspected_missing", "data_gap", "extra_found"].includes(text(row.variance_status));
    if (filter === "balanced") return row.variance_status === "balanced";
    return true;
  });

  const missingRows = varianceRows.filter((row) => reconciliationWholeNumber(row.missing_units) > 0);
  const missingUnits = missingRows.reduce((sum, row) => sum + reconciliationWholeNumber(row.missing_units), 0);
  const missingCost = missingRows.reduce((sum, row) => sum + reconciliationNumber(row.missing_cost), 0);
  const confirmedMissing = varianceRows.filter((row) => row.variance_status === "confirmed_missing").length;
  const suspectedMissing = varianceRows.filter((row) => row.variance_status === "suspected_missing").length;
  const dataGaps = varianceRows.filter((row) => row.variance_status === "data_gap").length;
  const expectedTotal = varianceRows.reduce((sum, row) => sum + reconciliationWholeNumber(row.expected_closing_units), 0);
  const actualTotal = varianceRows.reduce((sum, row) => sum + reconciliationWholeNumber(row.actual_closing_units), 0);
  const selectedProduct = varianceRows.find((row) => row.product_id === selectedProductId) ?? null;
  const selectedProductCounts = selectedProduct ? counts.filter((count) => count.product_id === selectedProduct.product_id) : [];

  return (
    <>
      <PageHeader
        title="Missing Items & Stock Reconciliation"
        subtitle="Compare a preserved opening checkpoint with purchases, successful VMS sales, approved losses, and closing stock across storage, machines, and operator bags. The system never adjusts inventory automatically."
        action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/inventory">Storage Inventory</SecondaryButton><SecondaryButton href="/inventory/movements">Movement Log</SecondaryButton></div>}
      />

      {params.error ? <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-900">{params.error}</div> : null}
      {params.saved ? <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">Reconciliation updated successfully.</div> : null}

      <section className="surface-card mb-6">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Reconciliation sessions</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">Start with a baseline. Later, capture the latest machine snapshot and enter physical storage/operator counts before reviewing shortages.</p>
            {!sessions.length ? (
              <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">No reconciliation baseline exists yet.</div>
            ) : (
              <div className="mt-4 flex flex-wrap gap-2">
                {sessions.map((session) => (
                  <Link key={session.id} href={reconciliationHref(session.id)} className={`rounded-lg border px-3 py-2 text-sm font-medium ${selectedSession?.id === session.id ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700"}`}>
                    {session.name} · {session.period_start} → {session.period_end}
                  </Link>
                ))}
              </div>
            )}
          </div>

          <form action={createReconciliationSession} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="font-semibold text-slate-950">Create opening baseline</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="sm:col-span-2"><span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Name</span><input name="name" className="field-input" defaultValue={`Stock reconciliation ${defaults.start.slice(0, 7)}`} required /></label>
              <label><span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Start</span><input name="period_start" type="date" className="field-input" defaultValue={defaults.start} required /></label>
              <label><span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">End/cutoff</span><input name="period_end" type="date" className="field-input" defaultValue={defaults.end} required /></label>
              <label className="sm:col-span-2"><span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</span><input name="notes" className="field-input" placeholder="Monthly close, cycle count, route investigation..." /></label>
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-500">For Monthly Product Profit sales, begin on the first day of the month. A baseline created after the period starts will correctly show a data-gap warning rather than pretending historical opening stock is known.</p>
            <FormSubmitButton className="btn-primary mt-4 w-full" pendingLabel="Creating baseline...">Create baseline</FormSubmitButton>
          </form>
        </div>
      </section>

      {!selectedSession ? (
        <EmptyState title="Create the first reconciliation baseline" body="The first baseline preserves opening storage, operator-bag, and latest VMS machine quantities. Future counts can then identify unexplained loss." />
      ) : (
        <>
          <section className="surface-card mb-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-semibold text-slate-950">{selectedSession.name}</h2><StatusBadge status={selectedSession.status} /></div>
                <p className="mt-1 text-sm text-slate-500">Period {selectedSession.period_start} → {selectedSession.period_end} · Baseline {formatDateTime(selectedSession.baseline_at)} · Closing capture {formatDateTime(selectedSession.cutoff_at)}</p>
                {selectedSession.notes ? <p className="mt-2 text-sm text-slate-700">{selectedSession.notes}</p> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <form action={captureClosingSnapshot}><input type="hidden" name="session_id" value={selectedSession.id} /><FormSubmitButton className="btn-primary" pendingLabel="Capturing stock...">Capture latest closing stock</FormSubmitButton></form>
                {selectedSession.status !== "closed" ? <form action={closeReconciliationSession}><input type="hidden" name="session_id" value={selectedSession.id} /><FormSubmitButton className="btn-secondary" pendingLabel="Closing...">Close reconciliation</FormSubmitButton></form> : null}
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950"><span className="font-semibold">Count rule:</span> machine stock comes from the latest VMS snapshot. Storage and operator values start as ledger estimates and become confirmed only after you enter physical totals below.</div>
          </section>

          {varianceError ? <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">Some reconciliation data could not load: {errorText(varianceError)}</div> : null}

          <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <Metric label="Missing units" value={missingUnits.toLocaleString()} helper="Unexplained expected stock not found" tone={missingUnits > 0 ? "danger" : "default"} />
            <Metric label="Missing cost" value={lyd(missingCost)} helper="Cost value, not selling value" tone={missingCost > 0 ? "danger" : "default"} />
            <Metric label="Products affected" value={missingRows.length.toLocaleString()} helper={`${confirmedMissing} confirmed · ${suspectedMissing} suspected`} tone={missingRows.length > 0 ? "warn" : "default"} />
            <Metric label="Data gaps" value={dataGaps.toLocaleString()} helper="Need a count or usable sales source" tone={dataGaps > 0 ? "warn" : "default"} />
            <Metric label="Expected closing" value={expectedTotal.toLocaleString()} helper="Opening + inflows − sales − losses" />
            <Metric label="Actual closing" value={actualTotal.toLocaleString()} helper="Storage + machines + operator bags" />
          </div>

          <section className="surface-card mb-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div><h2 className="text-lg font-semibold text-slate-950">Product reconciliation</h2><p className="mt-1 text-sm text-slate-500">Missing items are ranked by cost. Click a product to inspect its count and movement trail.</p></div>
              <form action="/inventory/reconciliation" className="flex flex-col gap-2 sm:flex-row">
                <input type="hidden" name="session" value={selectedSession.id} />
                {filter !== "all" ? <input type="hidden" name="filter" value={filter} /> : null}
                <input name="q" className="field-input" defaultValue={params.q ?? ""} placeholder="Search product, SKU, category..." />
                <button className="btn-secondary" type="submit">Search</button>
              </form>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {([['all','All'],['missing','Missing'],['review','Needs review'],['balanced','Balanced']] as const).map(([key, label]) => <Link key={key} href={reconciliationHref(selectedSession.id, key, text(params.q))} className={`rounded-full border px-3 py-2 text-sm font-medium ${filter === key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-slate-50 text-slate-700"}`}>{label}</Link>)}
            </div>

            {!filteredRows.length ? (
              <div className="mt-4"><EmptyState title="No products match this reconciliation view" body="Capture closing stock, enter physical counts, or change the current filters." /></div>
            ) : (
              <div className="mt-4">
                <DataTable sortable showSummary headers={["Product", "Opening", "Purchased", "Sold", "Recorded loss", "Expected", "Storage", "Machines", "Operator", "Actual", "Missing", "Missing cost", "Confidence", "Status"]}>
                  {filteredRows.map((row) => (
                    <tr key={row.product_id}>
                      <td><Link href={reconciliationHref(selectedSession.id, filter, text(params.q), row.product_id)} className="font-semibold text-slate-950 hover:underline">{row.product_name}</Link><div className="text-xs text-slate-500">{row.sku ?? "No SKU"} · {row.category ?? "Uncategorized"}</div></td>
                      <td>{reconciliationQuantity(row.opening_units, row)}</td>
                      <td>{reconciliationQuantity(row.purchased_units, row)}</td>
                      <td>{reconciliationQuantity(row.sold_units, row)}</td>
                      <td>{reconciliationQuantity(row.recorded_loss_units, row)}</td>
                      <td className="font-semibold">{reconciliationQuantity(row.expected_closing_units, row)}</td>
                      <td>{reconciliationQuantity(row.storage_units, row)}</td>
                      <td>{reconciliationQuantity(row.machine_units, row)}</td>
                      <td>{reconciliationQuantity(row.operator_units, row)}</td>
                      <td className="font-semibold">{reconciliationQuantity(row.actual_closing_units, row)}</td>
                      <td className={reconciliationWholeNumber(row.missing_units) > 0 ? "font-semibold text-rose-700" : ""}>{reconciliationQuantity(row.missing_units, row)}</td>
                      <td>{lyd(reconciliationNumber(row.missing_cost))}</td>
                      <td><StatusBadge status={row.confidence ?? "unknown"} /><div className="mt-1 text-xs text-slate-500">{reconciliationSalesSourceLabel(row.sales_source)}</div></td>
                      <td><StatusBadge status={reconciliationStatusTone(row.variance_status)} label={reconciliationStatusLabel(row.variance_status)} /></td>
                    </tr>
                  ))}
                </DataTable>
              </div>
            )}
          </section>

          {varianceRows.length ? (
            <section className="surface-card mb-6">
              <div><h2 className="text-lg font-semibold text-slate-950">Physical closing counts</h2><p className="mt-1 text-sm text-slate-500">Enter total physical units by product. A saved manual total overrides the provisional ledger/VMS total for that stock location type.</p></div>
              <form action={savePhysicalCounts} className="mt-4">
                <input type="hidden" name="session_id" value={selectedSession.id} />
                <DataTable headers={["Product", "Auto storage", "Physical storage", "VMS machines", "Machine override", "Auto operator", "Physical operator"]}>
                  {varianceRows.map((row) => (
                    <tr key={row.product_id}>
                      <td><input type="hidden" name="product_id" value={row.product_id} /><div className="font-semibold text-slate-950">{row.product_name}</div><div className="text-xs text-slate-500">{reconciliationQuantity(0, row).replace(/^0\s*/, "")} · {reconciliationWholeNumber(row.case_quantity)} per box</div></td>
                      <td>{reconciliationQuantity(autoCountValue(counts, row.product_id, "storage"), row)}</td>
                      <td><input name={`storage__${row.product_id}`} type="number" min="0" step="1" className="field-input min-w-28" defaultValue={manualCountValue(counts, row.product_id, "storage")} placeholder="Count" /></td>
                      <td>{reconciliationQuantity(autoCountValue(counts, row.product_id, "machine"), row)}</td>
                      <td><input name={`machine__${row.product_id}`} type="number" min="0" step="1" className="field-input min-w-28" defaultValue={manualCountValue(counts, row.product_id, "machine")} placeholder="Optional" /></td>
                      <td>{reconciliationQuantity(autoCountValue(counts, row.product_id, "operator_bag"), row)}</td>
                      <td><input name={`operator_bag__${row.product_id}`} type="number" min="0" step="1" className="field-input min-w-28" defaultValue={manualCountValue(counts, row.product_id, "operator_bag")} placeholder="Count" /></td>
                    </tr>
                  ))}
                </DataTable>
                <div className="mt-4 flex justify-end"><FormSubmitButton className="btn-primary" pendingLabel="Saving physical counts...">Save physical counts</FormSubmitButton></div>
              </form>
            </section>
          ) : null}

          {missingRows.length ? (
            <section className="surface-card mb-6">
              <div><h2 className="text-lg font-semibold text-slate-950">Variance cases</h2><p className="mt-1 text-sm text-slate-500">Track investigation and resolution without changing inventory automatically.</p></div>
              <form action={saveVarianceCases} className="mt-4">
                <input type="hidden" name="session_id" value={selectedSession.id} />
                <DataTable headers={["Product", "Missing", "Cost", "Confidence", "Case status", "Resolution reason", "Notes"]}>
                  {missingRows.map((row) => (
                    <tr key={row.product_id}>
                      <td><input type="hidden" name="case_product_id" value={row.product_id} /><div className="font-semibold text-slate-950">{row.product_name}</div></td>
                      <td>{reconciliationQuantity(row.missing_units, row)}</td>
                      <td>{lyd(reconciliationNumber(row.missing_cost))}</td>
                      <td><StatusBadge status={row.confidence ?? "unknown"} /><div className="mt-1 max-w-xs text-xs text-slate-500">{reconciliationConfidenceExplanation(row.confidence)}</div></td>
                      <td><select name={`case_status__${row.product_id}`} className="field-input min-w-36" defaultValue={row.case_status ?? "open"}>{caseStatusOptions().map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
                      <td><input name={`resolution_reason__${row.product_id}`} className="field-input min-w-44" defaultValue={row.resolution_reason ?? ""} placeholder="Damage, count error, route..." /></td>
                      <td><input name={`case_notes__${row.product_id}`} className="field-input min-w-48" defaultValue={row.case_notes ?? ""} placeholder="Investigation notes" /></td>
                    </tr>
                  ))}
                </DataTable>
                <div className="mt-4 flex justify-end"><FormSubmitButton className="btn-primary" pendingLabel="Saving cases...">Save variance cases</FormSubmitButton></div>
              </form>
            </section>
          ) : null}

          {selectedProduct ? (
            <section className="surface-card mb-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="text-lg font-semibold text-slate-950">{selectedProduct.product_name} audit trail</h2><p className="mt-1 text-sm text-slate-500">The exact count and movement evidence behind this variance.</p></div><Link href={reconciliationHref(selectedSession.id, filter, text(params.q))} className="btn-secondary">Close detail</Link></div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <Metric label="Opening" value={reconciliationQuantity(selectedProduct.opening_units, selectedProduct)} />
                <Metric label="Purchases" value={reconciliationQuantity(selectedProduct.purchased_units, selectedProduct)} />
                <Metric label="Sold" value={reconciliationQuantity(selectedProduct.sold_units, selectedProduct)} />
                <Metric label="Expected" value={reconciliationQuantity(selectedProduct.expected_closing_units, selectedProduct)} />
                <Metric label="Actual" value={reconciliationQuantity(selectedProduct.actual_closing_units, selectedProduct)} />
              </div>
              <div className="mt-5 grid gap-6 xl:grid-cols-2">
                <div><h3 className="mb-3 font-semibold text-slate-950">Opening and closing counts</h3>{!selectedProductCounts.length ? <div className="text-sm text-slate-500">No count rows.</div> : <DataTable headers={["Phase", "Location type", "Source", "Quantity", "Source time", "Confirmed"]}>{selectedProductCounts.map((count) => <tr key={count.id}><td>{count.count_phase}</td><td>{count.entity_type.replaceAll("_", " ")}</td><td>{count.count_source}</td><td>{reconciliationQuantity(count.quantity_counted, selectedProduct)}</td><td>{formatDateTime(count.source_at ?? count.counted_at)}</td><td><StatusBadge status={count.is_confirmed ? "confirmed" : "provisional"} label={count.is_confirmed ? "Yes" : "No"} /></td></tr>)}</DataTable>}</div>
                <div><h3 className="mb-3 font-semibold text-slate-950">Inventory movements in period</h3>{!selectedProductMovements.length ? <div className="text-sm text-slate-500">No inventory movements for this product in the selected period.</div> : <DataTable headers={["Date", "From", "To", "Reason", "Quantity", "Route"]}>{selectedProductMovements.map((movement) => <tr key={movement.id}><td>{formatDateTime(movement.created_at)}</td><td>{text(movement.from_entity_type).replaceAll("_", " ")}</td><td>{text(movement.to_entity_type).replaceAll("_", " ")}</td><td>{text(movement.reason).replaceAll("_", " ")}</td><td>{reconciliationQuantity(movement.quantity, selectedProduct)}</td><td>{movement.related_route_id ? String(movement.related_route_id).slice(0, 8) : "-"}</td></tr>)}</DataTable>}</div>
              </div>
            </section>
          ) : null}
        </>
      )}
    </>
  );
}

function Metric({ label, value, helper, tone = "default" }: { label: string; value: string; helper?: string; tone?: "default" | "warn" | "danger" }) {
  const className = tone === "danger" ? "border-rose-200 bg-rose-50" : tone === "warn" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white";
  return <div className={`rounded-xl border p-4 ${className}`}><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div><div className="mt-2 text-2xl font-semibold text-slate-950">{value}</div>{helper ? <p className="mt-1 text-xs leading-5 text-slate-500">{helper}</p> : null}</div>;
}
