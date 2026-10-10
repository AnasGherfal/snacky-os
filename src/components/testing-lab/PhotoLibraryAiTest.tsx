"use client";

import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";
import type { GalleryResult } from "@/lib/xy-photo-gallery-test";

type VisionResponse = {
  ok?: boolean;
  error?: string;
  photoQuality?: "good" | "partial" | "unreadable";
  observations?: GalleryResult[];
  rejectedObservations?: number;
  analyzedAt?: string;
};

async function galleryJpeg(file: File): Promise<File> {
  if (file.size > 18 * 1024 * 1024) throw new Error("Photo is too large. Choose one under 18MB.");
  if (file.type === "image/jpeg" && file.size <= 3.8 * 1024 * 1024) return file;
  if (!file.type.startsWith("image/")) throw new Error("Choose a picture from your photo library.");

  // Browser conversion also handles iPhone HEIC where Safari can decode it.
  // Never upload the original large file if it is not supported by the AI endpoint.
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error("This photo could not be opened. Export it as JPEG and try again.");
    }
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      throw new Error("This photo has no readable image data. Export it as JPEG and try again.");
    }
    const maxDimension = 2200;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not prepare the selected photo.");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    let blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.83));
    if (blob && blob.size > 3.8 * 1024 * 1024) {
      const lower = document.createElement("canvas");
      const shrink = Math.min(1, 1600 / Math.max(canvas.width, canvas.height));
      lower.width = Math.max(1, Math.floor(canvas.width * shrink));
      lower.height = Math.max(1, Math.floor(canvas.height * shrink));
      const lowerContext = lower.getContext("2d");
      if (!lowerContext) throw new Error("Could not compress the photo for analysis.");
      lowerContext.drawImage(canvas, 0, 0, lower.width, lower.height);
      blob = await new Promise<Blob | null>((resolve) => lower.toBlob(resolve, "image/jpeg", 0.75));
    }
    if (!blob || blob.size > 3.8 * 1024 * 1024) throw new Error("Photo is still too large. Try a smaller JPEG.");
    return new File([blob], "snacky-gallery-photo-test.jpg", { type: "image/jpeg", lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** No physical machine required. Only the owner's selected library photo is sent to AI. */
export function PhotoLibraryAiTest() {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const [permission, setPermission] = useState<"loading" | "owner" | "no">("loading");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<VisionResponse | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/xy-photo-gallery-test", { cache: "no-store" })
      .then(async (response) => ({ response, body: await response.json().catch(() => null) }))
      .then(({ response, body }) => {
        if (!alive) return;
        setPermission(response.ok && body?.available === true ? "owner" : "no");
        setConfigured(body?.configured === true);
      }).catch(() => { if (alive) setPermission("no"); });
    return () => { alive = false; };
  }, []);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  if (permission !== "owner") return null;

  async function choosePhoto(selected: File | null) {
    if (!selected) return;
    setError("");
    setResult(null);
    setPhoto(null);
    if (!selected.type.startsWith("image/")) {
      setError(tr("Choose a picture from your Photos library.", "اختر صورة من مكتبة الصور."));
      return;
    }
    setPhoto(selected);
    setPreview(URL.createObjectURL(selected));
  }

  async function recognize() {
    if (!photo || working) return;
    setError("");
    if (configured === false) {
      setError(tr("Photo AI is not connected on this server. Add OPENAI_API_KEY to the Snacky OS production environment and redeploy. Photo preview and all training-route simulations still work without it.", "تحليل الصور بالذكاء الاصطناعي غير مفعّل على الخادم. أضف OPENAI_API_KEY إلى إعدادات بيئة الإنتاج في سناكي وأعد النشر. معاينة الصور والجولة التدريبية تعمل بدون المفتاح."));
      return;
    }
    setResult(null);
    setWorking(true);
    try {
      const prepared = await galleryJpeg(photo);
      const form = new FormData();
      form.set("photo", prepared);
      const response = await fetch("/api/admin/xy-photo-gallery-test", {
        method: "POST", body: form, cache: "no-store", headers: { Accept: "application/json" },
      });
      const data = await response.json().catch(() => null) as VisionResponse | null;
      if (!response.ok || data?.ok !== true) throw new Error(data?.error || "Image detection failed.");
      setResult(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("Could not analyze photo.", "تعذر تحليل الصورة."));
    } finally {
      setWorking(false);
    }
  }

  const observations = result?.observations ?? [];
  const quality = result?.photoQuality;
  return (
    <section id="owner-photo-library-test" className="overflow-hidden rounded-3xl border-2 border-emerald-400 bg-white shadow-sm">
      <header className="bg-emerald-950 p-5 text-white sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-bold tracking-[0.18em] text-amber-300">SNACKY · PHOTO AI LAB</span>
          <span className="rounded-full border border-amber-300/70 px-3 py-1 text-[11px] font-extrabold text-amber-200">
            {tr("OWNER TEST · NO XY CHANGES", "تجربة للمالك · بدون تغيير XY")}
          </span>
        </div>
        <h2 className="mt-3 text-2xl font-extrabold">{tr("Test with a photo from your library", "جرّب بصورة من مكتبة هاتفك")}</h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-emerald-100">
          {tr("No need to be near a machine. Select an older vending photo, and Snacky AI will try to recognize visible products and their approximate row/position. Nothing is written to XY or Snacky inventory.",
            "مش لازم تكون عند الماكينة. اختار صورة قديمة للماكينة من هاتفك، وسناكي يحاول يتعرّف على المنتجات الظاهرة ومواقعها التقريبية. ما فيش أي تعديل على XY أو المخزون.")}
        </p>
      </header>
      <div className="space-y-4 p-4 sm:p-6">
        <label className="flex min-h-16 cursor-pointer items-center justify-center rounded-2xl border-2 border-dashed border-emerald-400 bg-emerald-50 px-4 py-4 text-center text-base font-bold text-emerald-900">
          {tr("＋ Choose photo from library", "＋ اختر صورة من ألبوم الصور")}
          <input ref={inputRef} type="file" accept="image/*"
            className="sr-only"
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null;
              event.target.value = "";
              void choosePhoto(selected);
            }} />
        </label>
        {preview ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt={tr("Photo chosen from your library", "الصورة المختارة من ألبوم الصور")}
              className="mx-auto max-h-[55vh] w-full rounded-lg object-contain" />
            <p className="mt-2 truncate text-center text-xs text-slate-500">{photo?.name}</p>
          </div>
        ) : null}
        <div className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">
          {tr("For this test, the image is sent to the AI provider for analysis only. It is not saved to Snacky storage. Rows and positions are estimates—not verified XY selection codes or quantities.",
            "في هالتجربة، الصورة تُرسل لخدمة الذكاء الاصطناعي للتحليل فقط ولا تُحفظ في تخزين سناكي. مواقع الصفوف تقريبية وليست أرقام خانات XY المؤكدة أو أعداد المخزون.")}
        </div>
        {configured === false ? (
          <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
            {tr("Live AI is not connected: OPENAI_API_KEY is missing from this Snacky OS environment. You can still select a photo and tap Analyze to see setup instructions. The guided camera and training route work independently.", 
              "تحليل الصور المباشر غير متصل: مفتاح OPENAI_API_KEY غير موجود في بيئة سناكي. تقدر تختار صورة وتضغط تحليل لمشاهدة تعليمات التفعيل. الكاميرا والجولة التدريبية يشتغلن بشكل مستقل.")}
          </p>
        ) : null}
        <button type="button" onClick={() => void recognize()} disabled={!photo || working}
          className="btn-primary min-h-14 w-full text-base disabled:opacity-50">
          {working ? tr("Analyzing photo…", "جارٍ تحليل الصورة…") : tr("Analyze photo with AI (test only)", "تحليل الصورة بالذكاء الاصطناعي (تجربة فقط)")}
        </button>
        {error ? <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm font-medium text-rose-900">{error}</div> : null}
        {result ? (
          <div role="status" className="space-y-3 rounded-2xl border border-emerald-200 p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-bold text-emerald-950">{tr("AI detection results", "نتائج التعرف على المنتجات")}</h3>
              <span className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-900">{observations.length}</span>
            </div>
            <p className="text-sm text-slate-600">{tr("Photo visibility", "وضوح الصورة")}: <strong>{quality === "good" ? tr("Good", "جيدة") : quality === "partial" ? tr("Partial", "جزئية") : tr("Unreadable", "غير واضحة")}</strong></p>
            {observations.length === 0 ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              {tr("No reliable product identification. Try a clearer machine photo with visible packaging.", "تعذر التعرف بثقة على المنتجات. جرّب صورة أوضح تظهر واجهات العبوات.")}
            </p> : (
              <div className="grid gap-2 sm:grid-cols-2">
                {observations.map((item) => (
                  <div key={`${item.rowNumber}:${item.positionNumber}`}
                    className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex justify-between gap-2">
                      <div className="text-xs font-bold text-slate-500">{tr(`Row ${item.rowNumber} · Position ${item.positionNumber}`, `الصف ${item.rowNumber} · الخانة ${item.positionNumber} تقريبياً`)}</div>
                      <span className={`rounded px-2 py-0.5 text-[10px] font-semibold ${item.confidence === "high" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>
                        {item.confidence}
                      </span>
                    </div>
                    <p className="mt-1 font-bold text-slate-900">{item.productName}</p>
                    <p className="mt-1 text-xs text-slate-600">{item.visualEvidence}</p>
                  </div>
                ))}
              </div>
            )}
            <p className="rounded-lg bg-slate-100 p-3 text-xs leading-5 text-slate-600">
              {tr("For accuracy testing only. Compare these results to the original photo. Nothing has been changed in any vending machine.",
                "هذه النتائج للاختبار فقط. قارنها بالصورة الأصلية. لم يتم تغيير أي شيء في الماكينات.")}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
