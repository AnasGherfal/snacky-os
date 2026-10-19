"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/components/I18nProvider";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A durable request ID makes an uncertain HTTP response safe to retry, not double-claim. */
export function MachineIssueClaimButton({ taskId, userId }: { taskId: string; userId: string }) {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const router = useRouter();
  const key = `snacky:machine-issue-claim:v1:${userId}:${taskId}`;
  const locked = useRef(false);
  const idRef = useRef<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(key);
      if (stored && uuid.test(stored)) {
        idRef.current = stored;
        setPendingId(stored);
      }
    } catch { /* In-memory retry still retains the same ID during this visit. */ }
  }, [key]);

  async function claim() {
    if (busy || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const requestId = idRef.current ?? pendingId ?? crypto.randomUUID();
    idRef.current = requestId;
    setPendingId(requestId);
    try { sessionStorage.setItem(key, requestId); } catch { /* Preserve in ref. */ }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch("/api/operator/issues/claim", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ requestId, taskId }),
        cache: "no-store", signal: controller.signal,
      });
      const data = await response.json().catch(() => ({})) as {
        ok?: boolean; requestId?: string; taskId?: string; code?: string;
        retryable?: boolean; message?: string; href?: string;
      };
      if (response.ok && data.ok === true && data.requestId === requestId
        && data.taskId === taskId && data.href === `/follow-ups/${taskId}`) {
        try { sessionStorage.removeItem(key); } catch {}
        idRef.current = null; setPendingId(null);
        router.push(`/follow-ups/${taskId}`);
        router.refresh();
        return;
      }
      if (data.retryable === false || (data.code && data.code !== "uncertain")) {
        try { sessionStorage.removeItem(key); } catch {}
        idRef.current = null; setPendingId(null);
        router.refresh();
      }
      setError(data.code === "conflict"
        ? tr("Another operator claimed this issue. The queue will refresh.", "استلم مشغّل آخر هذا البلاغ. سيتم تحديث القائمة.")
        : data.message ?? tr("The result is uncertain. Retry the SAME saved request.", "النتيجة غير مؤكدة. أعد نفس الطلب المحفوظ."));
    } catch {
      setError(tr(
        "Connection interrupted. Retry the same claim; Snacky will not assign it twice.",
        "انقطع الاتصال. أعد نفس طلب الاستلام؛ لن يسند سناكي البلاغ مرتين.",
      ));
    } finally {
      window.clearTimeout(timeout);
      locked.current = false;
      setBusy(false);
    }
  }

  return <div className="space-y-2">
    <button type="button" className="btn-primary min-h-12 w-full sm:w-auto"
      disabled={busy} onClick={() => void claim()}>
      {busy ? tr("Claiming…", "جارٍ الاستلام…")
        : pendingId ? tr("Retry saved claim", "إعادة محاولة الاستلام")
          : tr("Claim this issue", "استلام هذا البلاغ")}
    </button>
    {error ? <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm font-medium text-amber-950">{error}</p> : null}
  </div>;
}
