import type { ReactNode } from "react";

import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { getServerI18n } from "@/lib/i18n/server";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

const DEFAULT_HISTORY_MONTHS = 3;

function formatDate(date: Date, locale: string) {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-LY" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatRange(start: Date, end: Date, locale: string) {
  return `${formatDate(start, locale)} – ${formatDate(end, locale)}`;
}

async function loadConfiguredHistoryMonths() {
  const authenticated = await getAuthenticatedSupabaseServerClient();
  const client = getSupabaseAdminClient() ?? authenticated;
  if (!client) return DEFAULT_HISTORY_MONTHS;

  const result = await client
    .from("growth_decision_settings")
    .select("minimum_history_months")
    .eq("singleton", true)
    .maybeSingle();

  const value = Number(result.data?.minimum_history_months);
  return Number.isFinite(value) && value > 0
    ? Math.round(value)
    : DEFAULT_HISTORY_MONTHS;
}

export default async function GrowthDecisionsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { locale } = await getServerI18n();
  const ar = locale === "ar";
  const configuredHistoryMonths = await loadConfiguredHistoryMonths();
  const now = new Date();

  // Keep these dates identical to the Growth Decisions page:
  // six completed calendar months, excluding the current partial month.
  const historyStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1),
  );
  const historyEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0),
  );
  const latestMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  );

  const snapshotLabel = formatDate(now, locale);
  const historyRange = formatRange(historyStart, historyEnd, locale);
  const latestMonthRange = formatRange(
    latestMonthStart,
    historyEnd,
    locale,
  );

  return (
    <div className="space-y-6">
      <section
        dir={ar ? "rtl" : "ltr"}
        className="rounded-3xl border border-sky-200 bg-sky-50/70 p-5 shadow-sm"
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="text-xs font-semibold uppercase tracking-wide text-sky-700">
              {ar ? "دليل قراءة الصفحة" : "How to read this page"}
            </div>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">
              {ar
                ? "الأرقام هنا لا تستخدم كلها نفس الفترة"
                : "The figures on this page do not all use the same period"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-700">
              {ar
                ? "بعض الأرقام أرصدة حالية وإجمالية، وبعضها متوسطات تاريخية، وبعضها يخص آخر شهر مكتمل فقط. الفترات الدقيقة موضحة أدناه."
                : "Some figures are current overall balances, some are historical averages, and some use only the latest completed month. The exact periods are shown below."}
            </p>
          </div>
          <div className="w-fit rounded-full border border-sky-200 bg-white px-3 py-1.5 text-xs font-semibold text-sky-900">
            {ar ? `الوضع حتى ${snapshotLabel}` : `Snapshot as of ${snapshotLabel}`}
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-sky-100 bg-white p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {ar ? "حالي وإجمالي" : "Current and overall"}
            </div>
            <div className="mt-1 font-semibold text-slate-950">
              {ar ? `حتى ${snapshotLabel}` : `As of ${snapshotLabel}`}
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {ar
                ? "النقد المتاح، مستحق المستثمر غير المدفوع، الأعطال الحرجة، احتياجات الشراء الحرجة، والمواقع المقبولة. هذه ليست أرقام شهر واحد."
                : "Available cash, unpaid investor amount, critical issues, critical restocking needs, and accepted locations. These are not one-month figures."}
            </p>
          </div>

          <div className="rounded-2xl border border-sky-100 bg-white p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {ar ? "نافذة المراجعة" : "Review window"}
            </div>
            <div className="mt-1 font-semibold text-slate-950">
              {historyRange}
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {ar
                ? "آخر 6 أشهر تقويمية مكتملة. منها يأتي مخطط المبيعات، نسبة تغطية التكلفة، وقيمة المبيعات الناقصة التكلفة. الشهر الحالي غير المكتمل مستبعد."
                : "The last six completed calendar months. This period is used for the sales chart, cost-coverage percentage, and missing-cost revenue. The current partial month is excluded."}
            </p>
          </div>

          <div className="rounded-2xl border border-sky-100 bg-white p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {ar ? "متوسط الربح الشهري" : "Monthly profit average"}
            </div>
            <div className="mt-1 font-semibold text-slate-950">
              {ar
                ? `آخر ${configuredHistoryMonths} أشهر مكتملة صالحة`
                : `Latest ${configuredHistoryMonths} complete usable months`}
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {ar
                ? "متوسط الربح التشغيلي يستخدم عدد الأشهر المحدد في قواعد القرار داخل نافذة الستة أشهر. الشهر الذي تنقصه تكلفة منتج لا يدخل في المتوسط الموثوق."
                : "Average monthly operating profit uses the number set in the decision rules, selected from the six-month window. A month with incomplete product costs is not included as a reliable month."}
            </p>
          </div>

          <div className="rounded-2xl border border-sky-100 bg-white p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {ar ? "ربح الجهاز والاسترداد" : "Machine profit and payback"}
            </div>
            <div className="mt-1 font-semibold text-slate-950">
              {latestMonthRange}
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {ar
                ? "متوسط ربح الجهاز بعد الإيجار ومدة استرداد تكلفة جهاز جديد يعتمدان على آخر شهر مكتمل فقط، ومتوسط الأجهزة النشطة."
                : "Average machine profit after rent and the new-machine payback estimate use only the latest completed month, averaged across active machines."}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="text-sm font-semibold text-slate-950">
            {ar ? "معادلة النقد بعد الشراء" : "Cash-after-purchase formula"}
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-700">
            {ar
              ? "النقد الحالي لسناكي − جميع مستحقات المستثمر غير المدفوعة − احتياطي شراء المنتجات المحدد في القواعد − تكلفة الجهاز = النقد المتبقي بعد الشراء. بعد ذلك يتأكد النظام أن المبلغ المتبقي لا يقل عن الحد الأدنى للاحتياطي النقدي."
              : "Current Snacky cash − all unpaid investor amounts − the protected restocking reserve set in the rules − machine cost = cash left after purchase. The system then checks that the remaining cash is still at or above the minimum cash reserve."}
          </p>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <div className="rounded-xl border border-sky-200 bg-sky-100/70 p-3 text-sm text-sky-950">
            <div className="font-semibold">
              {ar ? "ملاحظة زرقاء" : "Blue data note"}
            </div>
            <p className="mt-1 leading-5">
              {ar
                ? "القرار يمكن أن يستمر، لكن النظام يحتسب المبيعات المتأثرة بربح صفري حتى لا يبالغ في الربح."
                : "The decision may continue, but affected sales are treated as zero profit so the result is not overstated."}
            </p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-100/70 p-3 text-sm text-amber-950">
            <div className="font-semibold">
              {ar ? "تحذير أصفر" : "Amber blocking warning"}
            </div>
            <p className="mt-1 leading-5">
              {ar
                ? "قرار الشراء متوقف. لا تعتمد على توصية الشراء أو مدة الاسترداد إلى أن تُحل المشكلة المذكورة."
                : "The purchase decision is paused. Do not rely on the buy recommendation or payback until the stated problem is fixed."}
            </p>
          </div>
          <div className="rounded-xl border border-rose-200 bg-rose-100/70 p-3 text-sm text-rose-950">
            <div className="font-semibold">
              {ar ? "خطأ أحمر" : "Red source error"}
            </div>
            <p className="mt-1 leading-5">
              {ar
                ? "تعذر تحميل مصدر مطلوب، ولذلك لا توجد نتيجة صالحة للقرار."
                : "A required source failed to load, so there is no valid decision result."}
            </p>
          </div>
        </div>

        <p className="mt-4 text-xs leading-5 text-slate-600">
          {ar
            ? "درجة الجاهزية هي نقاط لقائمة شروط وليست احتمال نجاح، وليست رصيداً مالياً، ولا تعني أن النسبة نفسها من القرار مؤكدة."
            : "The readiness score is a rule-checklist score. It is not a probability of success, not a cash balance, and not a percentage certainty."}
        </p>
      </section>

      {children}
    </div>
  );
}
