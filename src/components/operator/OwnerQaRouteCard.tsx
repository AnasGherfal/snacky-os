import Link from "next/link";

/**
 * Owner-only PINNED route entry. Uses genuine Snacky machine/product snapshots
 * but operates in an isolated browser session so no real stock is deducted.
 * Do not pass this off as an active database route or include it in real KPIs.
 */
export function OwnerQaRouteCard({ locale = "en" }: { locale?: "en" | "ar" }) {
  const ar = locale === "ar";
  return (
    <Link
      href="/operator/routes/qa-real"
      prefetch={false}
      className="block rounded-2xl border-2 border-emerald-400 bg-emerald-50 p-4 shadow-sm transition hover:border-emerald-600 hover:shadow-md sm:p-5"
      aria-label={ar ? "افتح جولة التجربة باستخدام بيانات الماكينات الحقيقية" : "Open real-machine test route"}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-black uppercase tracking-wide text-emerald-800">
            {ar ? "جولة التجربة الخاصة بالمالك" : "OWNER TEST ROUTE"}
          </p>
          <h2 className="mt-2 text-lg font-extrabold text-slate-950">
            {ar ? "جولة تجريبية — HT Mall وجامعة الخليج" : "Test Route — HT Mall & Khalij University"}
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-700">
            {ar
              ? "موقعان حقيقيان ومنتجات سناكي وخاناتها الفعلية من آخر بيانات XY المستوردة. نفّذ خطوات الاستلام والتعبئة والتحقق بدون خصم المخزون أو تغيير الماكينات."
              : "Two real machine layouts, actual Snacky products and imported XY stock. Practice pickup, refill, photo proof and verification without changing inventory or vending machines."}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-amber-100 px-3 py-1 text-xs font-extrabold text-amber-950">
          {ar ? "تدريب آمن · لا تعديل" : "SAFE TEST · NO WRITES"}
        </span>
      </div>
      <span className="mt-4 block rounded-xl bg-emerald-800 px-4 py-3 text-center text-sm font-extrabold text-white">
        {ar ? "افتح جولة التجربة ←" : "Open Test Route →"}
      </span>
    </Link>
  );
}
