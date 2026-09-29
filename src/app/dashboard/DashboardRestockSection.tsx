import Link from "next/link";
import { cache } from "react";
import { StatCard } from "@/components/StatCard";
import { getAuthenticatedSupabaseServerClient } from "@/lib/auth";
import { loadRestockPriorityData } from "@/lib/restock-priority-data";
import { restockCounts } from "@/lib/restock-priority";

type Locale = "en" | "ar";

const loadDashboardRestock = cache(async () => {
  const supabase = await getAuthenticatedSupabaseServerClient();
  if (!supabase) return { result: null, error: "Supabase unavailable" };
  try {
    return { result: await loadRestockPriorityData(supabase), error: null };
  } catch (error) {
    console.error("[dashboard:restock] Deferred restock summary failed", error);
    return { result: null, error: error instanceof Error ? error.message : String(error) };
  }
});

function localize(locale: Locale, en: string, ar: string) {
  return locale === "ar" ? ar : en;
}

export function DashboardRestockStatSkeleton({ locale }: { locale: Locale }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4" aria-busy="true">
      <div className="text-sm text-slate-500">{localize(locale, "Critical products", "المنتجات الحرجة")}</div>
      <div className="mt-2 h-8 w-12 animate-pulse rounded bg-slate-100" />
      <div className="mt-2 h-3 w-32 animate-pulse rounded bg-slate-100" />
    </div>
  );
}

export async function DashboardRestockStat({ locale }: { locale: Locale }) {
  const { result, error } = await loadDashboardRestock();
  if (!result || error) {
    return <StatCard label={localize(locale, "Critical products", "المنتجات الحرجة")} value="-" note={localize(locale, "Restock engine unavailable", "محرك إعادة التخزين غير متاح")} />;
  }
  const summary = restockCounts(result.items);
  const warningCount = Object.values(result.errors ?? {}).filter(Boolean).length;
  return (
    <StatCard
      label={localize(locale, "Critical products", "المنتجات الحرجة")}
      value={summary.critical.toLocaleString("en-US")}
      note={warningCount
        ? localize(locale, `${summary.low} more products are low · some inputs partial`, `${summary.low} منتجات منخفضة إضافية · بعض البيانات جزئية`)
        : localize(locale, `${summary.low} more products are low`, `${summary.low} منتجات منخفضة إضافية`)}
    />
  );
}

export async function DashboardRestockAction({ locale }: { locale: Locale }) {
  const { result } = await loadDashboardRestock();
  if (!result) return null;
  const summary = restockCounts(result.items);
  if (summary.critical <= 0) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900">{localize(locale, "Buy critical products", "شراء المنتجات الحرجة")}</div>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {localize(
              locale,
              `${summary.critical} product${summary.critical === 1 ? "" : "s"} are already at critical restock level.`,
              `${summary.critical} منتج${summary.critical === 1 ? "" : "ات"} وصلت إلى مستوى إعادة تخزين حرج.`,
            )}
          </p>
        </div>
        <Link href="/restock-priority?filter=critical" className="btn-secondary shrink-0">
          {localize(locale, "Open restock priority", "فتح أولوية إعادة التخزين")}
        </Link>
      </div>
    </div>
  );
}

export async function DashboardRestockWarning({ locale }: { locale: Locale }) {
  const { result } = await loadDashboardRestock();
  if (!result) return null;
  const warnings = Object.values(result.errors ?? {}).filter(Boolean);
  if (!warnings.length) return null;
  return (
    <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      {localize(locale, "Some restock inputs are still partial, so critical product counts use the healthy signals that are available.", "بعض بيانات إعادة التخزين ما زالت جزئية، لذلك تعتمد أعداد المنتجات الحرجة على الإشارات السليمة المتاحة.")}
    </div>
  );
}
