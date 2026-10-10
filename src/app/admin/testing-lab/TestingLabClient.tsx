"use client";

import Link from "next/link";
import { useLanguage } from "@/components/I18nProvider";
import { PhotoLibraryAiTest } from "@/components/testing-lab/PhotoLibraryAiTest";
import { TrainingRouteClient } from "@/components/testing-lab/TrainingRouteClient";

/** Owner-only entry point; no real route IDs, XY writes or storage postings. */
export default function TestingLabClient() {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;

  return (
    <main dir={ar ? "rtl" : "ltr"} className="mx-auto max-w-6xl space-y-6 px-3 py-6 sm:px-6">
      <header className="rounded-3xl bg-emerald-950 p-5 text-white sm:p-8">
        <div className="text-xs font-black uppercase tracking-[0.16em] text-amber-300">SNACKY · OWNER QA</div>
        <h1 className="mt-2 text-2xl font-extrabold sm:text-3xl">{tr("Testing Lab", "مختبر الاختبارات")}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-emerald-100">
          {tr(
            "Practice the operator's route before releasing new features. Photo recognition and the training route are strictly isolated from live XY machines, warehouse stock, and cash.",
            "تدرّب على جولة المشغل قبل تفعيل الميزات الجديدة. اختبار الصور والجولة التدريبية منفصلين تماماً عن ماكينات XY ومخزون المخزن والنقدية.",
          )}
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <a href="#training-route" className="rounded-xl bg-white px-4 py-3 text-center text-sm font-bold text-emerald-950">
            {tr("Practice full route", "تجربة الجولة الكاملة")}
          </a>
          <a href="#owner-photo-library-test" className="rounded-xl border border-emerald-300 px-4 py-3 text-center text-sm font-bold text-white">
            {tr("Test AI photo recognition", "اختبار تحليل الصور")}
          </a>
          <Link href="/admin" className="rounded-xl border border-emerald-300 px-4 py-3 text-center text-sm font-bold text-white">
            {tr("Back to Admin", "العودة للإدارة")}
          </Link>
        </div>
      </header>

      <TrainingRouteClient />

      <PhotoLibraryAiTest />

      <p className="rounded-xl border border-slate-200 bg-white p-4 text-xs leading-6 text-slate-600">
        {tr(
          "Training uses example route data and the real machine selection editor. It does not create a production route, and it cannot prove that XY has actually synchronized. Only a supervised field test can validate that.",
          "التدريب يستخدم بيانات جولة تجريبية ونفس محرر خانات الماكينة. ما ينشئش جولة حقيقية وما يثبتش أن XY تزامن فعلياً. التحقق الحقيقي يكون بتجربة ميدانية تحت إشراف.",
        )}
      </p>
    </main>
  );
}
