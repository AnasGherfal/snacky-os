import Link from "next/link";
import { ChartCard, HorizontalBarChart } from "@/components/DecisionCharts";
import { DataTable, MobileCardList, MobileField, MobileRecordCard } from "@/components/ui";
import type { MachineRefillForecast, RefillForecastStatus } from "@/lib/refill-forecast";

const statusStyle: Record<RefillForecastStatus, string> = {
  fill_now: "border-rose-200 bg-rose-100 text-rose-800",
  fill_today: "border-orange-200 bg-orange-100 text-orange-800",
  fill_next_open: "border-sky-200 bg-sky-100 text-sky-800",
  monitor: "border-amber-200 bg-amber-100 text-amber-800",
  healthy: "border-emerald-200 bg-emerald-100 text-emerald-800",
  data_stale: "border-slate-300 bg-slate-100 text-slate-700",
};

type Locale = "en" | "ar";

const weekday: Record<Locale, Map<number, string>> = {
  en: new Map([[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]]),
  ar: new Map([[1, "الإثنين"], [2, "الثلاثاء"], [3, "الأربعاء"], [4, "الخميس"], [5, "الجمعة"], [6, "السبت"], [7, "الأحد"]]),
};

function tr(locale: Locale, en: string, ar: string) {
  return locale === "ar" ? ar : en;
}

function statusLabel(forecast: MachineRefillForecast, locale: Locale) {
  const labels: Record<RefillForecastStatus, [string, string]> = {
    fill_now: ["Fill now", "عبّئ الآن"],
    fill_today: ["Fill today", "عبّئ اليوم"],
    fill_next_open: ["Fill next open day", "عبّئ في يوم العمل القادم"],
    monitor: ["Can wait", "يمكن الانتظار"],
    healthy: ["Healthy", "جيد"],
    data_stale: ["Refresh XY data", "حدّث بيانات XY"],
  };
  return tr(locale, ...labels[forecast.status]);
}

function statusReason(forecast: MachineRefillForecast, locale: Locale) {
  if (locale === "en") return forecast.reason;
  if (forecast.status === "fill_now") return "يوجد مسار فارغ أو وصلت كمية الماكينة إلى المستوى الحرج.";
  if (forecast.status === "fill_today") return "قد تنفد المنتجات قبل موعد الزيارة الآمن القادم حسب معدل الاستهلاك.";
  if (forecast.status === "fill_next_open") return `الموقع مغلق اليوم، ويمكن تأجيل التعبئة بأمان حتى ${forecast.nextOpenDate}.`;
  if (forecast.status === "monitor") return "المخزون منخفض، لكن معدل الاستهلاك يسمح بالانتظار حتى الزيارة المخططة القادمة.";
  if (forecast.status === "data_stale") return "آخر بيانات مخزون من XY قديمة ولا تسمح بتحديد موعد تعبئة آمن.";
  return "المخزون الحالي ومعدل الاستهلاك لا يتطلبان زيارة قريبة.";
}

function trendLabel(forecast: MachineRefillForecast, locale: Locale) {
  if (locale === "en") return forecast.trendLabel;
  if (forecast.policySource === "insufficient_data") return "جاري تعلّم الاتجاه";
  if (forecast.trendPercent === null) return "يتم تكوين خط الأساس";
  if (forecast.trendPercent >= 0.2) return `أسرع بنسبة ${Math.round(forecast.trendPercent * 100)}%`;
  if (forecast.trendPercent <= -0.2) return `أبطأ بنسبة ${Math.abs(Math.round(forecast.trendPercent * 100))}%`;
  return "مستقر";
}

function policySource(value: MachineRefillForecast["policySource"], locale: Locale) {
  if (value === "observed") return tr(locale, "Observed", "محسوب من البيانات");
  if (value === "manual") return tr(locale, "Manual", "يدوي");
  return tr(locale, "Insufficient data", "بيانات غير كافية");
}

function StatusPill({ forecast, locale }: { forecast: MachineRefillForecast; locale: Locale }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusStyle[forecast.status]}`}>{statusLabel(forecast, locale)}</span>;
}

function percent(value: number) {
  return `${Math.round(value)}%`;
}

function days(value: number | null, locale: Locale) {
  if (value === null) return tr(locale, "Learning", "قيد التعلّم");
  if (value <= 0.5) return tr(locale, "< 1 day", "أقل من يوم");
  return tr(locale, `${value.toFixed(value < 10 ? 1 : 0)} days`, `${value.toFixed(value < 10 ? 1 : 0)} يوم`);
}

function schedule(value: number[], locale: Locale) {
  return value.map((day) => weekday[locale].get(day)).filter(Boolean).join(" · ");
}

function snapshotAge(value: number | null, locale: Locale) {
  if (value === null) return tr(locale, "Missing", "مفقودة");
  if (value < 1) return tr(locale, "Current", "محدّثة");
  if (value < 24) return tr(locale, `${Math.round(value)}h old`, `منذ ${Math.round(value)} ساعة`);
  return tr(locale, `${Math.round(value / 24)}d old`, `منذ ${Math.round(value / 24)} يوم`);
}

export function RefillForecastDashboard({
  forecasts,
  variant = "full",
  locale = "en",
}: {
  forecasts: MachineRefillForecast[];
  variant?: "full" | "overview";
  locale?: Locale;
}) {
  const fillNow = forecasts.filter((row) => row.status === "fill_now").length;
  const fillToday = forecasts.filter((row) => row.status === "fill_today").length;
  const canWait = forecasts.filter((row) => row.status === "fill_next_open" || row.status === "monitor").length;
  const stale = forecasts.filter((row) => row.status === "data_stale").length;
  const storageShortages = forecasts.filter((row) => row.storageShortageUnits > 0).length;
  const observed = forecasts.filter((row) => row.averageDailyUnits > 0).sort((a, b) => b.averageDailyUnits - a.averageDailyUnits);
  const remaining = forecasts.filter((row) => row.daysToEmpty !== null && row.status !== "data_stale").sort((a, b) => (a.daysToEmpty ?? 0) - (b.daysToEmpty ?? 0));
  const urgentAll = forecasts.filter((row) => row.status !== "healthy");
  const urgent = urgentAll.slice(0, 6);

  if (variant === "overview") {
    return (
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-gradient-to-br from-orange-50 via-white to-emerald-50 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-orange-700">{tr(locale, "Today's operating decision", "قرار التشغيل اليوم")}</div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{tr(locale, "Which machines should be filled?", "ما الماكينات التي يجب تعبئتها؟")}</h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">{tr(locale, "Live XY stock, lane capacity, observed depletion, site opening days, and storage availability—ordered by what needs action first.", "مخزون XY المباشر، وسعة المسارات، ومعدل الاستهلاك، وأيام عمل الموقع، وتوفر المخزون—مرتبة حسب الأولوية.")}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/routes/new" className="btn-primary">{tr(locale, "Create today's route", "إنشاء جولة اليوم")}</Link>
              <Link href="/refills" className="btn-secondary">{tr(locale, "Open full refill dashboard", "فتح لوحة التعبئة الكاملة")}</Link>
            </div>
          </div>

          <div className="mt-5 grid gap-3 grid-cols-2 xl:grid-cols-5">
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3"><div className="text-xs font-semibold text-rose-700">{tr(locale, "Fill now", "عبّئ الآن")}</div><div className="mt-1 text-2xl font-semibold text-rose-950">{fillNow}</div></div>
            <div className="rounded-xl border border-orange-200 bg-orange-50 p-3"><div className="text-xs font-semibold text-orange-700">{tr(locale, "Fill today", "عبّئ اليوم")}</div><div className="mt-1 text-2xl font-semibold text-orange-950">{fillToday}</div></div>
            <div className="rounded-xl border border-sky-200 bg-sky-50 p-3"><div className="text-xs font-semibold text-sky-700">{tr(locale, "Can wait", "يمكن الانتظار")}</div><div className="mt-1 text-2xl font-semibold text-sky-950">{canWait}</div></div>
            <div className={`rounded-xl border p-3 ${storageShortages ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50"}`}><div className={`text-xs font-semibold ${storageShortages ? "text-rose-700" : "text-emerald-700"}`}>{tr(locale, "Storage shortage", "نقص في المخزون")}</div><div className={`mt-1 text-2xl font-semibold ${storageShortages ? "text-rose-950" : "text-emerald-950"}`}>{storageShortages}</div></div>
            <div className={`col-span-2 rounded-xl border p-3 xl:col-span-1 ${stale ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}><div className={`text-xs font-semibold ${stale ? "text-amber-700" : "text-emerald-700"}`}>{tr(locale, "Refresh XY data", "حدّث بيانات XY")}</div><div className={`mt-1 text-2xl font-semibold ${stale ? "text-amber-950" : "text-emerald-950"}`}>{stale}</div></div>
          </div>
        </div>

        <div className="p-5">
          {!forecasts.length ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-5 text-center text-sm text-slate-600">{tr(locale, "No active machines are available for refill forecasting.", "لا توجد ماكينات نشطة متاحة لتوقع التعبئة.")}</div>
          ) : !urgent.length ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">{tr(locale, "Every machine is healthy. No refill visit is currently needed.", "جميع الماكينات بحالة جيدة، ولا توجد زيارة تعبئة مطلوبة حالياً.")}</div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {urgent.map((row) => (
                <div key={row.machineId} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/machines/${row.machineId}`} className="font-semibold text-slate-950 hover:underline">{row.machineName}</Link>
                      <div className="mt-0.5 text-xs text-slate-500">{row.machineCode || tr(locale, "No machine code", "لا يوجد رمز للماكينة")} · {tr(locale, "action", "الموعد")} {row.actionDate}</div>
                    </div>
                    <StatusPill forecast={row} locale={locale} />
                  </div>
                  <p className="mt-3 text-sm text-slate-700">{statusReason(row, locale)}</p>
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                    <div><div className="text-xs text-slate-500">{tr(locale, "Stock", "المخزون")}</div><div className="font-semibold text-slate-900">{row.currentUnits}/{row.capacityUnits} · {percent(row.stockPercent)}</div></div>
                    <div><div className="text-xs text-slate-500">{tr(locale, "Runway", "المدة المتبقية")}</div><div className="font-semibold text-slate-900">{days(row.daysToEmpty, locale)}</div></div>
                    <div><div className="text-xs text-slate-500">{tr(locale, "Bring", "الكمية المطلوبة")}</div><div className="font-semibold text-slate-900">{row.unitsToTarget} {tr(locale, "units", "وحدة")}</div></div>
                    <div><div className="text-xs text-slate-500">{tr(locale, "Empty lanes", "المسارات الفارغة")}</div><div className="font-semibold text-slate-900">{row.emptyLanes}</div></div>
                  </div>
                  {row.storageShortageUnits > 0 ? <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800">{tr(locale, `Storage is short by ${row.storageShortageUnits} units. Swap unavailable products or reduce them to 0.`, `المخزون ناقص بمقدار ${row.storageShortageUnits} وحدة. استبدل المنتجات غير المتوفرة أو اجعل كميتها 0.`)}</div> : null}
                </div>
              ))}
            </div>
          )}
          {urgentAll.length > urgent.length ? <div className="mt-4 text-right"><Link href="/refills" className="link-secondary">{tr(locale, `View all ${urgentAll.length} machines needing attention`, `عرض جميع الماكينات التي تحتاج متابعة (${urgentAll.length})`)}</Link></div> : null}
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-950">{tr(locale, "When each machine should be filled", "متى يجب تعبئة كل ماكينة؟")}</h2>
          <p className="mt-1 max-w-4xl text-sm text-slate-600">{tr(locale, "Live XY quantities plus 14-day depletion, recorded fill quantities, storage coverage, and each site's operating calendar. Empty lanes always outrank percentage rules.", "كميات XY المباشرة مع استهلاك آخر 14 يوماً، وكميات التعبئة المسجلة، وتوفر المخزون، وأيام عمل كل موقع. المسارات الفارغة لها الأولوية دائماً.")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/routes/new" className="btn-primary">{tr(locale, "Create today's route", "إنشاء جولة اليوم")}</Link>
          <Link href="/machines" className="btn-secondary">{tr(locale, "Configure machine policies", "إعداد سياسات الماكينات")}</Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4"><div className="text-sm font-medium text-rose-700">{tr(locale, "Fill now", "عبّئ الآن")}</div><div className="mt-1 text-3xl font-semibold text-rose-950">{fillNow}</div></div>
        <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4"><div className="text-sm font-medium text-orange-700">{tr(locale, "Fill today", "عبّئ اليوم")}</div><div className="mt-1 text-3xl font-semibold text-orange-950">{fillToday}</div></div>
        <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4"><div className="text-sm font-medium text-sky-700">{tr(locale, "Can safely wait", "يمكن الانتظار بأمان")}</div><div className="mt-1 text-3xl font-semibold text-sky-950">{canWait}</div></div>
        <div className={`rounded-2xl border p-4 ${stale ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}><div className={`text-sm font-medium ${stale ? "text-amber-700" : "text-emerald-700"}`}>{tr(locale, "XY data needing refresh", "بيانات XY تحتاج تحديثاً")}</div><div className={`mt-1 text-3xl font-semibold ${stale ? "text-amber-950" : "text-emerald-950"}`}>{stale}</div></div>
      </div>

      {forecasts.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard title={tr(locale, "Observed machine depletion", "معدل استهلاك الماكينات")} subtitle={tr(locale, "Estimated units consumed per day from XY stock changes, corrected with recorded refill quantities.", "تقدير الوحدات المستهلكة يومياً من تغيرات مخزون XY بعد احتساب كميات التعبئة المسجلة.")}>
            <HorizontalBarChart rows={observed.slice(0, 10).map((row) => ({ label: row.machineName, value: Number(row.averageDailyUnits.toFixed(1)), note: `${trendLabel(row, locale)} · ${policySource(row.policySource, locale)}` }))} valueFormatter={(value) => tr(locale, `${value.toFixed(1)} units/day`, `${value.toFixed(1)} وحدة/يوم`)} />
          </ChartCard>
          <ChartCard title={tr(locale, "Projected stock runway", "المدة المتوقعة لنفاد المخزون")} subtitle={tr(locale, "The shortest machine/product runway appears first. Closure days are considered in the action status.", "تظهر الماكينات والمنتجات الأقرب للنفاد أولاً، مع احتساب أيام إغلاق الموقع.")}>
            <HorizontalBarChart rows={remaining.slice(0, 10).map((row) => ({ label: row.machineName, value: Number((row.daysToEmpty ?? 0).toFixed(1)), note: statusLabel(row, locale) }))} valueFormatter={(value) => tr(locale, `${value.toFixed(1)} days`, `${value.toFixed(1)} يوم`)} />
          </ChartCard>
        </div>
      ) : null}

      <MobileCardList>
        {forecasts.map((row) => (
          <MobileRecordCard key={row.machineId}>
            <div className="flex items-start justify-between gap-3">
              <div><div className="font-semibold text-slate-950">{row.machineName}</div><div className="text-xs text-slate-500">{row.machineCode}</div></div>
              <StatusPill forecast={row} locale={locale} />
            </div>
            <p className="mt-3 text-sm text-slate-700">{statusReason(row, locale)}</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <MobileField label={tr(locale, "Stock", "المخزون")}>{row.currentUnits}/{row.capacityUnits} · {percent(row.stockPercent)}</MobileField>
              <MobileField label={tr(locale, "Projected runway", "المدة المتبقية")}>{days(row.daysToEmpty, locale)}</MobileField>
              <MobileField label={tr(locale, "Bring to target", "الكمية للوصول إلى الهدف")}>{row.unitsToTarget} {tr(locale, "units", "وحدة")}</MobileField>
              <MobileField label={tr(locale, "Trend", "الاتجاه")}>{row.averageDailyUnits.toFixed(1)}/{tr(locale, "day", "يوم")} · {trendLabel(row, locale)}</MobileField>
              <MobileField label={tr(locale, "Empty / low lanes", "المسارات الفارغة / المنخفضة")}>{row.emptyLanes} / {row.lowLanes}</MobileField>
              <MobileField label={tr(locale, "Action date", "موعد الإجراء")}>{row.actionDate}</MobileField>
            </div>
            {row.storageShortageUnits > 0 ? <p className="mt-3 rounded-lg bg-rose-50 p-2 text-xs font-medium text-rose-800">{tr(locale, `Storage is short by ${row.storageShortageUnits} units for this target.`, `المخزون ناقص بمقدار ${row.storageShortageUnits} وحدة للوصول إلى الهدف.`)}</p> : null}
            <div className="mt-3 flex gap-3 text-sm font-semibold"><Link className="link-secondary" href={`/machines/${row.machineId}`}>{tr(locale, "Machine history", "سجل الماكينة")}</Link><Link className="link-secondary" href={`/machines/${row.machineId}/edit`}>{tr(locale, "Policy", "السياسة")}</Link></div>
          </MobileRecordCard>
        ))}
      </MobileCardList>

      <DataTable className="hidden md:block" headers={[
        tr(locale, "Machine", "الماكينة"), tr(locale, "Action", "الإجراء"), tr(locale, "Stock", "المخزون"),
        tr(locale, "Empty / low lanes", "المسارات الفارغة / المنخفضة"), tr(locale, "Observed trend", "اتجاه الاستهلاك"),
        tr(locale, "Runway", "المدة المتبقية"), tr(locale, "Bring", "الكمية المطلوبة"), tr(locale, "Storage", "المخزن"),
        tr(locale, "Operating days", "أيام العمل"), tr(locale, "XY age", "عمر بيانات XY"), tr(locale, "Policy", "السياسة"),
      ]}>
        {forecasts.map((row) => (
          <tr key={row.machineId}>
            <td><Link className="font-semibold text-slate-950 hover:underline" href={`/machines/${row.machineId}`}>{row.machineName}</Link><div className="text-xs text-slate-500">{row.machineCode}</div></td>
            <td><StatusPill forecast={row} locale={locale} /><div className="mt-1 max-w-56 text-xs text-slate-500">{statusReason(row, locale)}</div><div className="mt-1 text-xs font-medium text-slate-700">{row.actionDate}</div></td>
            <td className="font-semibold">{row.currentUnits}/{row.capacityUnits}<div className="text-xs font-normal text-slate-500">{percent(row.stockPercent)}</div></td>
            <td>{row.emptyLanes} / {row.lowLanes}</td>
            <td>{row.averageDailyUnits.toFixed(1)} {tr(locale, "units/day", "وحدة/يوم")}<div className="text-xs text-slate-500">{trendLabel(row, locale)}</div></td>
            <td>{days(row.daysToEmpty, locale)}</td>
            <td>{row.unitsToTarget}</td>
            <td>{row.storageShortageUnits > 0 ? <span className="font-semibold text-rose-700">{tr(locale, `Short ${row.storageShortageUnits}`, `ناقص ${row.storageShortageUnits}`)}</span> : tr(locale, `${row.storageFillableUnits} available`, `${row.storageFillableUnits} متوفر`)}</td>
            <td>{schedule(row.openDays, locale)}</td>
            <td>{snapshotAge(row.snapshotAgeHours, locale)}</td>
            <td><Link className="link-secondary" href={`/machines/${row.machineId}/edit`}>{tr(locale, "Edit", "تعديل")}</Link></td>
          </tr>
        ))}
      </DataTable>
    </section>
  );
}
