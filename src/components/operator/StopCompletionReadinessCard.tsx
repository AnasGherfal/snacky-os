"use client";

import type { StopReadinessKind, StopReadinessStep } from "@/lib/operator-stop-readiness";

const titles: Record<StopReadinessKind, {en:string; ar:string}> = {
  cleaning: { en: "Cleaning and final check", ar: "التنظيف والفحص النهائي" },
  photo: { en: "Final machine photo", ar: "الصورة النهائية للجهاز" },
  "smart-return": { en: "Return replaced products", ar: "إرجاع المنتجات المستبدلة" },
  "smart-xy": { en: "Save Smart Route XY changes", ar: "حفظ تغييرات XY للجولة الذكية" },
  compressor: { en: "Compressor ON proof", ar: "إثبات تشغيل الضاغط" },
};

export function StopCompletionReadinessCard({
  steps,
  remainingCount,
  busy,
  locale,
  savedPhoto,
  selectedPhoto,
  onOpenCleaning,
}: {
  steps: StopReadinessStep[];
  remainingCount: number;
  busy: boolean;
  locale: "en" | "ar";
  savedPhoto: boolean;
  selectedPhoto: boolean;
  onOpenCleaning: () => void;
}) {
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  return (
    <section id="stop-ready-checks" aria-labelledby="stop-ready-title"
      className="scroll-mt-24 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-emerald-950 px-4 py-4 text-white sm:px-5">
        <div>
          <h2 id="stop-ready-title" className="text-lg font-bold">
            {tr("Before completing this stop", "قبل إنهاء الموقع")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-emerald-100">
            {tr("Finish only the remaining checks. Tap one to go to it.", "أكمل الفحوصات الناقصة فقط. اضغط على أي فحص للانتقال إليه.")}
          </p>
        </div>
        <span aria-live="polite" className="rounded-full border border-white/25 bg-white/10 px-3 py-1 text-xs font-semibold tabular-nums">
          {busy ? tr("Saving…", "جارٍ الحفظ…") : remainingCount === 0
            ? tr("Ready to submit", "جاهز للإرسال")
            : tr(`${remainingCount} remaining`, `المتبقي ${remainingCount}`)}
        </span>
      </div>
      <div className="grid gap-2 p-3 sm:grid-cols-2 sm:p-4">
        {steps.map(step => {
          const photoSelectedButNotSaved = step.kind === "photo" && selectedPhoto && !savedPhoto;
          return <a key={step.kind} href={`#${step.anchor}`}
            onClick={step.kind === "cleaning" ? onOpenCleaning : undefined}
            className="flex min-h-14 items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-start transition-colors hover:border-emerald-400 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2">
            <span aria-hidden="true"
              className={step.done
                ? "flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-800"
                : "flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-sm font-bold text-amber-900"}>
              {step.done ? "✓" : "!"}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-slate-900">{ar ? titles[step.kind].ar : titles[step.kind].en}</span>
              <span className="mt-0.5 block text-xs leading-5 text-slate-600">
                {photoSelectedButNotSaved
                  ? tr("Selected — will be uploaded on Complete Stop, not yet saved.", "الصورة محددة وستُرفع عند إنهاء الموقع، ولم تُحفظ بعد.")
                  : step.done
                    ? step.kind === "smart-xy"
                      ? tr("Change saved or safely queued; remote XY verification may still be pending.", "تم حفظ التغيير أو إضافته لقائمة التحديث؛ وقد يتأخر تأكيد XY.")
                      : tr("Ready", "جاهز")
                    : tr("Action needed — tap to review", "مطلوب إكماله — اضغط للمراجعة")}
              </span>
            </span>
          </a>;
        })}
      </div>
      <p className="border-t border-slate-100 px-4 py-3 text-xs leading-5 text-slate-600 sm:px-5">
        {tr(
          "Actual refill quantities are saved automatically when you tap Complete Stop. XY screenshots are optional; the server will verify inventory and evidence before committing.",
          "تُحفظ كميات التعبئة الفعلية تلقائياً عند الضغط على إنهاء الموقع. صور XY اختيارية، ويتحقق النظام من المخزون والإثبات قبل الاعتماد.",
        )}
      </p>
    </section>
  );
}
