"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Clock3,
  Loader2,
  MapPin,
  MessageSquareText,
  Package,
  Plus,
  Tag,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";

type Row = Record<string, any>;

type Snapshot = {
  success: true;
  manager: boolean;
  operatorId: string;
  currentOperatorId: string | null;
  operators: Row[];
  products: Row[];
  machines: Row[];
  routes: Row[];
  instructions: Row[];
};

type Props = {
  initialOperatorId?: string;
  lockOperator?: boolean;
  className?: string;
};

type InstructionType = "task" | "price_change" | "note";
type ListTab = "active" | "history";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return `${Number.isFinite(parsed) ? parsed.toFixed(2) : "0.00"} LYD`;
}

function dateInputValue(date = new Date()) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function formatDate(locale: string, value: unknown) {
  const text = clean(value);
  if (!text) return "-";
  try {
    return new Intl.DateTimeFormat(locale === "ar" ? "ar-LY" : "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(text));
  } catch {
    return text;
  }
}

function productPrice(product: Row | null | undefined) {
  return Number(product?.current_selling_price_lyd ?? product?.selling_price ?? 0);
}

function instructionTypeIcon(type: string) {
  if (type === "price_change") return Tag;
  if (type === "note") return MessageSquareText;
  return ClipboardList;
}

function priorityClass(priority: string) {
  if (priority === "urgent") return "border-rose-200 bg-rose-50 text-rose-800";
  if (priority === "high") return "border-amber-200 bg-amber-50 text-amber-800";
  if (priority === "low") return "border-slate-200 bg-slate-50 text-slate-600";
  return "border-sky-200 bg-sky-50 text-sky-800";
}

function statusClass(status: string) {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "cancelled") return "border-slate-200 bg-slate-100 text-slate-500";
  if (status === "acknowledged") return "border-sky-200 bg-sky-50 text-sky-800";
  return "border-amber-200 bg-amber-50 text-amber-800";
}

export default function OperatorInstructionsPanel({
  initialOperatorId = "",
  lockOperator = false,
  className = "",
}: Props) {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const t = (english: string, arabic: string) => (ar ? arabic : english);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [operatorId, setOperatorId] = useState(initialOperatorId);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [setupRequired, setSetupRequired] = useState(false);
  const [migration, setMigration] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [listTab, setListTab] = useState<ListTab>("active");
  const [saving, setSaving] = useState("");

  const [instructionType, setInstructionType] = useState<InstructionType>("task");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [priority, setPriority] = useState("normal");
  const [dueAt, setDueAt] = useState("");
  const [machineId, setMachineId] = useState("");
  const [routeId, setRouteId] = useState("");
  const [productId, setProductId] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [completionOpenId, setCompletionOpenId] = useState("");
  const [completionNotes, setCompletionNotes] = useState<Record<string, string>>({});

  const load = useCallback(async (requestedOperatorId?: string, quiet = false) => {
    if (!quiet) setLoading(true);
    setSetupRequired(false);
    try {
      const target = clean(requestedOperatorId || operatorId || initialOperatorId);
      const query = new URLSearchParams({ includeOptions: "1" });
      if (target) query.set("operatorId", target);
      const response = await fetch(`/api/operator-instructions?${query.toString()}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null) as (Snapshot & {
        error?: string;
        setupRequired?: boolean;
        migration?: string;
        details?: string;
      }) | null;

      if (!response.ok || !payload?.success) {
        setSnapshot(null);
        setSetupRequired(Boolean(payload?.setupRequired));
        setMigration(clean(payload?.migration));
        setMessage(payload?.error || t("Could not load operator instructions.", "تعذر تحميل تعليمات المشغّل."));
        return;
      }

      setSnapshot(payload);
      setOperatorId(payload.operatorId);
      setMessage("");
    } catch (error) {
      setSnapshot(null);
      setMessage(error instanceof Error ? error.message : t("Could not load operator instructions.", "تعذر تحميل تعليمات المشغّل."));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [initialOperatorId, operatorId, locale]);

  useEffect(() => {
    void load(initialOperatorId);
    // The selected operator is intentionally reset only when the locked profile changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOperatorId]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!document.hidden) void load(operatorId, true);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [load, operatorId]);

  const products = snapshot?.products ?? [];
  const selectedProduct = products.find((row) => clean(row.id) === productId) ?? null;
  const filteredProducts = useMemo(() => {
    const query = productSearch.trim().toLowerCase();
    return products
      .filter((row) => {
        if (!query) return true;
        return `${row.name ?? ""} ${row.brand ?? ""} ${row.category ?? ""}`.toLowerCase().includes(query);
      })
      .slice(0, 12);
  }, [products, productSearch]);

  const instructions = snapshot?.instructions ?? [];
  const activeInstructions = instructions.filter((row) => ["pending", "acknowledged"].includes(clean(row.status)));
  const historyInstructions = instructions.filter((row) => ["completed", "cancelled"].includes(clean(row.status)));
  const visibleInstructions = listTab === "active" ? activeInstructions : historyInstructions;
  const urgentCount = activeInstructions.filter((row) => clean(row.priority) === "urgent").length;

  const resetComposer = () => {
    setInstructionType("task");
    setTitle("");
    setDetails("");
    setPriority("normal");
    setDueAt("");
    setMachineId("");
    setRouteId("");
    setProductId("");
    setProductSearch("");
    setNewPrice("");
  };

  const createInstruction = async () => {
    if (!snapshot?.manager || !operatorId) return;
    const resolvedTitle = instructionType === "price_change" && selectedProduct
      ? t(
          `Change ${selectedProduct.name} selling price to ${Number(newPrice || 0).toFixed(2)} LYD`,
          `تغيير سعر بيع ${selectedProduct.name} إلى ${Number(newPrice || 0).toFixed(2)} د.ل`,
        )
      : title.trim();

    if (instructionType === "task" && !resolvedTitle) {
      setMessage(t("Task title is required.", "عنوان المهمة مطلوب."));
      return;
    }
    if (instructionType === "note" && !resolvedTitle && !details.trim()) {
      setMessage(t("Write the note first.", "اكتب الملاحظة أولاً."));
      return;
    }
    if (instructionType === "price_change" && (!selectedProduct || Number(newPrice) <= 0)) {
      setMessage(t("Select a product and enter a valid new price.", "اختر المنتج وأدخل سعراً جديداً صحيحاً."));
      return;
    }

    setSaving("create");
    setMessage("");
    try {
      const response = await fetch("/api/operator-instructions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          operatorId,
          instructionType,
          title: resolvedTitle,
          details,
          priority,
          dueAt: dueAt || null,
          machineId: machineId || null,
          routeId: routeId || null,
          productId: instructionType === "price_change" ? productId : null,
          requestedSellingPriceLyd: instructionType === "price_change" ? Number(newPrice) : null,
          clientSubmissionId: `operator-instruction:${crypto.randomUUID()}`,
        }),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string; setupRequired?: boolean; migration?: string } | null;
      if (!response.ok || !payload?.success) {
        setSetupRequired(Boolean(payload?.setupRequired));
        setMigration(clean(payload?.migration));
        setMessage(payload?.error || t("Could not assign the instruction.", "تعذر إرسال التعليمات."));
        return;
      }

      setMessage(
        instructionType === "price_change"
          ? t("Price updated and the operator was instructed.", "تم تحديث السعر وإرسال التعليمات للمشغّل.")
          : t("Instruction sent to the operator.", "تم إرسال التعليمات للمشغّل."),
      );
      resetComposer();
      setComposerOpen(false);
      setListTab("active");
      await load(operatorId, true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Could not assign the instruction.", "تعذر إرسال التعليمات."));
    } finally {
      setSaving("");
    }
  };

  const advance = async (instructionId: string, action: "acknowledge" | "complete" | "cancel") => {
    setSaving(`${action}:${instructionId}`);
    setMessage("");
    try {
      const response = await fetch("/api/operator-instructions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          instructionId,
          note: completionNotes[instructionId] || null,
        }),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!response.ok || !payload?.success) {
        setMessage(payload?.error || t("Could not update the instruction.", "تعذر تحديث التعليمات."));
        return;
      }
      setCompletionOpenId("");
      setCompletionNotes((current) => ({ ...current, [instructionId]: "" }));
      setMessage(
        action === "complete"
          ? t("Instruction marked completed.", "تم تسجيل تنفيذ التعليمات.")
          : action === "acknowledge"
            ? t("Instruction acknowledged.", "تم تأكيد الاطلاع على التعليمات.")
            : t("Instruction cancelled.", "تم إلغاء التعليمات."),
      );
      await load(operatorId, true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Could not update the instruction.", "تعذر تحديث التعليمات."));
    } finally {
      setSaving("");
    }
  };

  if (loading && !snapshot) {
    return (
      <section id="operator-instructions" dir={ar ? "rtl" : "ltr"} className={`surface-card p-5 ${className}`}>
        <div className="flex items-center gap-3 text-sm text-slate-600">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t("Loading operator instructions…", "جارٍ تحميل تعليمات المشغّل…")}
        </div>
      </section>
    );
  }

  if (!snapshot) {
    return (
      <section id="operator-instructions" dir={ar ? "rtl" : "ltr"} className={`rounded-2xl border border-amber-200 bg-amber-50 p-5 ${className}`}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <div>
            <h2 className="font-semibold text-amber-950">
              {setupRequired
                ? t("Operator instructions need database setup", "يلزم تفعيل تعليمات المشغّلين في قاعدة البيانات")
                : t("Operator instructions are unavailable", "تعليمات المشغّلين غير متاحة")}
            </h2>
            <p className="mt-1 text-sm leading-6 text-amber-900">{message}</p>
            {setupRequired && migration ? (
              <code className="mt-2 block rounded-lg bg-white/70 px-3 py-2 text-xs text-amber-900">{migration}</code>
            ) : null}
            <button type="button" onClick={() => void load(operatorId)} className="mt-3 text-sm font-semibold text-amber-950 underline underline-offset-4">
              {t("Retry", "إعادة المحاولة")}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section id="operator-instructions" dir={ar ? "rtl" : "ltr"} className={`space-y-4 ${className}`}>
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-950 p-5 text-white">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <ClipboardList className="h-5 w-5" />
                <h2 className="text-xl font-bold">{t("Instructions & tasks", "التعليمات والمهام")}</h2>
              </div>
              <p className="mt-1 text-sm leading-6 text-slate-300">
                {snapshot.manager
                  ? t("Send work, price changes, or notes directly inside Snacky OS.", "أرسل المهام وتغييرات الأسعار والملاحظات مباشرة داخل سناكي.")
                  : t("Everything admin needs you to see or complete appears here.", "كل ما تريد الإدارة أن تطّلع عليه أو تنفّذه يظهر هنا.")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold">
                {activeInstructions.length} {t("active", "نشطة")}
              </span>
              {urgentCount ? (
                <span className="rounded-full bg-rose-500/20 px-3 py-1 text-xs font-semibold text-rose-100">
                  {urgentCount} {t("urgent", "عاجلة")}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {snapshot.manager ? (
          <div className="border-b border-slate-200 p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              {!lockOperator ? (
                <label className="block min-w-0 flex-1">
                  <span className="text-sm font-semibold text-slate-800">{t("Operator", "المشغّل")}</span>
                  <select
                    value={operatorId}
                    onChange={(event) => {
                      const next = event.target.value;
                      setOperatorId(next);
                      setComposerOpen(false);
                      void load(next);
                    }}
                    className="field-input mt-2"
                  >
                    {snapshot.operators.map((row) => (
                      <option key={row.id} value={row.id}>{row.full_name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("Assigned to", "موجّهة إلى")}</div>
                  <div className="mt-1 font-semibold text-slate-900">
                    {snapshot.operators.find((row) => clean(row.id) === operatorId)?.full_name || t("Operator", "المشغّل")}
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => setComposerOpen((current) => !current)}
                className="btn-primary inline-flex items-center justify-center gap-2"
              >
                {composerOpen ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                {composerOpen ? t("Close", "إغلاق") : t("New instruction", "تعليمات جديدة")}
              </button>
            </div>

            {composerOpen ? (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5">
                <div className="grid gap-2 sm:grid-cols-3">
                  {([
                    ["task", ClipboardList, t("Task", "مهمة"), t("Something the operator must complete", "عمل مطلوب من المشغّل تنفيذه")],
                    ["price_change", Tag, t("Price change", "تغيير سعر"), t("Update the catalog price and notify the operator", "تحديث السعر وإبلاغ المشغّل")],
                    ["note", MessageSquareText, t("Note", "ملاحظة"), t("Information that only needs acknowledgement", "معلومة تحتاج تأكيد الاطلاع فقط")],
                  ] as const).map(([type, Icon, label, hint]) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => {
                        setInstructionType(type);
                        setTitle("");
                        setProductId("");
                        setProductSearch("");
                        setNewPrice("");
                      }}
                      className={`rounded-xl border p-3 text-start transition ${instructionType === type ? "border-slate-900 bg-white shadow-sm" : "border-slate-200 bg-white/60 hover:bg-white"}`}
                    >
                      <div className="flex items-center gap-2 font-semibold text-slate-900"><Icon className="h-4 w-4" />{label}</div>
                      <p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p>
                    </button>
                  ))}
                </div>

                {instructionType === "price_change" ? (
                  <div className="mt-5 space-y-4">
                    <div>
                      <label className="text-sm font-semibold text-slate-800">{t("Product", "المنتج")}</label>
                      {!selectedProduct ? (
                        <>
                          <input
                            value={productSearch}
                            onChange={(event) => setProductSearch(event.target.value)}
                            className="field-input mt-2"
                            placeholder={t("Search by product, brand, or category…", "ابحث باسم المنتج أو العلامة أو التصنيف…")}
                          />
                          <div className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white">
                            {filteredProducts.length ? filteredProducts.map((product) => (
                              <button
                                key={product.id}
                                type="button"
                                onPointerDown={(event) => {
                                  event.preventDefault();
                                  setProductId(clean(product.id));
                                  setProductSearch("");
                                  setNewPrice("");
                                }}
                                className="flex w-full items-center justify-between gap-3 border-b border-slate-100 p-3 text-start last:border-0 hover:bg-slate-50"
                              >
                                <div className="min-w-0">
                                  <div className="truncate font-semibold text-slate-900">{product.name}</div>
                                  <div className="truncate text-xs text-slate-500">{[product.brand, product.category].filter(Boolean).join(" · ")}</div>
                                </div>
                                <div className="shrink-0 text-sm font-bold text-slate-900">{money(productPrice(product))}</div>
                              </button>
                            )) : (
                              <div className="p-4 text-sm text-slate-500">{t("No matching products.", "لا توجد منتجات مطابقة.")}</div>
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="mt-2 rounded-xl border border-slate-200 bg-white p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-semibold text-slate-900">{selectedProduct.name}</div>
                              <div className="mt-1 text-xs text-slate-500">{[selectedProduct.brand, selectedProduct.category].filter(Boolean).join(" · ")}</div>
                            </div>
                            <button type="button" onClick={() => setProductId("")} className="text-xs font-semibold text-slate-600 underline underline-offset-4">
                              {t("Change", "تغيير")}
                            </button>
                          </div>
                          <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            <div className="rounded-lg bg-slate-50 p-3">
                              <div className="text-xs text-slate-500">{t("Current selling price", "سعر البيع الحالي")}</div>
                              <div className="mt-1 text-lg font-bold">{money(productPrice(selectedProduct))}</div>
                            </div>
                            <label className="block">
                              <span className="text-xs font-semibold text-slate-700">{t("New selling price", "سعر البيع الجديد")}</span>
                              <input
                                value={newPrice}
                                onChange={(event) => setNewPrice(event.target.value)}
                                type="number"
                                min="0.01"
                                step="0.01"
                                className="field-input mt-1"
                                placeholder="0.00"
                              />
                            </label>
                          </div>
                          {Number(newPrice) > 0 ? (
                            <div className="mt-3 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                              <span>{t("Price change", "تغيير السعر")}</span>
                              <strong>{money(productPrice(selectedProduct))} → {money(newPrice)}</strong>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="mt-5 grid gap-4">
                    <label className="block">
                      <span className="text-sm font-semibold text-slate-800">
                        {instructionType === "note" ? t("Note title", "عنوان الملاحظة") : t("Task title", "عنوان المهمة")}
                      </span>
                      <input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        className="field-input mt-2"
                        placeholder={instructionType === "note" ? t("Example: Check the bottom tray", "مثال: راجع الرف السفلي") : t("What should the operator do?", "ماذا تريد من المشغّل أن يفعل؟")}
                      />
                    </label>
                  </div>
                )}

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="block sm:col-span-2">
                    <span className="text-sm font-semibold text-slate-800">
                      {instructionType === "price_change" ? t("Instructions for the operator", "تعليمات للمشغّل") : t("Details", "التفاصيل")}
                    </span>
                    <textarea
                      value={details}
                      onChange={(event) => setDetails(event.target.value)}
                      rows={3}
                      className="field-input mt-2"
                      placeholder={t("Add anything the operator needs to know…", "أضف أي تفاصيل يحتاج المشغّل لمعرفتها…")}
                    />
                  </label>

                  <label className="block">
                    <span className="text-sm font-semibold text-slate-800">{t("Machine (optional)", "الماكينة (اختياري)")}</span>
                    <select value={machineId} onChange={(event) => setMachineId(event.target.value)} className="field-input mt-2">
                      <option value="">{t("All / no specific machine", "الكل / بدون ماكينة محددة")}</option>
                      {snapshot.machines.map((machine) => (
                        <option key={machine.id} value={machine.id}>{machine.name || machine.machine_code || machine.id}</option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="text-sm font-semibold text-slate-800">{t("Route (optional)", "المسار (اختياري)")}</span>
                    <select value={routeId} onChange={(event) => setRouteId(event.target.value)} className="field-input mt-2">
                      <option value="">{t("No specific route", "بدون مسار محدد")}</option>
                      {snapshot.routes.map((route) => (
                        <option key={route.id} value={route.id}>{route.route_date} · {route.status}</option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="text-sm font-semibold text-slate-800">{t("Priority", "الأولوية")}</span>
                    <select value={priority} onChange={(event) => setPriority(event.target.value)} className="field-input mt-2">
                      <option value="low">{t("Low", "منخفضة")}</option>
                      <option value="normal">{t("Normal", "عادية")}</option>
                      <option value="high">{t("High", "مهمة")}</option>
                      <option value="urgent">{t("Urgent", "عاجلة")}</option>
                    </select>
                  </label>

                  {instructionType !== "note" ? (
                    <label className="block">
                      <span className="text-sm font-semibold text-slate-800">{t("Due date (optional)", "موعد التنفيذ (اختياري)")}</span>
                      <input
                        value={dueAt}
                        onChange={(event) => setDueAt(event.target.value)}
                        type="datetime-local"
                        min={dateInputValue()}
                        className="field-input mt-2"
                      />
                    </label>
                  ) : null}
                </div>

                {instructionType === "price_change" ? (
                  <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm leading-6 text-sky-900">
                    {t(
                      "Confirming this updates the product's selling price in Snacky OS immediately and creates a separate task for the operator to apply it physically.",
                      "عند التأكيد سيتم تحديث سعر بيع المنتج في سناكي فوراً، وإنشاء مهمة منفصلة للمشغّل لتطبيق السعر فعلياً.",
                    )}
                  </div>
                ) : null}

                <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <button type="button" onClick={() => { resetComposer(); setComposerOpen(false); }} className="btn-secondary">
                    {t("Cancel", "إلغاء")}
                  </button>
                  <button type="button" onClick={() => void createInstruction()} disabled={saving === "create"} className="btn-primary inline-flex items-center justify-center gap-2 disabled:opacity-60">
                    {saving === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    {instructionType === "price_change" ? t("Update price & send", "تحديث السعر والإرسال") : t("Send instruction", "إرسال التعليمات")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="p-4 sm:p-5">
          {message ? (
            <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{message}</div>
          ) : null}

          <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setListTab("active")}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${listTab === "active" ? "bg-white text-slate-950 shadow-sm" : "text-slate-600"}`}
            >
              {t("Active", "النشطة")} ({activeInstructions.length})
            </button>
            <button
              type="button"
              onClick={() => setListTab("history")}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${listTab === "history" ? "bg-white text-slate-950 shadow-sm" : "text-slate-600"}`}
            >
              {t("History", "السجل")} ({historyInstructions.length})
            </button>
          </div>

          {!visibleInstructions.length ? (
            <div className="py-10 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-slate-300" />
              <div className="mt-3 font-semibold text-slate-900">
                {listTab === "active" ? t("No active instructions", "لا توجد تعليمات نشطة") : t("No instruction history yet", "لا يوجد سجل تعليمات بعد")}
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {listTab === "active" ? t("New tasks and notes will appear here.", "ستظهر المهام والملاحظات الجديدة هنا.") : t("Completed and cancelled instructions stay here.", "تبقى التعليمات المنفذة والملغاة هنا.")}
              </p>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {visibleInstructions.map((instruction) => {
                const type = clean(instruction.instruction_type);
                const status = clean(instruction.status);
                const Icon = instructionTypeIcon(type);
                const dueDate = instruction.due_at ? new Date(String(instruction.due_at)) : null;
                const overdue = Boolean(dueDate && dueDate.getTime() < Date.now() && !["completed", "cancelled"].includes(status));
                const isSaving = saving.endsWith(`:${instruction.id}`);
                const typeLabel = type === "price_change"
                  ? t("Price change", "تغيير سعر")
                  : type === "note"
                    ? t("Note", "ملاحظة")
                    : t("Task", "مهمة");
                const statusLabel = status === "completed"
                  ? t("Completed", "تم التنفيذ")
                  : status === "cancelled"
                    ? t("Cancelled", "ملغاة")
                    : status === "acknowledged"
                      ? t("Seen", "تم الاطلاع")
                      : t("New", "جديدة");
                const priorityLabel = instruction.priority === "urgent"
                  ? t("Urgent", "عاجلة")
                  : instruction.priority === "high"
                    ? t("High", "مهمة")
                    : instruction.priority === "low"
                      ? t("Low", "منخفضة")
                      : t("Normal", "عادية");

                return (
                  <article key={instruction.id} className={`rounded-2xl border p-4 ${overdue ? "border-rose-200 bg-rose-50/50" : "border-slate-200 bg-white"}`}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="rounded-xl bg-slate-100 p-2.5 text-slate-700"><Icon className="h-5 w-5" /></div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{typeLabel}</span>
                            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${priorityClass(clean(instruction.priority))}`}>{priorityLabel}</span>
                            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusClass(status)}`}>{statusLabel}</span>
                            {overdue ? <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[11px] font-semibold text-white">{t("Overdue", "متأخرة")}</span> : null}
                          </div>
                          <h3 className="mt-2 text-base font-bold text-slate-950">{instruction.title}</h3>
                          {instruction.details ? <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">{instruction.details}</p> : null}
                        </div>
                      </div>
                    </div>

                    {type === "price_change" ? (
                      <div className="mt-4 grid gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
                        <div className="flex items-center gap-2">
                          <Package className="h-4 w-4 text-amber-800" />
                          <div>
                            <div className="font-semibold text-amber-950">{instruction.product?.name || t("Product", "المنتج")}</div>
                            {instruction.product?.brand ? <div className="text-xs text-amber-800">{instruction.product.brand}</div> : null}
                          </div>
                        </div>
                        <div className="text-start sm:text-end">
                          <div className="text-xs text-amber-800">{t("Selling price", "سعر البيع")}</div>
                          <div className="mt-1 text-lg font-bold text-amber-950">
                            {money(instruction.previous_selling_price_lyd)} → {money(instruction.requested_selling_price_lyd)}
                          </div>
                        </div>
                      </div>
                    ) : null}

                    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-500">
                      {instruction.machine ? (
                        <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" />{instruction.machine.name || instruction.machine.machine_code}</span>
                      ) : null}
                      {instruction.route ? (
                        <a href={`/operator/routes/${instruction.route.id}`} className="inline-flex items-center gap-1.5 font-semibold text-slate-700 underline underline-offset-4">
                          <ClipboardList className="h-3.5 w-3.5" />{t("Route", "المسار")} {instruction.route.route_date}
                        </a>
                      ) : null}
                      {instruction.due_at ? (
                        <span className={`inline-flex items-center gap-1.5 ${overdue ? "font-semibold text-rose-700" : ""}`}><Clock3 className="h-3.5 w-3.5" />{t("Due", "الموعد")}: {formatDate(locale, instruction.due_at)}</span>
                      ) : null}
                      <span>{t("Sent", "أُرسلت")}: {formatDate(locale, instruction.created_at)}</span>
                      {instruction.createdByName ? <span>{t("By", "بواسطة")}: {instruction.createdByName}</span> : null}
                    </div>

                    {instruction.completion_note ? (
                      <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                        <div className="font-semibold">{t("Completion note", "ملاحظة التنفيذ")}</div>
                        <div className="mt-1 whitespace-pre-wrap">{instruction.completion_note}</div>
                      </div>
                    ) : null}
                    {instruction.cancellation_note ? (
                      <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                        <div className="font-semibold">{t("Cancellation note", "سبب الإلغاء")}</div>
                        <div className="mt-1 whitespace-pre-wrap">{instruction.cancellation_note}</div>
                      </div>
                    ) : null}

                    {!["completed", "cancelled"].includes(status) ? (
                      <div className="mt-4 border-t border-slate-100 pt-4">
                        {!snapshot.manager ? (
                          <div className="space-y-3">
                            <div className="flex flex-wrap gap-2">
                              {status === "pending" ? (
                                <button
                                  type="button"
                                  disabled={isSaving}
                                  onClick={() => void advance(instruction.id, "acknowledge")}
                                  className="btn-secondary inline-flex items-center gap-2 disabled:opacity-60"
                                >
                                  {saving === `acknowledge:${instruction.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                                  {type === "note" ? t("Understood", "تم الاطلاع") : t("I have seen this", "اطلعت عليها")}
                                </button>
                              ) : null}
                              {instruction.requires_completion ? (
                                <button
                                  type="button"
                                  disabled={isSaving}
                                  onClick={() => setCompletionOpenId((current) => current === instruction.id ? "" : instruction.id)}
                                  className="btn-primary inline-flex items-center gap-2 disabled:opacity-60"
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                  {t("Mark completed", "تأكيد التنفيذ")}
                                  <ChevronDown className={`h-4 w-4 transition ${completionOpenId === instruction.id ? "rotate-180" : ""}`} />
                                </button>
                              ) : null}
                            </div>
                            {completionOpenId === instruction.id ? (
                              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                <label className="text-sm font-semibold text-slate-800">{t("What was done? (optional)", "ماذا تم تنفيذه؟ (اختياري)")}</label>
                                <textarea
                                  value={completionNotes[instruction.id] || ""}
                                  onChange={(event) => setCompletionNotes((current) => ({ ...current, [instruction.id]: event.target.value }))}
                                  rows={2}
                                  className="field-input mt-2"
                                  placeholder={t("Add a short completion note…", "أضف ملاحظة قصيرة عن التنفيذ…")}
                                />
                                <button
                                  type="button"
                                  disabled={saving === `complete:${instruction.id}`}
                                  onClick={() => void advance(instruction.id, "complete")}
                                  className="btn-primary mt-3 inline-flex w-full items-center justify-center gap-2 disabled:opacity-60"
                                >
                                  {saving === `complete:${instruction.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                                  {t("Confirm completion", "تأكيد التنفيذ")}
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={saving === `cancel:${instruction.id}`}
                            onClick={() => {
                              const reason = window.prompt(t("Why are you cancelling this instruction? (optional)", "ما سبب إلغاء التعليمات؟ (اختياري)")) ?? "";
                              setCompletionNotes((current) => ({ ...current, [instruction.id]: reason }));
                              window.setTimeout(() => void advance(instruction.id, "cancel"), 0);
                            }}
                            className="inline-flex items-center gap-2 text-sm font-semibold text-rose-700 hover:text-rose-800 disabled:opacity-60"
                          >
                            {saving === `cancel:${instruction.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                            {t("Cancel instruction", "إلغاء التعليمات")}
                          </button>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
