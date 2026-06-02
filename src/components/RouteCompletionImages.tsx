"use client";

import { useState } from "react";

export type RouteCompletionImage = {
  id: string;
  url: string | null;
  storagePath: string | null;
  uploadedAt: string | null;
  uploadedBy: string | null;
  label: string;
};

export type RouteCompletionStop = {
  id: string;
  title: string;
  subtitle: string;
  images: RouteCompletionImage[];
};

function formatDateTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-US");
}

function CompletionImageCard({ image, onOpen }: { image: RouteCompletionImage; onOpen: (image: RouteCompletionImage) => void }) {
  const [failed, setFailed] = useState(false);
  const uploadedAt = formatDateTime(image.uploadedAt);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      {image.url && !failed ? (
        <button type="button" onClick={() => onOpen(image)} className="block w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          <img src={image.url} alt={image.label} onError={() => setFailed(true)} className="h-48 w-full object-contain" />
        </button>
      ) : (
        <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-sm text-slate-600">
          Image uploaded but could not be displayed.
        </div>
      )}
      <div className="mt-3 space-y-1 text-xs text-slate-500">
        {uploadedAt ? <div>Uploaded {uploadedAt}</div> : null}
        {image.uploadedBy ? <div>By {image.uploadedBy}</div> : null}
        {image.storagePath ? <div className="break-all">{image.storagePath}</div> : null}
      </div>
    </div>
  );
}

export function RouteCompletionImages({ stops }: { stops: RouteCompletionStop[] }) {
  const [openImage, setOpenImage] = useState<RouteCompletionImage | null>(null);

  return (
    <>
      <div className="space-y-4">
        {stops.map((stop) => (
          <article key={stop.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3">
              <h3 className="break-words font-semibold text-slate-900">{stop.title}</h3>
              <p className="mt-1 break-words text-sm text-slate-500">{stop.subtitle}</p>
            </div>
            {stop.images.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {stop.images.map((image) => (
                  <CompletionImageCard key={image.id} image={image} onOpen={setOpenImage} />
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">No completion image yet.</p>
            )}
          </article>
        ))}
      </div>

      {openImage?.url ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" role="dialog" aria-modal="true">
          <div className="max-h-full w-full max-w-5xl overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0 truncate text-sm font-semibold text-slate-900">{openImage.label}</div>
              <button type="button" className="btn-secondary px-3 py-1 text-sm" onClick={() => setOpenImage(null)}>Close</button>
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
