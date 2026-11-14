import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader, EmptyState, ErrorState } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { getServerI18n } from "@/lib/i18n/server";
import { deleteRouteDistanceEdge, saveRouteDistanceEdge } from "@/lib/route-distance-actions";
import { loadAdminRouteDistances } from "@/lib/route-distance-server";
import { sumOperatorRouteDistances, type CalculatedRouteDistance } from "@/lib/route-distance";

export const dynamic = "force-dynamic";

type Locale = "ar" | "en";
const tr = (locale: Locale, en: string, ar: string) => locale === "ar" ? ar : en;
const kmLabel = (km: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(km) + " km";
const isMonth = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

function currentTripoliMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return (parts.find((part) => part.type === "year")?.value ?? "2026") + "-" + (parts.find((part) => part.type === "month")?.value ?? "11");
}

function routeDistanceLabel(route: CalculatedRouteDistance, locale: Locale) {
  return route.totalKm !== null
    ? kmLabel(route.totalKm)
    : tr(locale, "Incomplete: " + kmLabel(route.knownKm) + " known · " + route.missingLegCount + " missing",
      "غير مكتملة: " + kmLabel(route.knownKm) + " مؤكدة · " + route.missingLegCount + " مسافات ناقصة");
}

export default async function RouteDistancesPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; operator?: string; route?: string; page?: string; saved?: string; error?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");
  const { locale } = await getServerI18n();
  const params = await searchParams;
  let data;
  try {
    data = await loadAdminRouteDistances();
  } catch (error) {
    console.error("[route-distances] Could not load distance history", error);
    return <ErrorState title={tr(locale, "Route distance unavailable", "تعذر تحميل مسافات الجولات")}
      body={tr(locale, "Route history or distance settings could not load. Check that the route-distance database migration has been applied.",
        "تعذر تحميل سجل الجولات أو إعدادات المسافة. تحقق من تطبيق تحديث قاعدة البيانات.")} />;
  }

  const completedRoutes = data.routes.filter((route) => route.completed);
  const months = [...new Set(completedRoutes.map((route) => (route.routeDate ?? "").slice(0, 7)).filter(isMonth))].sort().reverse();
  const requestedMonth = params.month || currentTripoliMonth();
  const month = requestedMonth === "all" || isMonth(requestedMonth) ? requestedMonth : currentTripoliMonth();
  const periodMonth = month === "all" ? null : month;
  const operator = params.operator && params.operator !== "all" ? params.operator : null;
  const selectedRoutes = completedRoutes
    .filter((route) => !periodMonth || String(route.routeDate ?? "").startsWith(periodMonth))
    .filter((route) => !operator || (route.operatorId ?? "unassigned") === operator);
  const monthSummary = sumOperatorRouteDistances(selectedRoutes);
  const allTimeSummary = sumOperatorRouteDistances(
    completedRoutes.filter((route) => !operator || (route.operatorId ?? "unassigned") === operator),
  );

  const operatorIds = [...new Set(completedRoutes.map((route) => route.operatorId ?? "unassigned"))];
  const operatorSummaries = operatorIds.map((id) => {
    const records = completedRoutes.filter((route) => (route.operatorId ?? "unassigned") === id);
    return {
      id,
      name: records[0]?.operatorName ?? "Unassigned",
      month: sumOperatorRouteDistances(records, periodMonth),
      all: sumOperatorRouteDistances(records),
    };
  }).filter((item) => !operator || item.id === operator)
    .sort((a, b) => b.month.confirmedKm - a.month.confirmedKm);

  const selectedRoute = params.route ? data.routes.find((route) => route.routeId === params.route) : null;
  const pageSize = 40;
  const requestedPage = Number(params.page ?? 1);
  const pageNumber = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const totalPages = Math.max(1, Math.ceil(selectedRoutes.length / pageSize));
  const displayedPage = Math.min(pageNumber, totalPages);
  const displayedRoutes = selectedRoutes.slice((displayedPage - 1) * pageSize, displayedPage * pageSize);
  const filterHref = "/reports/route-distances?month=" + encodeURIComponent(month) + "&operator=" + encodeURIComponent(operator ?? "all");
  const machineNames = new Map(data.machines.map((machine) => [machine.id, machine.name || "Unnamed machine"]));
  const storageNames = new Map(data.storages.map((storage) => [storage.id, storage.name || "Storage"]));

  return <div className="space-y-6" dir={locale === "ar" ? "rtl" : "ltr"}>
    <PageHeader
      title={tr(locale, "Route distances / مسافات الجولات", "مسافات الجولات / Route distances")}
      subtitle={tr(locale,
        "Private owner/admin travel distances from storage, then between stops in saved order. Covers all historic completed routes.",
        "مسافات الجولات للإدارة فقط، من المخزن ثم بين المواقع حسب ترتيبها المحفوظ، وتشمل الجولات السابقة.")}
      breadcrumbs={[{ label: tr(locale, "Reports", "التقارير"), href: "/reports" }, { label: tr(locale, "Route distances", "مسافات الجولات") }]}
      action={<Link href="/routes" className="btn-secondary">{tr(locale, "All routes", "جميع الجولات")}</Link>}
    />

    {params.saved ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{tr(locale, "Distance saved. All historical route totals have been recalculated.", "تم حفظ المسافة وإعادة حساب جميع الجولات السابقة.")}</div> : null}
    {params.error ? <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">{params.error}</div> : null}
    <section className="surface-card p-5">
      <form method="get" className="flex flex-wrap items-end gap-4">
        <label className="block min-w-44 flex-1 text-sm font-medium">
          {tr(locale, "Report period", "فترة التقرير")}
          <select name="month" defaultValue={month} className="field-input mt-1">
            <option value="all">{tr(locale, "All time", "من البداية")}</option>
            {months.map((value) => <option key={value} value={value}>{value}</option>)}
            {!months.includes(month) && month !== "all" ? <option value={month}>{month}</option> : null}
          </select>
        </label>
        <label className="block min-w-44 flex-1 text-sm font-medium">
          {tr(locale, "Operator", "المشغل")}
          <select name="operator" defaultValue={operator ?? "all"} className="field-input mt-1">
            <option value="all">{tr(locale, "All operators", "كل المشغلين")}</option>
            {operatorIds.map((id) => <option key={id} value={id}>{completedRoutes.find((route) => (route.operatorId ?? "unassigned") === id)?.operatorName ?? id}</option>)}
          </select>
        </label>
        <button type="submit" className="btn-primary">{tr(locale, "Show distances", "عرض المسافات")}</button>
      </form>
      <p className="mt-3 text-xs leading-5 text-slate-500">{tr(locale,
        "Routes are grouped by their saved business date. Only completed routes count toward operator totals. No return-to-storage leg is assumed; missing links are never treated as zero.",
        "التجميع حسب تاريخ الجولة المحفوظ، وتُحسب الجولات المكتملة فقط. لا تُضاف رحلة العودة للمخزن تلقائياً، ولا تُعامل المسافات المجهولة على أنها صفر.")}</p>
    </section>

    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div className="surface-card"><div className="text-sm text-slate-500">{tr(locale, "Confirmed km · selected period", "كم مؤكدة · الفترة")}</div><div className="mt-2 text-3xl font-semibold">{kmLabel(monthSummary.confirmedKm)}</div><div className="mt-1 text-xs text-slate-500">{monthSummary.fullyMeasuredRoutes} {tr(locale, "fully mapped routes", "جولة مكتملة المسافات")}</div></div>
      <div className="surface-card"><div className="text-sm text-slate-500">{tr(locale, "Confirmed km · all time", "كم مؤكدة · من البداية")}</div><div className="mt-2 text-3xl font-semibold">{kmLabel(allTimeSummary.confirmedKm)}</div></div>
      <div className="surface-card"><div className="text-sm text-slate-500">{tr(locale, "Completed routes · selected period", "الجولات المكتملة · الفترة")}</div><div className="mt-2 text-3xl font-semibold">{monthSummary.completedRoutes}</div></div>
      <div className="surface-card"><div className="text-sm text-slate-500">{tr(locale, "Incomplete route distances", "جولات مسافاتها ناقصة")}</div><div className="mt-2 text-3xl font-semibold text-amber-700">{monthSummary.incompleteRoutes}</div><div className="mt-1 text-xs text-slate-500">{monthSummary.missingLegCount} {tr(locale, "unresolved legs", "مسافات غير محددة")}</div></div>
    </section>

    <section className="surface-card p-5">
      <h2 className="text-lg font-semibold">{tr(locale, "Distance by operator · monthly and all time", "المسافة حسب المشغل · الشهري والإجمالي")}</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[700px] text-sm">
          <thead><tr className="border-b text-left text-slate-500">
            <th className="px-3 py-3">{tr(locale, "Operator", "المشغل")}</th>
            <th className="px-3 py-3">{tr(locale, "Period km (confirmed)", "كم الفترة المؤكدة")}</th>
            <th className="px-3 py-3">{tr(locale, "All-time km (confirmed)", "كم إجمالي مؤكد")}</th>
            <th className="px-3 py-3">{tr(locale, "Period routes", "جولات الفترة")}</th>
            <th className="px-3 py-3">{tr(locale, "Missing-distance routes", "جولات ناقصة المسافات")}</th>
          </tr></thead>
          <tbody>{operatorSummaries.map((item) => <tr key={item.id} className="border-b border-slate-100">
            <td className="px-3 py-3 font-medium">{item.name}</td>
            <td className="px-3 py-3">{kmLabel(item.month.confirmedKm)}</td>
            <td className="px-3 py-3">{kmLabel(item.all.confirmedKm)}</td>
            <td className="px-3 py-3">{item.month.completedRoutes}</td>
            <td className="px-3 py-3">{item.month.incompleteRoutes} / {item.all.incompleteRoutes} {tr(locale, "(period / all time)", "(الفترة / الإجمالي)")}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-amber-700">{tr(locale,
        "Confirmed km includes only routes with every leg known. Incomplete routes are listed below and excluded from this sum to prevent misleading totals.",
        "الإجمالي المؤكد يشمل الجولات التي حُددت جميع مسافاتها فقط. الجولات الناقصة لا تُجمع كأنها مسافة كاملة.")}</p>
    </section>

    {selectedRoute ? <section className="surface-card p-5" id="route-distance-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold">{tr(locale, "Route distance details", "تفاصيل مسافة الجولة")}</h2>
          <p className="text-sm text-slate-500">{selectedRoute.routeDate ?? "—"} · {selectedRoute.operatorName} · {selectedRoute.status}</p>
          <p className="mt-2 font-semibold">{routeDistanceLabel(selectedRoute, locale)}</p>
        </div>
        <Link className="btn-secondary" href={"/routes/" + selectedRoute.routeId}>{tr(locale, "Open original route", "فتح الجولة الأصلية")}</Link>
      </div>
      <div className="mt-4 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-slate-500">
        <th className="p-3">{tr(locale, "Stop", "الترتيب")}</th><th className="p-3">{tr(locale, "From", "من")}</th>
        <th className="p-3">{tr(locale, "To", "إلى")}</th><th className="p-3">{tr(locale, "Distance", "المسافة")}</th>
      </tr></thead><tbody>{selectedRoute.legs.map((leg) => <tr key={leg.stopId} className="border-b border-slate-100">
        <td className="p-3">{leg.stopOrder}</td><td className="p-3">{leg.fromName}</td><td className="p-3">{leg.toName}</td>
        <td className="p-3">{leg.km === null ? <span className="font-medium text-amber-700">{tr(locale, "Not entered", "غير محددة")}</span> : kmLabel(leg.km)}</td>
      </tr>)}</tbody></table></div>
    </section> : null}

    <section className="surface-card p-5">
      <h2 className="text-lg font-semibold">{tr(locale, "Route history", "سجل مسافات الجولات")}</h2>
      <p className="mt-1 text-sm text-slate-500">{tr(locale, "Each route uses actual saved stop order and the operator assigned to that route.", "كل جولة تستخدم ترتيب المحطات المحفوظ والمشغل المسند إليها.")}</p>
      {!selectedRoutes.length ? <EmptyState title={tr(locale, "No completed routes for this filter", "لا توجد جولات مكتملة لهذه الفترة")} body={tr(locale, "Try all time or a different operator.", "جرب فترة أخرى أو جميع المشغلين.")} /> :
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead><tr className="border-b text-left text-slate-500">
          <th className="p-3">{tr(locale, "Date", "التاريخ")}</th><th className="p-3">{tr(locale, "Operator", "المشغل")}</th>
          <th className="p-3">{tr(locale, "Stops in order", "المحطات بالترتيب")}</th><th className="p-3">{tr(locale, "Distance", "المسافة")}</th>
          <th className="p-3">{tr(locale, "Details", "التفاصيل")}</th>
        </tr></thead><tbody>{displayedRoutes.map((route) => <tr key={route.routeId} className="border-b border-slate-100">
          <td className="p-3">{route.routeDate ?? "—"}</td><td className="p-3">{route.operatorName}</td>
          <td className="p-3">{route.legs.map((leg) => leg.toName).join(" → ") || "—"}</td>
          <td className={"p-3 font-medium " + (route.totalKm === null ? "text-amber-700" : "")}>{routeDistanceLabel(route, locale)}</td>
          <td className="p-3"><Link className="link-secondary" href={filterHref + "&route=" + route.routeId + "#route-distance-detail"}>{tr(locale, "View legs", "تفاصيل المسار")}</Link></td>
        </tr>)}</tbody></table></div>}
      {totalPages > 1 ? <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <span>{tr(locale, "Page", "صفحة")} {displayedPage} / {totalPages} · {selectedRoutes.length} {tr(locale, "routes", "جولة")}</span>
        <div className="flex gap-2">
          {displayedPage > 1 ? <Link className="btn-secondary" href={filterHref + "&page=" + (displayedPage - 1)}>{tr(locale, "Previous", "السابق")}</Link> : null}
          {displayedPage < totalPages ? <Link className="btn-secondary" href={filterHref + "&page=" + (displayedPage + 1)}>{tr(locale, "Next", "التالي")}</Link> : null}
        </div>
      </div> : null}
    </section>

    <section className="surface-card p-5">
      <h2 className="text-lg font-semibold">{tr(locale, "Missing route connections · prioritized by use", "المسافات الناقصة · حسب تكرار استخدامها")}</h2>
      <div className="mt-3 mb-4"><Link href="/reports/route-distances/fill" className="btn-primary inline-flex">{tr(locale, "Fill all missing distances in one form", "إدخال كل المسافات الناقصة في نموذج واحد")}</Link></div>
      <p className="mt-1 text-sm text-slate-500">{tr(locale, "Enter each direction separately. Saving a link updates past and future route reports, without changing payroll records.", "أدخل مسافة كل اتجاه بشكل مستقل. الحفظ يحدث تقارير الجولات السابقة والقادمة دون تعديل سجلات المرتبات.")}</p>
      {data.missingLinks.length === 0 ? <div className="mt-4 text-sm text-emerald-700">{tr(locale, "No missing connections in completed routes.", "لا توجد مسافات ناقصة في الجولات المكتملة.")}</div> :
        <div className="mt-4 space-y-3">{data.missingLinks.slice(0, 45).map((link, index) => <div key={index} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3">
          <div className="min-w-[220px] flex-1"><div className="font-medium">{link.fromName} → {link.toName}</div>
            <div className="text-xs text-slate-500">{link.uses} {tr(locale, "visits in", "مرة في")} {link.routes} {tr(locale, "routes", "جولة")}</div>
          </div>
          {link.fromId && link.toId ? <form action={saveRouteDistanceEdge} className="flex items-center gap-2">
            <input type="hidden" name="origin" value={link.fromKind + ":" + link.fromId} />
            <input type="hidden" name="to_machine_id" value={link.toId} />
            <input type="number" name="distance_km" min="0" max="9999" step="0.01" required placeholder="km" aria-label={link.fromName + " to " + link.toName + " km"} className="field-input w-28" />
            <button type="submit" className="btn-primary">{tr(locale, "Save", "حفظ")}</button>
          </form> : <span className="text-sm text-amber-700">{tr(locale, "Fix storage or machine mapping first", "يجب تحديد المخزن أو الآلة أولاً")}</span>}
        </div>)}</div>}
      {data.missingLinks.length > 45 ? <p className="mt-3 text-sm text-amber-700">{data.missingLinks.length - 45} {tr(locale, "more links remain. Add them through the connection form below.", "مسافات أخرى يمكن إضافتها من النموذج أدناه.")}</p> : null}
    </section>

    <section className="surface-card p-5">
      <h2 className="text-lg font-semibold">{tr(locale, "Add or update a distance connection", "إضافة أو تعديل مسافة بين موقعين")}</h2>
      <form action={saveRouteDistanceEdge} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <label className="text-sm font-medium lg:col-span-2">{tr(locale, "From", "من")}
          <select name="origin" required className="field-input mt-1" defaultValue={data.activeStorageId ? "storage:" + data.activeStorageId : ""}>
            <option value="">{tr(locale, "Choose start", "اختر نقطة البداية")}</option>
            {data.storages.map((storage) => <option value={"storage:" + storage.id} key={storage.id}>{tr(locale, "Storage", "المخزن")}: {storage.name}</option>)}
            {data.machines.map((machine) => <option value={"machine:" + machine.id} key={machine.id}>{machine.name}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium lg:col-span-2">{tr(locale, "To", "إلى")}
          <select name="to_machine_id" required className="field-input mt-1" defaultValue="">
            <option value="">{tr(locale, "Choose destination", "اختر الوجهة")}</option>
            {data.machines.map((machine) => <option value={machine.id} key={machine.id}>{machine.name}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium">{tr(locale, "One-way km", "كم اتجاه واحد")}
          <input name="distance_km" type="number" min="0" max="9999" step="0.01" required className="field-input mt-1" />
        </label>
        <label className="text-sm font-medium sm:col-span-2 lg:col-span-4">{tr(locale, "Note (optional)", "ملاحظات (اختياري)")}
          <input name="notes" className="field-input mt-1" maxLength={400} />
        </label>
        <button className="btn-primary self-end" type="submit">{tr(locale, "Save connection", "حفظ المسافة")}</button>
      </form>
    </section>

    <section className="surface-card p-5">
      <h2 className="text-lg font-semibold">{tr(locale, "Saved directional connections", "المسافات المحفوظة حسب الاتجاه")}</h2>
      <div className="mt-4 space-y-3">{data.edges.map((edge) => <div key={edge.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3">
        <div className="min-w-[220px] flex-1 text-sm font-medium">
          {(edge.from_machine_id ? machineNames.get(edge.from_machine_id) : storageNames.get(edge.from_storage_location_id ?? "")) || "Unknown start"}
          {" → "}{machineNames.get(edge.to_machine_id) || "Unknown destination"}
        </div>
        <form action={saveRouteDistanceEdge} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="edge_id" value={edge.id ?? ""} />
          <input name="distance_km" type="number" min="0" max="9999" step="0.01" required className="field-input w-24" defaultValue={Number(edge.distance_km)} aria-label="One-way distance km" />
          <input name="notes" defaultValue={edge.notes ?? ""} maxLength={400} placeholder={tr(locale, "Note", "ملاحظة")} className="field-input w-44" />
          <button type="submit" className="btn-secondary">{tr(locale, "Update", "تعديل")}</button>
        </form>
        <form action={deleteRouteDistanceEdge}>
          <input type="hidden" name="edge_id" value={edge.id ?? ""} />
          <button type="submit" className="text-xs font-medium text-rose-700">{tr(locale, "Remove", "حذف")}</button>
        </form>
      </div>)}</div>
      <p className="mt-4 text-xs leading-5 text-slate-500">{tr(locale,
        "Distances are manual road estimates supplied by management, not GPS-tracked vehicle odometer readings. Historical totals update if you edit an edge. Payroll remains unchanged.",
        "المسافات تقديرات طرق تعتمد على الأرقام المدخلة، وليست قراءة GPS أو عداد السيارة. تعديل المسافة يحدّث الإجماليات التاريخية دون تعديل الرواتب.")}</p>
    </section>
  </div>;
}
