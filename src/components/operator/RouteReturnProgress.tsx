"use client";

import type { ReturnReadinessStep } from "@/lib/operator-return-readiness";

const steps: Record<ReturnReadinessStep["kind"], [string,string]> = {
  count: ["Count and confirm the next product", "عدّ المنتج التالي وأكّد كميته"],
  empty_bag: ["Confirm the bag is physically empty", "تأكد فعلياً أن الحقيبة فارغة"],
  return_destination: ["Choose where stock will be handed over", "حدّد مكان تسليم المخزون"],
  variance_reason: ["Explain any difference from Snacky OS", "وضّح سبب الفرق عن رصيد سناكي"],
  cancel_reason: ["Enter the cancellation reason", "أدخل سبب إلغاء الجولة"],
};

export function RouteReturnProgress({
  countTotal,
  countConfirmed,
  enteredTotal,
  confirmedTotal,
  possibleVariance,
  physicalCountComplete,
  nextStep,
  canSubmit,
  pendingDraft,
  locale,
}: {
  countTotal: number;
  countConfirmed: number;
  enteredTotal: number | null;
  confirmedTotal: number | null;
  possibleVariance: boolean;
  physicalCountComplete: boolean;
  nextStep: ReturnReadinessStep | null;
  canSubmit: boolean;
  pendingDraft: boolean;
  locale: "ar" | "en";
}) {
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  return (
    <section aria-labelledby="return-count-progress-title"
      className="scroll-mt-20 overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 bg-emerald-950 px-4 py-4 text-white sm:px-5">
        <div>
          <h2 id="return-count-progress-title" className="text-lg font-bold">
            {tr("End-of-route physical count", "العدّ الفعلي بنهاية الجولة")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-emerald-100">
            {tr("The suggested quantities below are from the ledger. Count each product yourself before confirming it.",
              "الكميات المقترحة أدناه من سجل سناكي. عدّ كل منتج فعلياً قبل تأكيده.")}
          </p>
        </div>
        <span aria-live="polite" className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold tabular-nums">
          {countTotal
            ? tr(`${countConfirmed} / ${countTotal} checked`, `تم عدّ ${countConfirmed} من ${countTotal}`)
            : tr(physicalCountComplete ? "Empty bag verified" : "Check empty bag", physicalCountComplete ? "تم تأكيد خلو الحقيبة" : "تحقق من الحقيبة الفارغة")}
        </span>
      </div>

      {countTotal > 0 ? (
        <div className="px-4 pt-4 sm:px-5">
          <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar"
            aria-label={tr("Products physically confirmed", "المنتجات المؤكدة بعد العد الفعلي")}
            aria-valuemin={0} aria-valuemax={countTotal} aria-valuenow={countConfirmed}>
            <div className="h-full rounded-full bg-emerald-600" style={{ width: (countConfirmed / countTotal * 100) + "%" }} />
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 p-4 sm:gap-4 sm:p-5">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs leading-5 text-slate-600">{tr("Entered units · NOT verified until counted", "الوحدات المُدخلة · غير مؤكدة حتى تُعدّ")}</p>
          <strong className="mt-1 block text-xl font-bold tabular-nums text-slate-950">
            {enteredTotal === null ? tr("Unverified", "غير مؤكد") : enteredTotal}
          </strong>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs leading-5 text-slate-600">{tr("Units in confirmed product rows", "وحدات المنتجات التي تم تأكيد عدّها")}</p>
          <strong className="mt-1 block text-xl font-bold tabular-nums text-emerald-800">
            {confirmedTotal === null ? tr("Unverified", "غير مؤكد") : confirmedTotal}
          </strong>
        </div>
      </div>

      {possibleVariance && !physicalCountComplete ? (
        <p role="status" className="mx-4 mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900 sm:mx-5">
          {tr("A potential stock difference is shown. Confirm the physical quantities before treating it as a variance.",
            "هناك فرق محتمل في المخزون. أكّد العدّ الفعلي قبل اعتباره فرقاً نهائياً.")}
        </p>
      ) : null}
      {pendingDraft ? (
        <p role="status" className="mx-4 mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 sm:mx-5">
          {tr("Restore or discard the saved draft before completing the route.",
            "استعد المسودة المحفوظة أو تجاهلها قبل إنهاء الجولة.")}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm sm:px-5">
        <strong className={canSubmit ? "text-emerald-800" : "text-amber-900"}>
          {canSubmit
            ? tr("Checks ready for final submission", "الفحوصات جاهزة للإرسال النهائي")
            : tr("Physical count / handoff checks still pending", "العدّ الفعلي أو تسليم المخزون لم يكتمل")}
        </strong>
        {nextStep ? (
          <a href={"#" + nextStep.anchor}
            className="flex min-h-11 w-full items-center justify-center rounded-xl border border-emerald-300 bg-white px-4 py-2 text-center font-semibold text-emerald-900 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 sm:w-auto">
            {tr(...steps[nextStep.kind])}
          </a>
        ) : null}
      </div>
      <p className="px-4 pb-3 text-xs leading-5 text-slate-500 sm:px-5">
        {tr("The server will check the ledger token and physical counts again before making an inventory movement.",
          "سيتحقق النظام مرة أخرى من سجل المخزون والعدّ الفعلي قبل تسجيل أي حركة مخزون.")}
      </p>
    </section>
  );
}
