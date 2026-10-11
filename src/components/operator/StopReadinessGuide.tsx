"use client";

import { CheckCircle2, CircleAlert, CircleDot, ArrowUpRight } from "lucide-react";
import { useLanguage } from "@/components/I18nProvider";

type Step = {
  href: string;
  title: string;
  hint: string;
  state: "done" | "needed" | "review" | "optional";
  status: string;
};

/**
 * Informational guidance only: completion and stock/XY/cash writer semantics
 * remain in the existing canonical server route and handleCompleteStop.
 */
export function StopReadinessGuide({
  filledUnits, assignedUnits, cleaningDone, compressorRequired, compressorReady,
  photoSaved, photoSaving, xyEvidenceStatus, smartReturnsPending, smartXyPending,
}: {
  filledUnits: number;
  assignedUnits: number;
  cleaningDone: boolean;
  compressorRequired: boolean;
  compressorReady: boolean;
  photoSaved: boolean;
  photoSaving: boolean;
  xyEvidenceStatus?: string | null;
  smartReturnsPending: number;
  smartXyPending: number;
}) {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const photoStatus = photoSaving
    ? tr("Saving…", "جارٍ الحفظ…")
    : photoSaved ? tr("Saved", "محفوظة") : tr("Required", "مطلوبة");
  const steps: Step[] = [
    {
      href: "#stop-refill",
      title: tr("1. Refill quantities", "١. كميات التعبئة"),
      hint: tr("Enter actual fills, missing products and reasons.", "سجّل التعبئة الفعلية والنواقص والأسباب."),
      state: "review",
      status: `${filledUnits} / ${assignedUnits} ${tr("units entered", "قطعة مسجلة")}`,
    },
    {
      href: "#stop-xy-evidence",
      title: tr("2. XY verification", "٢. مراجعة XY"),
      hint: tr("Use technical evidence or record an offline exception when applicable.", "راجع حالة XY أو سجل تعذر الاتصال عند الحاجة."),
      state: xyEvidenceStatus === "xy_api_verified" ? "done"
        : xyEvidenceStatus === "offline_pending" ? "needed" : "optional",
      status: xyEvidenceStatus === "xy_api_verified" ? tr("Verified", "تم التحقق")
        : xyEvidenceStatus === "offline_pending" ? tr("Pending", "معلق")
        : tr("Review if needed", "راجع عند الحاجة"),
    },
    {
      href: "#stop-compressor",
      title: tr("3. Compressor proof", "٣. إثبات تشغيل الضاغط"),
      hint: tr("Confirm compressor ON and attach the correct proof image.", "تأكد من تشغيل الضاغط وأرفق صورة الإثبات الصحيحة."),
      state: compressorRequired ? compressorReady ? "done" : "needed" : "optional",
      status: compressorRequired
        ? compressorReady ? tr("Saved", "محفوظ") : tr("Required", "مطلوب")
        : tr("If required", "عند الحاجة"),
    },
    {
      href: "#stop-proof-photo",
      title: tr("4. Final machine photo", "٤. صورة الماكينة النهائية"),
      hint: tr("Take after filling and cleaning; wait until upload finishes.", "التقطها بعد التعبئة والتنظيف وانتظر اكتمال الحفظ."),
      state: photoSaved ? "done" : "needed",
      status: photoStatus,
    },
    {
      href: "#stop-cleaning",
      title: tr("5. Final checklist", "٥. قائمة الفحص النهائي"),
      hint: tr("Complete checks before finishing the stop.", "أكمل الفحوصات قبل إنهاء الموقع."),
      state: cleaningDone ? "done" : "needed",
      status: cleaningDone ? tr("Completed", "مكتملة") : tr("Required", "مطلوبة"),
    },
  ];
  if (smartReturnsPending > 0 || smartXyPending > 0) {
    steps.splice(1, 0, {
      href: "#stop-smart-changes",
      title: tr("Smart Route changes", "تغييرات الجولة الذكية"),
      hint: tr("Return old products and verify executed product changes.", "أرجع المنتجات القديمة وتأكد من تغييرات المنتجات المنفذة."),
      state: "needed",
      status: tr(`${smartReturnsPending} returns · ${smartXyPending} XY`,
        `${smartReturnsPending} إرجاع · ${smartXyPending} XY`),
    });
  }
  const requiredRemaining = steps.filter((step) => step.state === "needed").length;
  return (
    <section aria-labelledby="stop-readiness-title"
      className="rounded-2xl border border-emerald-200 bg-white p-4 shadow-[0_2px_18px_rgba(15,23,42,0.05)] sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-emerald-700">
            SNACKY · {tr("STOP GUIDE", "دليل الموقع")}
          </p>
          <h2 id="stop-readiness-title" className="mt-1 text-lg font-extrabold text-slate-950">
            {tr("Finish this stop, step by step", "إنهاء الموقع خطوة بخطوة")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {tr("Tap a step to jump to its form. This guide does not change saving or inventory rules.",
              "اضغط على خطوة للانتقال لنموذجها. الدليل لا يغيّر طريقة الحفظ أو قواعد المخزون.")}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1.5 text-xs font-bold ${requiredRemaining
          ? "bg-amber-50 text-amber-900 ring-1 ring-amber-200"
          : "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200"}`}>
          {requiredRemaining
            ? tr(`${requiredRemaining} items to check`, `${requiredRemaining} خطوات تحتاج مراجعة`)
            : tr("Required checks ready", "الفحوصات المطلوبة جاهزة")}
        </span>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {steps.map((step) => {
          const Icon = step.state === "done" ? CheckCircle2 : step.state === "needed" ? CircleAlert : CircleDot;
          return (
            <a key={step.href} href={step.href}
              className="group flex min-h-24 items-start gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3 transition-colors hover:border-emerald-300 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500">
              <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${step.state === "done"
                ? "bg-emerald-100 text-emerald-800" : step.state === "needed"
                  ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-500"}`}>
                <Icon aria-hidden="true" className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-slate-900">{step.title}</p>
                <p className="mt-0.5 text-xs leading-5 text-slate-600">{step.hint}</p>
                <p className="mt-1 text-xs font-bold text-emerald-800">{step.status}</p>
              </div>
              <ArrowUpRight aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400 group-hover:text-emerald-700" />
            </a>
          );
        })}
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-500">
        {tr("Complete Stop retains all existing validation rules; optional XY notes are not the same as confirmed stock sync.",
          "زر إنهاء الموقع يحتفظ بنفس شروط النظام الحالية. الملاحظات الاختيارية حول XY ليست إثباتاً لتزامن المخزون.")}
      </p>
    </section>
  );
}
