import Link from "next/link";
import { redirect } from "next/navigation";
import { PendingMachineQuantityUpdateCard } from "@/components/routes/PendingMachineQuantityUpdateCard";
import { EmptyState, ErrorState, PageHeader, StatusBadge } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import type { MachineQuantityEvidenceFile, MachineQuantityRow } from "@/lib/machine-quantity-confirmation";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { getServerI18n } from "@/lib/i18n/server";
import { privateStorageObjectUrl, REFILL_PHOTO_BUCKET } from "@/lib/storage-buckets";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type QuantityUpdateRecord = {
  id: string;
  route_id: string;
  route_stop_id: string;
  machine_id: string;
  quantity_rows: unknown;
  verification_status: string;
  evidence_files: unknown;
  offline_reason: string | null;
  submitted_at: string | null;
  machine?: { id: string; name: string; machine_code: string | null; location?: { name?: string | null } | Array<{ name?: string | null }> | null } | Array<{ id: string; name: string; machine_code: string | null; location?: { name?: string | null } | Array<{ name?: string | null }> | null }> | null;
  route?: { id: string; route_date: string | null } | Array<{ id: string; route_date: string | null }> | null;
  operator?: { id: string; full_name: string | null } | Array<{ id: string; full_name: string | null }> | null;
};

function relationRecord<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function evidenceUrl(file: MachineQuantityEvidenceFile) {
  const savedUrl = String(file.photoUrl ?? "").trim();
  if (savedUrl.startsWith("/api/storage/")) return savedUrl;
  return privateStorageObjectUrl(REFILL_PHOTO_BUCKET, file.photoPath);
}

export default async function MachineQuantityUpdatesPage() {
  const { locale } = await getServerI18n();
  const tr = (en: string, ar: string) => locale === "ar" ? ar : en;
  const profile = await getCurrentProfile();
  if (!profile || !isOwnerAdminRole(profile)) redirect("/unauthorized");
  const supabase = getSupabaseAdminClient();
  if (!supabase) return <ErrorState title={tr("Quantity updates unavailable", "تحديثات الكميات غير متاحة")} body={tr("Supabase is not configured.", "لم يتم إعداد Supabase.")} />;

  const { data, error } = await supabase
    .from("route_stop_quantity_confirmations")
    .select("id, route_id, route_stop_id, machine_id, operator_id, quantity_rows, verification_status, evidence_files, offline_reason, submitted_at, resolved_at, machine:machines(id, name, machine_code, location:locations(name)), route:routes(id, route_date), operator:team_members(id, full_name)")
    .in("verification_status", ["offline_pending", "xy_screenshot_saved", "owner_completed"])
    .order("submitted_at", { ascending: false })
    .limit(100);

  if (error) {
    return <ErrorState title={tr("Could not load machine quantity updates", "تعذر تحميل تحديثات كميات الأجهزة")} body={error.message} />;
  }

  const records = (data ?? []) as unknown as QuantityUpdateRecord[];
  const pending = records.filter((record) => record.verification_status === "offline_pending");
  const evidence = records.filter((record) => record.verification_status !== "offline_pending");

  return (
    <>
      <PageHeader
        title={tr("Machine quantity updates", "تحديثات كميات الأجهزة")}
        subtitle={tr("Power-off follow-ups and XY screenshots saved after machine refills.", "متابعات انقطاع الكهرباء وصور شاشة XY المحفوظة بعد تعبئة الأجهزة.")}
        breadcrumbs={[{ label: tr("Routes", "الجولات"), href: "/routes" }, { label: tr("Quantity updates", "تحديثات الكميات") }]}
      />

      <section className="mb-6">
        <div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-lg font-semibold text-slate-950">{tr("Waiting for you", "بانتظارك")}</h2><StatusBadge status={pending.length ? "pending" : "complete"} label={`${pending.length}`} /></div>
        {!pending.length ? (
          <EmptyState title={tr("No power-off updates pending", "لا توجد تحديثات معلقة بسبب الكهرباء")} body={tr("Every machine-system quantity update is complete.", "تم استكمال جميع تحديثات كميات أنظمة الأجهزة.")} />
        ) : (
          <div className="space-y-4">
            {pending.map((record) => {
              const machine = relationRecord(record.machine);
              const route = relationRecord(record.route);
              const operator = relationRecord(record.operator);
              return (
                <PendingMachineQuantityUpdateCard
                  key={record.id}
                  routeId={record.route_id}
                  stopId={record.route_stop_id}
                  machineId={record.machine_id}
                  machineName={formatMachineDisplayName(machine, { includeArea: true })}
                  machineCode={machine?.machine_code ?? null}
                  routeDate={route?.route_date ?? null}
                  operatorName={operator?.full_name ?? null}
                  offlineReason={record.offline_reason ?? null}
                  rows={Array.isArray(record.quantity_rows) ? record.quantity_rows as MachineQuantityRow[] : []}
                />
              );
            })}
          </div>
        )}
      </section>

      <section className="surface-card p-4 md:p-5">
        <div className="mb-4"><h2 className="text-lg font-semibold text-slate-950">{tr("Recent XY evidence", "أحدث إثباتات XY")}</h2><p className="mt-1 text-sm text-slate-500">{tr("Open screenshots whenever you want to review the quantities entered by the operator.", "افتح صور الشاشة عندما تريد مراجعة الكميات التي أدخلها المشغّل.")}</p></div>
        {!evidence.length ? <div className="text-sm text-slate-500">{tr("No XY screenshots saved yet.", "لم يتم حفظ صور شاشة XY بعد.")}</div> : (
          <div className="space-y-3">
            {evidence.slice(0, 30).map((record) => {
              const machine = relationRecord(record.machine);
              const files = Array.isArray(record.evidence_files) ? record.evidence_files as MachineQuantityEvidenceFile[] : [];
              return (
                <article key={record.id} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div><div className="font-semibold text-slate-950">{formatMachineDisplayName(machine, { includeArea: true })}</div><div className="mt-1 text-xs text-slate-500">{record.submitted_at ? new Date(record.submitted_at).toLocaleString(locale === "ar" ? "ar-LY" : "en-US") : "-"}</div></div>
                    <div className="flex flex-wrap gap-2"><StatusBadge status={record.verification_status} label={record.verification_status === "owner_completed" ? tr("Owner completed", "أكملها المالك") : tr("Operator screenshot", "صورة المشغّل")} /><Link href={`/routes/${record.route_id}`} className="btn-secondary">{tr("Open route", "فتح الجولة")}</Link></div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {files.map((file, index) => {
                      const href = evidenceUrl(file);
                      return href ? <a key={`${file.photoPath}:${index}`} href={href} target="_blank" rel="noreferrer" className="link-secondary">{tr("View screenshot", "عرض صورة الشاشة")} {index + 1}</a> : null;
                    })}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
