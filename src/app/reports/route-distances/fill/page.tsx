import Link from "next/link";
import { redirect } from "next/navigation";
import { ErrorState, PageHeader } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { getServerI18n } from "@/lib/i18n/server";
import { saveBulkMissingRouteDistances } from "@/lib/route-distance-actions";
import { missingDistanceFieldName } from "@/lib/route-distance-bulk";
import { loadAdminRouteDistances } from "@/lib/route-distance-server";

export const dynamic = "force-dynamic";

export default async function FillMissingRouteDistancesPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");
  const { locale } = await getServerI18n();
  const tr = (en: string, ar: string) => locale === "ar" ? ar : en;
  const params = await searchParams;

  let data;
  try {
    data = await loadAdminRouteDistances();
  } catch (error) {
    console.error("[route-distances:fill] Failed to read missing route distances", error);
    return <ErrorState title={tr("Could not load missing distances", "تعذر تحميل المسافات الناقصة")}
      body={tr("The route-distance report is temporarily unavailable.", "تقرير المسافات غير متاح حالياً.")} />;
  }

  const missing = data.missingLinks;
  const completed = data.routes.filter((route) => route.completed);
  const incompleteRoutes = completed.filter((route) => route.totalKm === null).length;
  const missingLegs = missing.reduce((sum, link) => sum + link.uses, 0);
  const savedCount = Number(params.saved ?? "");
  return <div className="space-y-6" dir={locale === "ar" ? "rtl" : "ltr"}>
    <PageHeader
      title={tr("Fill missing route distances", "إدخال المسافات الناقصة")}
      subtitle={tr("Enter the known one-way driving distances, then save everything with one button. No chat reply needed.",
        "أدخل مسافات الطريق المعروفة لاتجاه واحد، ثم احفظ الكل بضغطة واحدة، دون إرسال رسالة.")}
      breadcrumbs={[
        { label: tr("Reports", "التقارير"), href: "/reports" },
        { label: tr("Route distances", "مسافات الجولات"), href: "/reports/route-distances" },
        { label: tr("Fill missing distances", "إدخال المسافات") },
      ]}
      action={<Link href="/reports/route-distances" className="btn-secondary">{tr("Back to report", "العودة للتقرير")}</Link>}
    />

    {params.error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{params.error}</div> : null}
    {Number.isInteger(savedCount) && savedCount > 0 ? (
      <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
        <strong>{tr("Saved", "تم الحفظ")}: {savedCount} {tr("directional connections.", "مسافات باتجاه محدد.")}</strong>
        <div className="mt-1">{tr("All historical route and operator totals have been recalculated from the updated links.", "تمت إعادة حساب مسافات الجولات السابقة وإجماليات المشغلين بناءً على المسافات الجديدة.")}</div>
      </div>
    ) : null}

    <section className="grid gap-3 sm:grid-cols-3">
      <div className="surface-card"><div className="text-xs text-slate-500">{tr("Missing directional connections", "مسافات باتجاه محدد غير معروفة")}</div>
        <div className="mt-2 text-3xl font-semibold">{missing.length}</div></div>
      <div className="surface-card"><div className="text-xs text-slate-500">{tr("Historical route legs affected", "مقاطع الجولات المتأثرة")}</div>
        <div className="mt-2 text-3xl font-semibold">{missingLegs}</div></div>
      <div className="surface-card"><div className="text-xs text-slate-500">{tr("Historical routes not fully measured", "جولات تاريخية غير مكتملة المسافات")}</div>
        <div className="mt-2 text-3xl font-semibold">{incompleteRoutes}</div></div>
    </section>

    <section className="rounded-2xl border border-orange-200 bg-orange-50 p-4 text-sm text-slate-800">
      <strong>{tr("How to fill this:", "طريقة التعبئة:")}</strong>{" "}
      {tr("Enter km for the connections you know. Leave the rest empty — they stay UNKNOWN, not 0. If two machines are at the same site, you can enter 0 km. Reverse directions are separate.",
        "أدخل كم للمسافات التي تعرفها، واترك الباقي فارغاً — ستبقى مجهولة، وليست صفر. إذا كانت آلتان في نفس الموقع يمكن إدخال 0 كم. كل اتجاه مستقل.")}
    </section>

    {missing.length === 0 ? (
      <section className="surface-card p-6">
        <h2 className="text-xl font-semibold text-emerald-700">{tr("All historical connections are known!", "تم تحديد جميع المسافات التاريخية!")}</h2>
        <p className="mt-2 text-sm text-slate-600">{tr("No additional distances are needed for currently completed routes.", "لا توجد مسافات ناقصة للجولات المكتملة الحالية.")}</p>
        <Link href="/reports/route-distances" className="btn-primary mt-4 inline-flex">{tr("View operator totals", "عرض إجماليات المشغلين")}</Link>
      </section>
    ) : <form action={saveBulkMissingRouteDistances} className="space-y-4">
      <div className="sticky top-2 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-white/95 p-3 shadow-sm backdrop-blur">
        <div className="text-sm"><strong>{missing.length} {tr("connections", "مسافة")}</strong>
          <div className="text-xs text-slate-500">{tr("Only entered numbers will be saved.", "سيتم حفظ الأرقام المدخلة فقط.")}</div></div>
        <button type="submit" className="btn-primary">{tr("Save all entered distances", "حفظ جميع المسافات المدخلة")}</button>
      </div>

      <section className="surface-card p-4 sm:p-5">
        <h2 className="mb-4 text-lg font-semibold">{tr("Missing connections — most frequently traveled first", "المسافات الناقصة — حسب تكرار الاستخدام")}</h2>
        <div className="space-y-3">
          {missing.map((link, index) => {
            const inputId = "missing-distance-" + index;
            const valid = Boolean(link.fromId && link.toId);
            return <div key={link.fromKind + ":" + link.fromId + ":" + link.toId} className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:gap-4" >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-sm font-semibold text-slate-600">{index + 1}</div>
                <div className="min-w-0">
                  <label htmlFor={valid ? inputId : undefined} className="block text-sm font-medium text-slate-900">
                    {link.fromName} <span className="text-orange-600">→</span> {link.toName}
                  </label>
                  <span className="text-xs text-slate-500">
                    {link.uses} {tr("historical uses", "استخدامات سابقة")}
                  </span>
                  {!valid ? <div className="text-xs text-amber-700">{tr("Machine/location must be identified first.", "يجب تحديد الآلة أو الموقع أولاً.")}</div> : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2 sm:w-44">
                {valid ? <input
                  id={inputId}
                  name={missingDistanceFieldName(link)}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="9999.99"
                  step="0.01"
                  autoComplete="off"
                  placeholder="___"
                  aria-label={link.fromName + " → " + link.toName + " km"}
                  className="field-input min-w-0 flex-1 text-base"
                /> : <span className="text-sm text-slate-400">—</span>}
                <span className="shrink-0 text-sm text-slate-600">km</span>
              </div>
            </div>;
          })}
        </div>
      </section>
      <div className="flex flex-col items-stretch justify-end gap-3 sm:flex-row sm:items-center">
        <Link href="/reports/route-distances" className="btn-secondary text-center">{tr("Cancel / Report", "العودة للتقرير")}</Link>
        <button type="submit" className="btn-primary">{tr("Save all entered distances", "حفظ جميع المسافات المدخلة")}</button>
      </div>
      <p className="text-xs leading-6 text-slate-500">{tr("Saving recalculates the route report automatically. No changes are made to operator payroll or cash records.",
        "الحفظ يعيد حساب تقرير المسافات تلقائياً. لا يتم تعديل الرواتب أو السجلات المالية.")}</p>
    </form>}
  </div>;
}
