"use client";

import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";

type CameraPhase = "camera" | "review";

type QualityAdvice = "dark" | "glare" | "blurry";

/** These are suggestions only; no pixel heuristic can confirm that a machine is in frame. */
export function analyzeGuidedMachinePhoto(canvas: HTMLCanvasElement): QualityAdvice[] {
  const sample = document.createElement("canvas");
  sample.width = 96;
  sample.height = 96;
  const ctx = sample.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(canvas, 0, 0, 96, 96);
  const data = ctx.getImageData(0, 0, 96, 96).data;
  const grays: number[] = [];
  let total = 0;
  let highlights = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
    total += lum;
    if (lum > 248) highlights++;
    grays.push(lum);
  }
  const advice: QualityAdvice[] = [];
  if (total / grays.length < 56) advice.push("dark");
  if (highlights / grays.length > 0.36) advice.push("glare");

  // Detect extreme motion blur by local high-frequency energy. Advisory only:
  // uniform or dark vending fronts can also yield low energy.
  let highFrequency = 0;
  let count = 0;
  for (let y = 1; y < 95; y += 2) {
    for (let x = 1; x < 95; x += 2) {
      const i = y * 96 + x;
      const laplace = 4 * grays[i] - grays[i - 1] - grays[i + 1] - grays[i - 96] - grays[i + 96];
      highFrequency += Math.abs(laplace);
      count++;
    }
  }
  if (count && highFrequency / count < 10) advice.push("blurry");
  return advice;
}

/**
 * Live portrait guide for the actual machine proof photograph. The entire
 * camera image is saved (not cropped to the overlay) so no vending selections
 * are cut off by a cosmetic frame.
 */
export function GuidedMachineCamera({
  disabled,
  onCaptured,
  selectionRowCount = 6,
}: {
  disabled: boolean;
  onCaptured: (file: File) => Promise<boolean>;
  selectionRowCount?: number;
}) {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<CameraPhase>("camera");
  const [cameraError, setCameraError] = useState("");
  const [working, setWorking] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [frameConfirmed, setFrameConfirmed] = useState(false);
  const [qualityAdvice, setQualityAdvice] = useState<QualityAdvice[]>([]);
  const [frameWidth, setFrameWidth] = useState<"standard" | "wide">("standard");
  const [saveError, setSaveError] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working) setOpen(false);
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", escape);
    };
  }, [open, working]);

  useEffect(() => {
    if (!open || phase !== "camera") return;
    let cancelled = false;
    let acquired: MediaStream | null = null;
    const start = async () => {
      setCameraError("");
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Browser camera preview is unavailable.");
        }
        acquired = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 2560 },
          },
        });
        if (cancelled) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = acquired;
        const video = videoRef.current;
        if (!video) throw new Error("Camera preview could not be displayed.");
        video.srcObject = acquired;
        await video.play();
      } catch {
        if (!cancelled) setCameraError(tr(
          "Live camera could not open. You can still use your phone camera below.",
          "تعذر فتح الكاميرا المباشرة. يمكنك استخدام كاميرا هاتفك من الخيار أدناه.",
        ));
      }
    };
    void start();
    return () => {
      cancelled = true;
      acquired?.getTracks().forEach((track) => track.stop());
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  // locale affects only the fallback message; reopen if the language changes.
  }, [open, phase, ar]);

  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [previewUrl]);

  const start = () => {
    setCameraError("");
    setSaveError("");
    setPreviewUrl(null);
    setPhotoFile(null);
    setFrameConfirmed(false);
    setQualityAdvice([]);
    setPhase("camera");
    setOpen(true);
  };

  const close = () => {
    if (working) return;
    setOpen(false);
    setPreviewUrl(null);
    setPhotoFile(null);
    setSaveError("");
    setPhase("camera");
  };

  const reviewFile = async (file: File, quality: QualityAdvice[] = []) => {
    if (!file.type.startsWith("image/")) {
      setSaveError(tr("Choose an image file.", "اختر ملف صورة."));
      return;
    }
    setPreviewUrl(URL.createObjectURL(file));
    setPhotoFile(file);
    setFrameConfirmed(false);
    setQualityAdvice(quality);
    setSaveError("");
    setPhase("review");
  };

  const capture = async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setCameraError(tr("Camera is not ready. Try again or use your phone camera.", "الكاميرا غير جاهزة. حاول مرة أخرى أو استخدم كاميرا الهاتف."));
      return;
    }
    setWorking(true);
    setSaveError("");
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not prepare the camera image.");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const advice = analyzeGuidedMachinePhoto(canvas);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("Could not capture the image.");
      const file = new File([blob], "snacky-guided-" + Date.now() + ".jpg", {
        type: "image/jpeg", lastModified: Date.now(),
      });
      await reviewFile(file, advice);
    } catch {
      setSaveError(tr("Could not capture this photo. Try again.", "تعذر التقاط هذه الصورة. حاول مرة أخرى."));
    } finally {
      setWorking(false);
    }
  };

  const save = async () => {
    if (!photoFile || !frameConfirmed || working) return;
    setWorking(true);
    setSaveError("");
    try {
      const saved = await onCaptured(photoFile);
      if (!saved) {
        setSaveError(tr("The photo was not saved. Check the error on the refill screen and retry.", "لم تُحفظ الصورة. راجع رسالة الخطأ في صفحة التعبئة وأعد المحاولة."));
        return;
      }
      setOpen(false);
      setPreviewUrl(null);
      setPhotoFile(null);
    } catch {
      setSaveError(tr("Photo upload failed. Retry without retaking the picture.", "فشل رفع الصورة. يمكنك إعادة المحاولة دون التقاط صورة جديدة."));
    } finally {
      setWorking(false);
    }
  };

  const adviceCopy: Record<QualityAdvice, string> = {
    dark: tr("Looks dark — increase the light.", "الصورة داكنة — حسّن الإضاءة."),
    glare: tr("Possible glare — move slightly to avoid reflections.", "قد يوجد انعكاس قوي — تحرك قليلاً لتجنبه."),
    blurry: tr("May be blurry — hold the phone steady and retake.", "قد تكون الصورة غير واضحة — ثبّت الهاتف وأعد التصوير."),
  };

  return (
    <>
      <button type="button" disabled={disabled} onClick={start}
        className="flex min-h-14 w-full items-center justify-center gap-3 rounded-xl bg-emerald-800 px-4 py-3 text-base font-extrabold text-white shadow-sm hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-50">
        <span aria-hidden="true" className="text-xl">◎</span>
        {tr("Open guided machine camera", "افتح كاميرا تصوير الماكينة بالإطار")}
      </button>
      {!open ? null : (
        <div role="dialog" aria-modal="true" aria-label={tr("Guided machine photograph", "تصوير الماكينة بإطار توجيهي")}
          dir={ar ? "rtl" : "ltr"} className="fixed inset-0 z-[200] overflow-y-auto bg-slate-950/95 text-white"
          style={{ paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}>
          <div className="mx-auto flex min-h-full w-full max-w-lg flex-col px-3">
            <header className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-extrabold uppercase tracking-[0.14em] text-amber-400">SNACKY · CAMERA GUIDE</div>
                <h2 className="mt-1 text-xl font-bold">{phase === "camera"
                  ? tr("Fit the entire machine in the frame", "ضع الماكينة بالكامل داخل الإطار")
                  : tr("Check photo before saving", "راجع الصورة قبل حفظها")}</h2>
              </div>
              <button type="button" aria-label={tr("Close camera", "إغلاق الكاميرا")} onClick={close}
                disabled={working} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15 text-2xl font-light disabled:opacity-50">×</button>
            </header>

            {phase === "camera" ? (
              <>
                <div className="mb-3 flex justify-center gap-2 text-xs font-bold">
                  <button type="button" onClick={() => setFrameWidth("standard")}
                    aria-pressed={frameWidth === "standard"}
                    className={frameWidth === "standard" ? "rounded-full bg-emerald-300 px-4 py-2 text-emerald-950" : "rounded-full bg-white/15 px-4 py-2 text-white"}>
                    {tr("Standard machine", "ماكينة عادية")}
                  </button>
                  <button type="button" onClick={() => setFrameWidth("wide")}
                    aria-pressed={frameWidth === "wide"}
                    className={frameWidth === "wide" ? "rounded-full bg-emerald-300 px-4 py-2 text-emerald-950" : "rounded-full bg-white/15 px-4 py-2 text-white"}>
                    {tr("Wide machine", "ماكينة عريضة")}
                  </button>
                </div>
                <div className="relative mx-auto aspect-[3/4] w-full max-w-[420px] overflow-hidden rounded-2xl border border-white/30 bg-slate-900 shadow-xl">
                  <video ref={videoRef} autoPlay muted playsInline
                    className="absolute inset-0 h-full w-full object-cover" aria-label={tr("Live rear camera", "الكاميرا الخلفية المباشرة")} />
                  <div aria-hidden="true" className={"pointer-events-none absolute bottom-[8%] top-[6%] " + (frameWidth === "wide" ? "inset-x-[5%]" : "inset-x-[13%]")}>
                    <div className="absolute inset-0 rounded-lg border-2 border-emerald-300/90 shadow-[0_0_0_999px_rgba(0,0,0,0.15)]" />
                    <div className="absolute inset-0 grid opacity-40"
                      style={{ gridTemplateRows: "repeat(" + Math.max(1, Math.min(12, selectionRowCount)) + ", minmax(0, 1fr))" }}>
                      {Array.from({ length: Math.max(1, Math.min(12, selectionRowCount)) }, (_, i) => <div key={i} className="border-b border-emerald-100/60 last:border-0" />)}
                    </div>
                    <div className="absolute left-0 top-0 h-7 w-7 border-l-[5px] border-t-[5px] border-amber-400" />
                    <div className="absolute right-0 top-0 h-7 w-7 border-r-[5px] border-t-[5px] border-amber-400" />
                    <div className="absolute bottom-0 left-0 h-7 w-7 border-b-[5px] border-l-[5px] border-amber-400" />
                    <div className="absolute bottom-0 right-0 h-7 w-7 border-b-[5px] border-r-[5px] border-amber-400" />
                    <div className="absolute inset-x-0 top-2 text-center text-[10px] font-bold tracking-wider text-white drop-shadow-lg">
                      {tr("TOP OF MACHINE", "أعلى الماكينة")}
                    </div>
                    <div className="absolute inset-x-0 bottom-2 text-center text-[10px] font-bold tracking-wider text-white drop-shadow-lg">
                      {tr("BOTTOM VISIBLE", "أسفل الماكينة ظاهر")}
                    </div>
                  </div>
                  <div className="pointer-events-none absolute inset-x-3 bottom-2 rounded-full bg-black/75 px-3 py-2 text-center text-xs font-bold text-white">
                    {tr("All 4 corners inside the green frame", "خلّي الزوايا الأربع للماكينة داخل الإطار الأخضر")}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs font-semibold text-slate-100">
                  <div className="rounded-xl bg-white/10 p-2">{tr("Straight-on", "مباشرة من الأمام")}</div>
                  <div className="rounded-xl bg-white/10 p-2">{tr("No glare", "بدون انعكاس")}</div>
                  <div className="rounded-xl bg-white/10 p-2">{tr("All shelves", "كل الصفوف ظاهرة")}</div>
                </div>
                <p className="mt-2 text-center text-xs leading-5 text-slate-300">
                  {tr("Move back until the screen, all product rows, and machine base fit. Keep the phone level. Do not photograph at an angle.",
                    "ارجع للخلف لين تظهر الشاشة وكل صفوف المنتجات وقاعدة الماكينة. خلي الهاتف مستقيم وصوّر من الأمام بدون ميلان.")}
                </p>
                {cameraError ? <p role="alert" className="mt-3 rounded-xl border border-amber-400 bg-amber-900/30 p-3 text-sm text-amber-100">{cameraError}</p> : null}
                {saveError ? <p role="alert" className="mt-3 rounded-xl bg-rose-950/70 p-3 text-sm text-rose-100">{saveError}</p> : null}
                <button type="button" onClick={() => void capture()} disabled={working || Boolean(cameraError)}
                  className="mt-3 min-h-14 w-full rounded-xl bg-amber-400 px-4 text-base font-extrabold text-slate-950 disabled:opacity-50">
                  {working ? tr("Capturing...", "جارٍ الالتقاط...") : tr("● Capture machine", "● تصوير الماكينة")}
                </button>
                <label className="mt-3 block cursor-pointer rounded-xl border border-white/40 bg-white/10 px-4 py-3 text-center text-sm font-semibold">
                  {tr("Use phone camera / gallery instead", "التصوير بكاميرا الهاتف أو اختيار صورة")}
                  <input ref={fileInputRef} type="file" accept="image/*" capture="environment" className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      event.target.value = "";
                      if (file) void reviewFile(file);
                    }} />
                </label>
              </>
            ) : (
              <>
                {previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt={tr("Machine photo preview", "معاينة صورة الماكينة")}
                    className="mx-auto max-h-[52dvh] w-full rounded-xl border border-white/30 bg-black object-contain" />
                ) : null}
                <p className="mt-3 rounded-xl bg-emerald-900/40 p-3 text-sm text-emerald-50">
                  {tr("Zoom in mentally: can you read the product packages and see all product rows? The guide is not proof of AI accuracy.",
                    "راجع الصورة: هل المنتجات واضحة وكل صفوف الماكينة ظاهرة؟ الإطار يساعد على التصوير لكنه لا يضمن دقة التعرف الآلي.")}
                </p>
                {qualityAdvice.length ? (
                  <div className="mt-2 space-y-1 rounded-xl border border-amber-500 bg-amber-950/40 p-3">
                    {qualityAdvice.map((advice) => <p key={advice} className="text-sm text-amber-100">⚠ {adviceCopy[advice]}</p>)}
                  </div>
                ) : null}
                <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-white/30 bg-white/10 p-4">
                  <input type="checkbox" checked={frameConfirmed} onChange={(event) => setFrameConfirmed(event.target.checked)}
                    className="mt-1 h-5 w-5 shrink-0 accent-emerald-400" />
                  <span className="text-sm font-semibold leading-6">
                    {tr("I can see the complete machine, all selection rows, and clear product fronts in this photo.",
                      "نتأكد إن الماكينة كاملة وكل الصفوف وواجهات المنتجات واضحة في الصورة.")}
                  </span>
                </label>
                {saveError ? <p role="alert" className="mt-3 rounded-xl bg-rose-950/70 p-3 text-sm text-rose-100">{saveError}</p> : null}
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button type="button" disabled={working} onClick={() => {
                    setPhotoFile(null);
                    setPreviewUrl(null);
                    setFrameConfirmed(false);
                    setPhase("camera");
                  }} className="min-h-12 rounded-xl border border-white/30 bg-white/10 px-3 text-sm font-bold disabled:opacity-50">
                    {tr("Retake", "إعادة التصوير")}
                  </button>
                  <button type="button" disabled={working || !frameConfirmed} onClick={() => void save()}
                    className="min-h-12 rounded-xl bg-emerald-400 px-3 text-sm font-extrabold text-emerald-950 disabled:opacity-50">
                    {working ? tr("Saving...", "جارٍ الحفظ...") : tr("Save photo to Snacky", "حفظ الصورة في سناكي")}
                  </button>
                </div>
              </>
            )}
            <div className="h-4" />
          </div>
        </div>
      )}
    </>
  );
}
