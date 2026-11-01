"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { prepareCashPhoto } from "@/lib/cash-photo";

type CashStatus = "pending" | "collected" | "exception" | null;
type Payload = {
  ok: boolean; required?: boolean; completed?: boolean; status?: CashStatus;
  bagId?: string | null; collectionId?: string | null;
  requestId?: string | null; error?: string;
};

export function RouteStopCashCard({
  routeId, stopId, machineId, onReadyChange,
}: {
  routeId: string; stopId: string; machineId: string;
  onReadyChange: (required: boolean, ready: boolean, state: CashStatus) => void;
}) {
  const endpoint = `/api/operator/routes/${routeId}/stops/${stopId}/cash`;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [required, setRequired] = useState(false);
  const [status, setStatus] = useState<CashStatus>(null);
  const [bagId, setBagId] = useState("");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [decision, setDecision] = useState<"collected" | "exception">("collected");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [coinBox, setCoinBox] = useState(false);
  const [recycler, setRecycler] = useState(false);
  const [partial, setPartial] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState("");
  const requestRef = useRef<string | null>(null);
  const onReadyRef = useRef(onReadyChange);
  useEffect(() => { onReadyRef.current = onReadyChange; }, [onReadyChange]);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    fetch(endpoint, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as Payload;
        if (!response.ok || !data.ok) throw new Error(data.error || "تعذر تحميل حالة النقدية");
        if (canceled) return;
        setRequired(Boolean(data.required));
        setStatus(data.status ?? null);
        setBagId(data.bagId ?? "");
        setCollectionId(data.collectionId ?? null);
        if (data.requestId) requestRef.current = data.requestId;
        onReadyRef.current(Boolean(data.required), ["collected","exception"].includes(String(data.status)), data.status ?? null);
      })
      .catch(() => { if (!canceled) setError("تعذر تحميل النقدية. يرجى تحديث الصفحة."); })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [endpoint]);

  if (loading) return <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm" dir="rtl">جارٍ التحقق من خطوة النقدية...</p>;
  if (!required) return null;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      if (!requestRef.current) requestRef.current = crypto.randomUUID();
      const form = new FormData();
      form.set("request_id", requestRef.current);
      form.set("decision", decision);
      if (decision === "collected") {
        if (!bagId.trim() || !photo) throw Error("أدخل رقم الكيس وصوّر الختم.");
        form.set("bag_id", bagId.trim().toUpperCase());
        form.set("photo", await prepareCashPhoto(photo));
        form.set("removal_type", partial ? "partial" : "full");
        form.append("compartments", "notes");
        if (coinBox) form.append("compartments", "coins");
        if (recycler) form.append("compartments", "recycler");
        form.set("notes", notes);
      } else {
        form.set("reason", reason);
        form.set("notes", notes);
      }
      const response = await fetch(endpoint, { method: "POST", body: form, cache: "no-store" });
      const result = await response.json() as Payload & { state?: CashStatus; retryable?: boolean };
      if (!response.ok || !result.ok) throw Error(result.error ?? "تعذر حفظ النقدية. حاول مرة أخرى.");
      const next = result.state ?? null;
      setStatus(next);
      setCollectionId(result.collectionId ?? null);
      onReadyRef.current(true, ["collected","exception"].includes(String(next)), next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر حفظ النقدية.");
    } finally { setSaving(false); }
  }
