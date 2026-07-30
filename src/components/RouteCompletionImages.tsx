"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/components/I18nProvider";

export type RouteCompletionImage = {
  id: string;
  url: string | null;
  storagePath: string | null;
  uploadedAt: string | null;
  uploadedBy: string | null;
  label: string;
  kind?: "completion" | "compressor";
};

export type RouteCompletionStop = {
  id: string;
  title: string;
  subtitle: string;
  images: RouteCompletionImage[];
};

type CompressorProof = {
  id: string;
  routeStopId: string;
  machineId: string;
  confirmed: boolean;
  url: string | null;
  storagePath: string | null;
  uploadedAt: string | null;
  uploadedBy: string | null;
};

function formatDateTime(value: string | null, locale: "ar" | "en") {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(locale === "ar" ? "ar-LY" : "en-US");
}

function CompletionImageCard({ image, onOpen, locale }: { image: RouteCompletionImage; onOpen: (image: RouteCompletionImage) => void; locale: "ar" | "en" }) {
  const [failed, setFailed] = useState(false);
  const uploadedAt = formatDateTime(image.uploadedAt, locale);
  const isCompressor = image.kind === "compressor";

  return (
    <div className={isCompressor ? "rounded-xl border-2 border-emerald-300 bg-emerald-50 p-3" : "rounded-xl border border-slate-200 bg-white p-3"}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-slate-900">{image.label}</div>
        {isCompressor ? <span className="rounded-full bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white">{locale === "ar" ? "تم التحقق" : "Verified"}</span> : null}
      </div>
      {image.url && !failed ? (
        <button type="button" onClick={() => onOpen(image)} className="block w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          <img src={image.url} alt={image.label} onError={() => setFailed(true)} className="h-48 w-full object-contain" />
        </button>
      ) : (
        <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-600">
          {locale === "ar" ? "تم رفع الصورة ولكن تعذر عرضها." : "Image uploaded but could not be displayed."}
        </div>
      )}
      <div className="mt-3 space-y-1 text-xs text-slate-500">
        {uploadedAt ? <div>{locale === "ar" ? "تم الرفع" : "Uploaded"} {uploadedAt}</div> : null}
        {image.uploadedBy ? <div>{locale === "ar" ? "بواسطة" : "By"} {image.uploadedBy}</div> : null}
      </div>
    </div>
  );
}

export function RouteCompletionImages({ stops }: { stops: RouteCompletionStop[] }) {
  const pathname = usePathname();
  const { locale } = useLanguage();
  const [openImage, setOpenImage] = useState<RouteCompletionImage | null>(null);
  const [compressorProofs, setCompressorProofs] = useState<CompressorProof[]>([]);
  const [proofError, setProofError] = useState("");
  const routeId = pathname.match(/^\/routes\/([^/]+)/)?.[1] ?? "";

  useEffect(() => {
    if (!routeId) return;
    let active = true;
    fetch(`/api/routes/${routeId}/compressor-proofs`, { cache: "no-store", headers: { Accept: "application/json" } })
      .then(async (response) => ({ response, payload: await response.json().catch(() => null) }))
      .then(({ response, payload }) => {
        if (!active) return;
        if (!response.ok || payload?.success === false) {
          setProofError(payload?.error || (locale === "ar" ? "تعذر تحميل صور الضاغط." : "Could not load compressor photos."));
          return;
        }
        setCompressorProofs(Array.isArray(payload?.proofs) ? payload.proofs : []);
        setProofError("");
      })
      .catch(() => active && setProofError(locale === "ar" ? "تعذر تحميل صور الضاغط." : "Could not load compressor photos."));
    return () => { active = false; };
  }, [routeId, locale]);

  const mergedStops = useMemo(() => stops.map((stop) => {
    const proofImages: RouteCompletionImage[] = compressorProofs
      .filter((proof) => proof.routeStopId === stop.id && proof.confirmed)
      .map((proof) => ({
        id: `compressor-${proof.id}`,
        url: proof.url,
        storagePath: proof.storagePath,
        uploadedAt: proof.uploadedAt,
        uploadedBy: proof.uploadedBy,
        label: locale === "ar" ? "إثبات تشغيل الضاغط" : "Compressor ON proof",
        kind: "compressor",
      }));
    return { ...stop, images: [...proofImages, ...stop.images] };
  }), [stops, compressorProofs, locale]);

  return (
    <>
      {proofError ? <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{proofError}</div> : null}
      <div className="space-y-4" dir={locale === "ar" ? "rtl" : "ltr"}>
        {mergedStops.map((stop) => (
          <article key={stop.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3">
              <h3 className="break-words font-semibold text-slate-900">{stop.title}</h3>
              <p className="mt-1 break-words text-sm text-slate-500">{stop.subtitle}</p>
            </div>
            {stop.images.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {stop.images.map((image) => (
                  <CompletionImageCard key={image.id} image={image} onOpen={setOpenImage} locale={locale} />
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">{locale === "ar" ? "لا توجد صورة إكمال أو إثبات ضاغط بعد." : "No completion or compressor proof image yet."}</p>
            )}
          </article>
        ))}
      </div>

      {openImage?.url ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" role="dialog" aria-modal="true">
          <div className="max-h-full w-full max-w-5xl overflow-hidden rounded-lg bg-white shadow-2xl" dir={locale === "ar" ? "rtl" : "ltr"}>
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0 truncate text-sm font-semibold text-slate-900">{openImage.label}</div>
              <button type="button" className="btn-secondary px-3 py-1 text-sm" onClick={() => setOpenImage(null)}>{locale === "ar" ? "إغلاق" : "Close"}</button>
            </div>
            <div className="max-h-[82vh] overflow-auto bg-slate-100 p-3">
              <img src={openImage.url} alt={openImage.label} className="mx-auto max-w-full rounded-lg bg-white object-contain" />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
