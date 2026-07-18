"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";
import { uploadRefillProofPhoto } from "@/lib/operator-actions";

export function CompressorSafetyProofCard({
  routeId,
  stopId,
  machineId,
  completed,
  onStateChange,
}: {
  routeId: string;
  stopId: string;
  machineId: string;
  completed?: boolean;
  onStateChange?: (state: { installed: boolean; ready: boolean }) => void;
}) {
  const { t } = useLanguage();
  const [installed, setInstalled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [ready, setReady] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch(`/api/operator/routes/${routeId}/stops/${stopId}/safety-check`, { cache: "no-store", headers: { Accept: "application/json" } })
      .then(async (response) => ({ response, payload: await response.json().catch(() => null) }))
      .then(({ response, payload }) => {
        if (!active) return;
        const nextInstalled = payload?.installed !== false;
        const nextReady = Boolean(response.ok && payload?.confirmed);
        setInstalled(nextInstalled);
        setReady(nextReady);
        setConfirmed(nextReady);
        setSavedAt(payload?.proof?.confirmed_at ?? null);
        onStateChange?.({ installed: nextInstalled, ready: nextReady });
      })
      .catch(() => {
        if (!active) return;
        setInstalled(false);
        onStateChange?.({ installed: false, ready: false });
      })
      .finally(() => active && setLoaded(true));
    return () => { active = false; };
  }, [onStateChange, routeId, stopId]);

  async function saveProof() {
    if (!confirmed) {
      setError("Confirm that the compressor is switched on.");
      return;
    }
    if (!file) {
      setError("Take a photo showing the compressor switch or running indicator on.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("The compressor photo is too large. Retake it with the camera and try again.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const photoFormData = new FormData();
      photoFormData.append("routeId", routeId);
      photoFormData.append("stopId", stopId);
      photoFormData.append("machineId", machineId);
      photoFormData.append("photo", file);
      const uploaded = await uploadRefillProofPhoto(photoFormData);
      if (uploaded.uploadUnavailable || (!uploaded.photoUrl && !uploaded.photoPath)) throw new Error("The photo could not be uploaded. Try again before completing the stop.");

      const response = await fetch(`/api/operator/routes/${routeId}/stops/${stopId}/safety-check`, {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          compressorConfirmed: true,
          proofPhotoUrl: uploaded.photoUrl ?? null,
          proofPhotoPath: uploaded.photoPath ?? null,
          proofPhotoOriginalName: uploaded.originalName ?? file.name,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success === false) throw new Error(payload?.error || "Could not save compressor proof.");
      setInstalled(true);
      setReady(true);
      setSavedAt(payload?.proof?.confirmed_at ?? new Date().toISOString());
      setFile(null);
      onStateChange?.({ installed: true, ready: true });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save compressor proof.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section id="compressor-safety" className={ready ? "rounded-xl border-2 border-emerald-300 bg-emerald-50 p-4 md:p-6" : "rounded-xl border-2 border-amber-300 bg-amber-50 p-4 md:p-6"}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">{t("Required final safety check")}</div>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">{t("Compressor switched ON")}</h2>
          <p className="mt-1 text-sm leading-6 text-slate-700">{t("After filling, switch the compressor back on and take a close photo showing the ON switch or running indicator.")}</p>
        </div>
        <span className={ready ? "rounded-full bg-emerald-600 px-3 py-1 text-sm font-semibold text-white" : "rounded-full bg-amber-500 px-3 py-1 text-sm font-semibold text-white"}>{ready ? t("Proof saved") : t("Required")}</span>
      </div>

      {!loaded ? <p className="mt-4 text-sm text-slate-600">{t("Checking saved proof...")}</p> : null}
      {loaded && !installed ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-white p-3 text-sm text-amber-900">
          {t("Compressor proof setup is not installed yet. The existing route remains usable until the safety migration is applied.")}
        </div>
      ) : null}
      {ready ? (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-white p-3 text-sm font-medium text-emerald-900">
          {t("Compressor ON proof is saved")}{savedAt ? ` · ${new Date(savedAt).toLocaleString("en-US")}` : ""}.
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-amber-200 bg-white p-3">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" />
            <span className="text-sm font-medium text-slate-900">{t("I switched the compressor ON and verified the machine is running.")}</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-900">{t("Photo of ON switch / running indicator")}</span>
            <input type="file" accept="image/*" capture="environment" className="field-input bg-white" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            {file ? <span className="mt-1 block text-xs text-slate-600">{file.name}</span> : null}
          </label>
          {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{error}</div> : null}
          <button type="button" onClick={() => void saveProof()} disabled={saving || completed} className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-50">
            {saving ? `${t("Saving")}...` : t("Save compressor proof")}
          </button>
        </div>
      )}
    </section>
  );
}
