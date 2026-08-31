"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Row = Record<string, any>;
type Snapshot = {
  manager: boolean;
  currentPersonId: string | null;
  selectedPersonId: string | null;
  selectedPeriodId: string | null;
  periodSupport: boolean;
  periodWarning: string | null;
  team: Row[];
  products: Row[];
  balances: Row[];
  periods: Row[];
  purchases: Row[];
  payments: Row[];
  advances: Row[];
  expenses: Row[];
  returns: Row[];
  reimbursements: Row[];
  events: Row[];
};
type Props = {
  initialPersonId?: string;
  lockPerson?: boolean;
  locale?: string;
  selfServiceOnly?: boolean;
};
type Tab = "overview" | "purchase" | "expense" | "history";
type Notice = { kind: "success" | "error"; text: string } | null;
type LedgerEntry = {
  id: string;
  kind: string;
  label: string;
  details: string;
  amount?: number;
  date: string;
  status?: string;
  expenseId?: string;
  correction?: string;
};

const money = (value: unknown) => {
  const numeric = Number(value ?? 0);
  return (Number.isFinite(numeric) ? numeric : 0).toFixed(2) + " LYD";
};

const nowLocal = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);

function browserLocale(fallback: string) {
  if (typeof window === "undefined") return fallback;
  const saved = window.localStorage.getItem("snacky_os_language");
  const cookie = document.cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("snacky_os_language="))
    ?.split("=")[1];
  const html = document.documentElement.lang;
  return [saved, cookie, html, fallback].find(
    (value) => value === "ar" || value === "en",
  ) || "ar";
}

function translated(ar: boolean, english: string, arabic: string) {
  return ar ? arabic : english;
}

function formatDate(value: unknown, ar: boolean) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(ar ? "ar-LY" : "en-US");
}

function normalizeSnapshot(value: any): Snapshot {
  const rows = (key: string) => (Array.isArray(value?.[key]) ? value[key] : []);
  return {
    manager: Boolean(value?.manager),
    currentPersonId: value?.currentPersonId || null,
    selectedPersonId: value?.selectedPersonId || null,
    selectedPeriodId: value?.selectedPeriodId || null,
    periodSupport: value?.periodSupport !== false,
    periodWarning: value?.periodWarning || null,
    team: rows("team"),
    products: rows("products"),
    balances: rows("balances"),
    periods: rows("periods"),
    purchases: rows("purchases"),
    payments: rows("payments"),
    advances: rows("advances"),
    expenses: rows("expenses"),
    returns: rows("returns"),
    reimbursements: rows("reimbursements"),
    events: rows("events").length ? rows("events") : rows("periodEvents"),
  };
}

function statusText(status: unknown, ar: boolean) {
  const value = String(status || "").toLowerCase();
  const labels: Record<string, [string, string]> = {
    open: ["Open", "مفتوحة"],
    closed: ["Closed", "مغلقة"],
    settled: ["Settled", "تمت تسويتها"],
    ready_to_settle: ["Ready to settle", "جاهزة للتسوية"],
    partially_settled: ["Partially settled", "مسددة جزئياً"],
    unsettled: ["Not settled", "غير مسددة"],
    needs_review: ["Needs review", "تحتاج مراجعة"],
    unpaid: ["Unpaid", "غير مدفوع"],
    partially_paid: ["Partially paid", "مدفوع جزئياً"],
    paid: ["Paid", "مدفوع"],
    submitted: ["Pending review", "قيد المراجعة"],
    approved: ["Approved", "معتمد"],
    rejected: ["Rejected", "مرفوض"],
    reopened: ["Reopened", "أعيد فتحها"],
  };
  const label = labels[value];
  return label ? translated(ar, label[0], label[1]) : String(status || "—");
}

function StatusBadge({ status, ar }: { status: unknown; ar: boolean }) {
  const value = String(status || "").toLowerCase();
  const color =
    value === "paid" || value === "settled" || value === "approved" || value === "ready_to_settle"
      ? "bg-emerald-100 text-emerald-800"
      : value === "unpaid" || value === "unsettled" || value === "rejected"
        ? "bg-red-100 text-red-800"
        : value === "open"
          ? "bg-blue-100 text-blue-800"
          : "bg-amber-100 text-amber-800";
  return (
    <span className={"inline-flex rounded-full px-2.5 py-1 text-xs font-bold " + color}>
      {statusText(status, ar)}
    </span>
  );
}

export default function OperatorMoneyLedgerClient({
  initialPersonId = "",
  lockPerson = false,
  locale = "ar",
  selfServiceOnly = false,
}: Props) {
  const [activeLocale, setActiveLocale] = useState(locale);
  const ar = activeLocale === "ar";
  const t = (english: string, arabic: string) => translated(ar, english, arabic);
  const [data, setData] = useState<Snapshot | null>(null);
  const [personId, setPersonId] = useState(initialPersonId);
  const [periodId, setPeriodId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    const sync = () => setActiveLocale(browserLocale(locale));
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("focus", sync);
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["lang", "dir"],
    });
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("focus", sync);
      observer.disconnect();
    };
  }, [locale]);

  const load = useCallback(
    async (requestedPersonId?: string, requestedPeriodId?: string) => {
      setLoading(true);
      const query = new URLSearchParams();
      const targetPerson = requestedPersonId || initialPersonId;
      if (targetPerson) query.set("personId", targetPerson);
      if (requestedPeriodId) query.set("periodId", requestedPeriodId);
      try {
        const response = await fetch(
          "/api/operator-money" + (query.size ? "?" + query.toString() : ""),
          { cache: "no-store" },
        );
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
          setData(null);
          setNotice({
            kind: "error",
            text:
              json.error ||
              translated(
                activeLocale === "ar",
                "Could not load money records.",
                "تعذر تحميل السجل المالي.",
              ),
          });
          return;
        }
        const snapshot = normalizeSnapshot(json);
        const chosenPerson =
          snapshot.selectedPersonId ||
          targetPerson ||
          snapshot.currentPersonId ||
          snapshot.team[0]?.id ||
          "";
        setData(snapshot);
        setPersonId(String(chosenPerson || ""));
        setPeriodId(
          String(snapshot.selectedPeriodId || requestedPeriodId || ""),
        );
      } catch (error) {
        setData(null);
        setNotice({
          kind: "error",
          text:
            error instanceof Error
              ? error.message
              : translated(
                  activeLocale === "ar",
                  "Could not load money records.",
                  "تعذر تحميل السجل المالي.",
                ),
        });
      } finally {
        setLoading(false);
      }
    },
    [activeLocale, initialPersonId],
  );

  useEffect(() => {
    void load(initialPersonId);
  }, [initialPersonId, load]);

  const post = async (action: string, body: Row) => {
    setSaving(action);
    setNotice(null);
    const payload: Row = {
      action,
      personId,
      ...body,
      periodId: body.periodId || periodId || undefined,
      clientSubmissionId:
        body.clientSubmissionId || action + ":" + crypto.randomUUID(),
    };
    if (typeof payload.date === "string" && payload.date) {
      const localDate = new Date(payload.date);
      if (!Number.isNaN(localDate.getTime())) payload.date = localDate.toISOString();
    }
    try {
      const response = await fetch("/api/operator-money", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice({
          kind: "error",
          text: json.error || t("Save failed.", "فشل الحفظ."),
        });
        return false;
      }
      const messages: Record<string, [string, string]> = {
        purchase: ["Personal item recorded.", "تم تسجيل المنتج الشخصي."],
        expense: ["Expense submitted for review.", "تم إرسال المصروف للمراجعة."],
        advance: ["Work advance recorded.", "تم تسجيل عهدة العمل."],
        debtPayment: ["Personal payment recorded.", "تم تسجيل سداد المشتريات الشخصية."],
        advanceReturn: ["Returned work money recorded.", "تم تسجيل أموال العمل المرجعة."],
        reimbursement: ["Operator reimbursement recorded.", "تم تسجيل سداد مستحقات المشغّل."],
        reviewExpense: ["Expense review saved.", "تم حفظ مراجعة المصروف."],
        closePeriod: ["Period closed.", "تم إغلاق الفترة."],
        reopenPeriod: ["Period reopened.", "تمت إعادة فتح الفترة."],
        settlePeriod: ["Period marked as settled.", "تم اعتماد تسوية الفترة."],
      };
      const success = messages[action] || ["Saved successfully.", "تم الحفظ بنجاح."];
      setNotice({ kind: "success", text: t(success[0], success[1]) });
      await load(personId, periodId);
      return true;
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : t("Save failed.", "فشل الحفظ."),
      });
      return false;
    } finally {
      setSaving("");
    }
  };

  const selectedPeriod = useMemo(
    () =>
      data?.periods.find((period) => String(period.period_id || period.id) === periodId),
    [data, periodId],
  );
  const balance = useMemo(
    () => data?.balances.find((row) => String(row.person_id) === personId),
    [data, personId],
  );

  if (loading && !data) {
    return (
      <div dir={ar ? "rtl" : "ltr"} className="surface-card p-6">
        {t("Loading…", "جارٍ التحميل…")}
      </div>
    );
  }
  if (!data) {
    return (
      <div
        dir={ar ? "rtl" : "ltr"}
        className="surface-card border-red-200 p-6 text-red-700"
      >
        {notice?.text || t("Money records are unavailable.", "السجل المالي غير متاح.")}
      </div>
    );
  }

  const self = !data.manager || selfServiceOnly;
  const tabs: Array<[Tab, string]> = self
    ? [
        ["overview", t("Overview", "نظرة عامة")],
        ["purchase", t("Buy from storage", "شراء من المخزن")],
        ["expense", t("Submit expense", "تسجيل مصروف")],
        ["history", t("History", "السجل")],
      ]
    : [
        ["overview", t("Overview", "نظرة عامة")],
        ["purchase", t("Add personal item", "إضافة منتج شخصي")],
        ["history", t("History & review", "السجل والمراجعة")],
      ];
  const summary = selectedPeriod || balance || {};
  const openForEntries =
    !selectedPeriod ||
    (selectedPeriod.lifecycle_status === "open" && !selectedPeriod.settled_at);

  return (
    <div id="my-money" dir={ar ? "rtl" : "ltr"} className="space-y-5">
      <header className="rounded-2xl bg-slate-900 p-5 text-white">
        <h1 className="text-2xl font-bold">
          {self ? t("My Money", "أموالي") : t("Operator Money", "أموال المشغّلين")}
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-300">
          {self
            ? t(
                "Personal purchases and Snacky work money are tracked separately.",
                "يتم تتبع المشتريات الشخصية وأموال عمل سناكي بشكل منفصل.",
              )
            : t(
                "Monthly personal purchases, work advances, expenses, returns, and settlements.",
                "المشتريات الشخصية والعهد والمصروفات والإرجاعات والتسويات الشهرية.",
              )}
        </p>
      </header>

      {data.manager && !lockPerson && !selfServiceOnly ? (
        <section className="surface-card grid gap-4 p-4 md:grid-cols-2">
          <label className="text-sm font-semibold">
            {t("Operator", "المشغّل")}
            <select
              className="input mt-2"
              value={personId}
              onChange={(event) => {
                const nextPerson = event.target.value;
                setPersonId(nextPerson);
                setPeriodId("");
                void load(nextPerson);
              }}
            >
              {data.team.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.full_name}
                </option>
              ))}
            </select>
          </label>
          <PeriodPicker
            ar={ar}
            periods={data.periods}
            periodId={periodId}
            onChange={(nextPeriod) => {
              setPeriodId(nextPeriod);
              void load(personId, nextPeriod);
            }}
          />
        </section>
      ) : (
        <PeriodPicker
          ar={ar}
          periods={data.periods}
          periodId={periodId}
          onChange={(nextPeriod) => {
            setPeriodId(nextPeriod);
            void load(personId, nextPeriod);
          }}
        />
      )}

      <nav className="rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={
                "whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-semibold " +
                (tab === id
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100")
              }
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      {!data.periodSupport && data.periodWarning ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {ar
            ? "الفترات الشهرية غير مفعّلة بعد. يتم عرض كل السجل الحالي ويمكن متابعة الشراء والمصروفات."
            : data.periodWarning}
        </div>
      ) : null}

      {notice ? (
        <div
          className={
            "rounded-xl border p-3 text-sm " +
            (notice.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800")
          }
        >
          {notice.text}
        </div>
      ) : null}

      {loading ? (
        <div className="text-sm text-slate-500">
          {t("Refreshing period…", "جارٍ تحديث الفترة…")}
        </div>
      ) : null}

      {tab === "overview" ? (
        <Overview
          ar={ar}
          summary={summary}
          selectedPeriod={selectedPeriod}
          self={self}
          onTab={setTab}
          data={data}
          personId={personId}
          post={post}
          saving={saving}
          periodSupport={data.periodSupport}
        />
      ) : null}
      {tab === "purchase" ? (
        <PurchasePanel
          ar={ar}
          products={data.products}
          saving={saving === "purchase"}
          onPost={post}
          allowed={openForEntries}
          manager={!self}
        />
      ) : null}
      {tab === "expense" && self ? (
        <ExpensePanel
          ar={ar}
          advances={data.advances.filter(
            (row) => String(row.person_id) === personId,
          )}
          saving={saving === "expense"}
          onPost={post}
          allowed={openForEntries}
        />
      ) : null}
      {tab === "history" ? (
        <History
          ar={ar}
          data={data}
          personId={personId}
          manager={data.manager && !selfServiceOnly}
          post={post}
          saving={saving}
        />
      ) : null}
    </div>
  );
}

function PeriodPicker({
  ar,
  periods,
  periodId,
  onChange,
}: {
  ar: boolean;
  periods: Row[];
  periodId: string;
  onChange: (value: string) => void;
}) {
  const t = (english: string, arabic: string) => translated(ar, english, arabic);
  if (!periods.length) {
    return (
      <section className="surface-card p-4">
        <div className="text-sm font-bold">{t("Money period", "الفترة المالية")}</div>
        <div className="mt-1 text-sm text-slate-500">
          {t(
            "Current records (monthly periods will appear after the database update).",
            "السجلات الحالية (ستظهر الفترات الشهرية بعد تحديث قاعدة البيانات).",
          )}
        </div>
      </section>
    );
  }
  return (
    <label className="text-sm font-semibold">
      {t("Money period", "الفترة المالية")}
      <select
        className="input mt-2"
        value={periodId}
        onChange={(event) => onChange(event.target.value)}
      >
        {periods.map((period) => {
          const id = String(period.period_id || period.id);
          const lifecycle = period.settled_at ? "settled" : period.lifecycle_status;
          return (
            <option key={id} value={id}>
              {period.label || period.period_start} — {statusText(lifecycle, ar)}
            </option>
          );
        })}
      </select>
    </label>
  );
}

function Overview({
  ar,
  summary,
  selectedPeriod,
  self,
  onTab,
  data,
  personId,
  post,
  saving,
  periodSupport,
}: {
  ar: boolean;
  summary: Row;
  selectedPeriod?: Row;
  self: boolean;
  onTab: (tab: Tab) => void;
  data: Snapshot;
  personId: string;
  post: (action: string, body: Row) => Promise<boolean>;
  saving: string;
  periodSupport: boolean;
}) {
  const t = (english: string, arabic: string) => translated(ar, english, arabic);
  const personalCharged = summary.personal_purchases_lyd ?? 0;
  const personalPaid = summary.debt_paid_lyd ?? 0;
  const personalRemaining = summary.personal_debt_remaining_lyd ?? 0;
  const advanceDue =
    summary.advance_due_to_snacky_lyd ?? summary.unaccounted_advance_lyd ?? 0;
  const reimbursementDue =
    summary.reimbursement_due_to_operator_lyd ??
    summary.operator_reimbursement_due_lyd ??
    0;

  return (
    <div className="space-y-5">
      {selectedPeriod ? <PeriodBanner ar={ar} period={selectedPeriod} /> : null}

      <div className="grid gap-5 xl:grid-cols-2">
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-bold">
                {t("Personal purchases", "المشتريات الشخصية")}
              </h2>
              <p className="mt-1 text-xs text-amber-800">
                {t(
                  "Products taken for personal use. This debt is never mixed with work money.",
                  "منتجات للاستخدام الشخصي. هذا الدين لا يختلط أبداً بأموال العمل.",
                )}
              </p>
            </div>
            {Number(personalRemaining) > 0 ? (
              <StatusBadge
                status={Number(personalPaid) > 0 ? "partially_paid" : "unpaid"}
                ar={ar}
              />
            ) : (
              <StatusBadge status="paid" ar={ar} />
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric
              label={t("Items charged", "قيمة المنتجات")}
              value={personalCharged}
            />
            <Metric
              label={t("Payments received", "المدفوع")}
              value={personalPaid}
            />
            <Metric
              label={t("Operator still owes", "المتبقي على المشغّل")}
              value={personalRemaining}
              strong
            />
          </div>
        </section>

        <section className="rounded-2xl border border-blue-200 bg-blue-50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-bold">
                {t("Snacky work money", "أموال عمل سناكي")}
              </h2>
              <p className="mt-1 text-xs text-blue-800">
                {t(
                  "Advances, approved work expenses, returns, and reimbursements.",
                  "العهد ومصروفات العمل المعتمدة والإرجاعات ومستحقات المشغّل.",
                )}
              </p>
            </div>
            {Number(summary.pending_expense_count ?? 0) > 0 ? (
              <StatusBadge status="needs_review" ar={ar} />
            ) : null}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric
              label={t("Advance received", "العهد المستلمة")}
              value={summary.advanced_lyd}
            />
            <Metric
              label={t("Approved work expenses", "مصروفات العمل المعتمدة")}
              value={summary.approved_expenses_lyd}
            />
            <Metric
              label={t("Money returned", "الأموال المرجعة")}
              value={summary.returned_money_lyd}
            />
            <Metric
              label={t("Operator owes Snacky", "على المشغّل لسناكي")}
              value={advanceDue}
              strong
            />
            <Metric
              label={t("Snacky reimbursed", "ما سددته سناكي للمشغّل")}
              value={summary.reimbursed_lyd}
            />
            <Metric
              label={t("Snacky owes operator", "على سناكي للمشغّل")}
              value={reimbursementDue}
              strong
            />
          </div>
          <div className="mt-3 text-xs text-blue-800">
            {t("Pending expense reviews", "مصروفات بانتظار المراجعة")}:{" "}
            <strong>{Number(summary.pending_expense_count ?? 0)}</strong>
          </div>
        </section>
      </div>

      {self ? (
        <div className="grid gap-4 md:grid-cols-2">
          <button
            type="button"
            onClick={() => onTab("purchase")}
            className="rounded-2xl border border-slate-200 bg-white p-5 text-start shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          >
            <div className="text-lg font-bold">
              {t("I took products for myself", "أخذت منتجات للاستخدام الشخصي")}
            </div>
            <p className="mt-2 text-sm text-slate-500">
              {t(
                "Choose products from verified storage stock at the official selling price.",
                "اختر المنتجات من مخزون موثوق وبسعر البيع الرسمي.",
              )}
            </p>
          </button>
          <button
            type="button"
            onClick={() => onTab("expense")}
            className="rounded-2xl border border-slate-200 bg-white p-5 text-start shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          >
            <div className="text-lg font-bold">
              {t("I paid for Snacky work", "دفعت مصروفاً خاصاً بسناكي")}
            </div>
            <p className="mt-2 text-sm text-slate-500">
              {t(
                "Submit fuel, maintenance, supplies, or delivery costs for review.",
                "سجّل الوقود أو الصيانة أو المستلزمات أو التوصيل للمراجعة.",
              )}
            </p>
          </button>
        </div>
      ) : (
        <ManagerActions
          ar={ar}
          data={data}
          personId={personId}
          period={selectedPeriod}
          summary={summary}
          post={post}
          saving={saving}
          periodSupport={periodSupport}
          onAddItem={() => onTab("purchase")}
        />
      )}

      <Recent ar={ar} data={data} personId={personId} />
    </div>
  );
}

function PeriodBanner({ ar, period }: { ar: boolean; period: Row }) {
  const t = (english: string, arabic: string) => translated(ar, english, arabic);
  const state = period.settled_at ? "settled" : period.settlement_state || period.lifecycle_status;
  return (
    <section className="surface-card flex flex-wrap items-center justify-between gap-3 p-4">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t("Selected period", "الفترة المحددة")}
        </div>
        <div className="mt-1 font-bold">{period.label}</div>
        <div className="text-xs text-slate-500">
          {period.period_start} — {period.period_end}
        </div>
      </div>
      <StatusBadge status={state} ar={ar} />
    </section>
  );
}

function Metric({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: unknown;
  strong?: boolean;
}) {
  return (
    <div className="rounded-xl bg-white/80 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={"mt-1 " + (strong ? "text-lg font-extrabold" : "font-bold")}>
        {money(value)}
      </div>
    </div>
  );
}

function PurchasePanel({
  ar,
  products,
  saving,
  onPost,
  allowed,
  manager,
}: {
  ar: boolean;
  products: Row[];
  saving: boolean;
  onPost: (action: string, body: Row) => Promise<boolean>;
  allowed: boolean;
  manager: boolean;
}) {
  const t = (english: string, arabic: string) => translated(ar, english, arabic);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [source, setSource] = useState<Row | null>(null);
  const [checking, setChecking] = useState(false);
  const categories = useMemo(
    () => [
      "all",
      ...Array.from(
        new Set(products.map((product) => String(product.category || "Other"))),
      ),
    ],
    [products],
  );
  const filtered = useMemo(
    () =>
      products
        .filter(
          (product) =>
            (category === "all" ||
              String(product.category || "Other") === category) &&
            (String(product.name || "") +
              " " +
              String(product.brand || "") +
              " " +
              String(product.category || ""))
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .slice(0, 20),
    [products, query, category],
  );
  const selected = products.find((product) => String(product.id) === productId);
  const price = Number(
    selected?.current_selling_price_lyd ?? selected?.selling_price ?? 0,
  );

  const choose = async (product: Row) => {
    if (!allowed) return;
    setProductId(String(product.id));
    setSource(null);
    setQuantity(1);
    setChecking(true);
    try {
      const response = await fetch("/api/operator-money", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "availability", productId: product.id }),
      });
      const json = await response.json().catch(() => ({}));
      const best = (response.ok && Array.isArray(json.data) ? json.data : [])
        .filter((row: Row) => Number(row.available_qty) > 0)
        .sort(
          (left: Row, right: Row) =>
            Number(right.available_qty) - Number(left.available_qty),
        )[0];
      setSource(best || null);
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="surface-card p-5">
      <div className="max-w-3xl">
        <h2 className="text-xl font-bold">
          {manager
            ? t("Add personal item", "إضافة منتج شخصي للمشغّل")
            : t("Buy products from storage", "شراء منتجات من المخزن")}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          {t(
            "The official product selling price is used automatically. It cannot be typed or overridden here.",
            "يُستخدم سعر البيع الرسمي للمنتج تلقائياً ولا يمكن إدخاله أو تغييره هنا.",
          )}
        </p>
        {!allowed ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            {t(
              "This period is closed or settled. Reopen it before adding an item.",
              "هذه الفترة مغلقة أو تمت تسويتها. أعد فتحها قبل إضافة منتج.",
            )}
          </div>
        ) : null}

        <input
          className="input mt-5"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("Search product or brand…", "ابحث عن المنتج أو العلامة…")}
        />
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {categories.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setCategory(item)}
              className={
                "whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold " +
                (category === item
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600")
              }
            >
              {item === "all" ? t("All", "الكل") : item}
            </button>
          ))}
        </div>
        <div className="mt-3 max-h-80 overflow-y-auto rounded-xl border">
          {filtered.map((product) => (
            <button
              key={product.id}
              type="button"
              disabled={!allowed}
              onClick={() => void choose(product)}
              className={
                "flex w-full items-center justify-between border-b p-3 text-start last:border-0 disabled:cursor-not-allowed disabled:opacity-50 " +
                (productId === String(product.id)
                  ? "bg-slate-100"
                  : "hover:bg-slate-50")
              }
            >
              <div>
                <div className="font-semibold">{product.name}</div>
                <div className="text-xs text-slate-500">
                  {[product.brand, product.category].filter(Boolean).join(" · ")}
                </div>
              </div>
              <strong>
                {money(
                  product.current_selling_price_lyd ?? product.selling_price,
                )}
              </strong>
            </button>
          ))}
        </div>

        {selected ? (
          <form
            className="mt-5 space-y-4 rounded-2xl bg-slate-50 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!source || !allowed) return;
              const form = event.currentTarget;
              const body = Object.fromEntries(new FormData(form).entries());
              void onPost("purchase", body).then((ok) => {
                if (ok) {
                  setProductId("");
                  setQuery("");
                  setQuantity(1);
                  setSource(null);
                }
              });
            }}
          >
            <input type="hidden" name="productId" value={productId} />
            <input
              type="hidden"
              name="storageLocationId"
              value={source?.storage_location_id || ""}
            />
            <div>
              <div className="text-xs text-slate-500">
                {t("Selected product", "المنتج المختار")}
              </div>
              <div className="font-bold">{selected.name}</div>
            </div>
            {checking ? (
              <div className="rounded-xl bg-white p-3 text-sm">
                {t("Checking available stock…", "جارٍ التحقق من الكمية المتاحة…")}
              </div>
            ) : source ? (
              <div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">
                {t(
                  String(source.available_qty) + " units available",
                  "الكمية المتاحة: " + String(source.available_qty),
                )}
              </div>
            ) : (
              <div className="rounded-xl bg-red-50 p-3 text-sm text-red-700">
                {t(
                  "Not available in verified storage stock.",
                  "المنتج غير متوفر في مخزون موثوق.",
                )}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-semibold">
                {t("Quantity", "الكمية")}
                <input
                  className="input mt-2"
                  name="quantity"
                  type="number"
                  min="1"
                  max={Number(source?.available_qty || 1)}
                  value={quantity}
                  onChange={(event) =>
                    setQuantity(Math.max(1, Number(event.target.value) || 1))
                  }
                  required
                />
              </label>
              <div>
                <div className="text-sm font-semibold">
                  {t("Official selling price", "سعر البيع الرسمي")}
                </div>
                <div className="input mt-2 bg-white font-bold">{money(price)}</div>
              </div>
            </div>
            <div className="flex justify-between rounded-xl bg-white p-3">
              <span>{t("Personal debt added", "الدين الشخصي المضاف")}</span>
              <strong>{money(quantity * price)}</strong>
            </div>
            <textarea
              className="input"
              name="note"
              placeholder={t("Optional note", "ملاحظة اختيارية")}
            />
            <button
              className="btn-primary w-full"
              disabled={saving || checking || !source || !allowed}
            >
              {saving
                ? t("Recording…", "جارٍ التسجيل…")
                : t("Confirm personal item", "تأكيد المنتج الشخصي")}
            </button>
          </form>
        ) : null}
      </div>
    </section>
  );
}

function ExpensePanel({
  ar,
  advances,
  saving,
  onPost,
  allowed,
}: {
  ar: boolean;
  advances: Row[];
  saving: boolean;
  onPost: (action: string, body: Row) => Promise<boolean>;
  allowed: boolean;
}) {
  const t = (english: string, arabic: string) => translated(ar, english, arabic);
  return (
    <section className="surface-card p-5">
      <div className="max-w-2xl">
        <h2 className="text-xl font-bold">
          {t("Submit a work expense", "تسجيل مصروف عمل")}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          {t(
            "This is Snacky work money, not a personal purchase payment.",
            "هذا من أموال عمل سناكي وليس سداداً لمشتريات شخصية.",
          )}
        </p>
        {!allowed ? (
          <div className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            {t(
              "This period is closed or settled.",
              "هذه الفترة مغلقة أو تمت تسويتها.",
            )}
          </div>
        ) : null}
        <form
          className="mt-5 grid gap-4"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (!allowed) return;
            const form = event.currentTarget;
            void onPost(
              "expense",
              Object.fromEntries(new FormData(form).entries()),
            ).then((ok) => {
              if (ok) form.reset();
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold">
              {t("Amount", "المبلغ")}
              <MoneyInput ar={ar} />
            </label>
            <label className="text-sm font-semibold">
              {t("Date and time", "التاريخ والوقت")}
              <input
                className="input mt-2"
                name="date"
                type="datetime-local"
                defaultValue={nowLocal()}
                required
              />
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold">
              {t("Expense type", "نوع المصروف")}
              <select className="input mt-2" name="expenseType" required defaultValue="">
                <option value="" disabled>
                  {t("Choose type", "اختر النوع")}
                </option>
                <option value="Fuel">{t("Fuel", "وقود")}</option>
                <option value="Vehicle">{t("Vehicle", "سيارة")}</option>
                <option value="Machine supplies">
                  {t("Machine supplies", "مستلزمات ماكينة")}
                </option>
                <option value="Storage supplies">
                  {t("Storage supplies", "مستلزمات مخزن")}
                </option>
                <option value="Delivery">{t("Delivery", "توصيل")}</option>
                <option value="Other">{t("Other", "أخرى")}</option>
              </select>
            </label>
            <label className="text-sm font-semibold">
              {t("Paid to", "دُفع إلى")}
              <input
                className="input mt-2"
                name="supplierPayee"
                required
                placeholder={t(
                  "Shop, supplier, or person",
                  "المحل أو المورد أو الشخص",
                )}
              />
            </label>
          </div>
          <label className="text-sm font-semibold">
            {t("Related work advance", "عهدة العمل المرتبطة")}
            <select className="input mt-2" name="advanceId">
              <option value="">{t("Paid from my own money", "دفعت من مالي الشخصي")}</option>
              {advances.map((advance) => (
                <option key={advance.id} value={advance.id}>
                  {advance.purpose} — {money(advance.amount_lyd)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-semibold">
            {t("Details", "التفاصيل")}
            <textarea
              className="input mt-2"
              name="note"
              required
              placeholder={t(
                "Explain the work expense clearly",
                "وضح مصروف العمل بشكل واضح",
              )}
            />
          </label>
          <input
            className="input"
            name="receiptUrl"
            placeholder={t("Receipt link (optional)", "رابط الإيصال (اختياري)")}
          />
          <button className="btn-primary w-full" disabled={saving || !allowed}>
            {saving
              ? t("Submitting…", "جارٍ الإرسال…")
              : t("Submit for review", "إرسال للمراجعة")}
          </button>
        </form>
      </div>
    </section>
  );
}

function ManagerActions({
  ar,
  data,
  personId,
  period,
  summary,
  post,
  saving,
  periodSupport,
  onAddItem,
}: {
  ar: boolean;
  data: Snapshot;
  personId: string;
  period?: Row;
  summary: Row;
  post: (action: string, body: Row) => Promise<boolean>;
  saving: string;
  periodSupport: boolean;
  onAddItem: () => void;
}) {
  const t = (english: string, arabic: string) => translated(ar, english, arabic);
  const settled = Boolean(period?.settled_at);
  const open = !period || period.lifecycle_status === "open";
  const periodAvailable = !period || Boolean(period.period_id || period.id);
  const debtDue = Number(summary.personal_debt_remaining_lyd ?? 0);
  const advanceDue = Number(
    summary.advance_due_to_snacky_lyd ?? summary.unaccounted_advance_lyd ?? 0,
  );
  const reimbursementDue = Number(
    summary.reimbursement_due_to_operator_lyd ??
      summary.operator_reimbursement_due_lyd ??
      0,
  );

  const submit = (action: string) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    void post(action, Object.fromEntries(new FormData(form).entries())).then(
      (ok) => {
        if (ok) form.reset();
      },
    );
  };

  return (
    <div className="space-y-4">
      {period && periodSupport ? (
        <PeriodControls
          ar={ar}
          period={period}
          post={post}
          saving={saving}
        />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <button
          type="button"
          onClick={onAddItem}
          disabled={!open || settled}
          className="surface-card p-4 text-start disabled:cursor-not-allowed disabled:opacity-50"
        >
          <div className="font-bold">{t("Add personal item", "إضافة منتج شخصي")}</div>
          <p className="mt-2 text-sm text-slate-500">
            {t(
              "Charge a verified storage item to this operator at its official price.",
              "حمّل منتجاً من المخزن على المشغّل بسعره الرسمي.",
            )}
          </p>
        </button>

        <ActionForm
          title={t("Give work money", "تسليم عهدة عمل")}
          onSubmit={submit("advance")}
          disabled={!open || settled || saving === "advance"}
          submitLabel={t("Record advance", "تسجيل العهدة")}
        >
          <MoneyInput ar={ar} />
          <input
            className="input"
            name="purpose"
            required
            placeholder={t("Work purpose", "غرض العمل")}
          />
          <DateInput ar={ar} />
          <input
            className="input"
            name="note"
            placeholder={t("Optional note", "ملاحظة اختيارية")}
          />
        </ActionForm>

        <ActionForm
          title={t("Record personal payment", "تسجيل سداد شخصي")}
          note={t(
            "Reduces personal purchase debt only.",
            "يخفض دين المشتريات الشخصية فقط.",
          )}
          onSubmit={submit("debtPayment")}
          disabled={!periodAvailable || settled || debtDue <= 0 || saving === "debtPayment"}
          submitLabel={t("Record payment", "تسجيل السداد")}
        >
          <MoneyInput ar={ar} max={debtDue} />
          <DateInput ar={ar} />
          <input
            className="input"
            name="paymentMethod"
            required
            placeholder={t("Payment method", "طريقة الدفع")}
          />
          <input
            className="input"
            name="note"
            placeholder={t("Optional note", "ملاحظة اختيارية")}
          />
        </ActionForm>

        <ActionForm
          title={t("Return unused work money", "إرجاع أموال عمل غير مستخدمة")}
          note={t(
            "Reduces only the work advance due to Snacky.",
            "يخفض فقط عهدة العمل المستحقة لسناكي.",
          )}
          onSubmit={submit("advanceReturn")}
          disabled={!periodAvailable || settled || advanceDue <= 0 || saving === "advanceReturn"}
          submitLabel={t("Record return", "تسجيل الإرجاع")}
        >
          <MoneyInput ar={ar} max={advanceDue} />
          <select className="input" name="advanceId">
            <option value="">{t("General return", "إرجاع عام")}</option>
            {data.advances
              .filter((advance) => String(advance.person_id) === personId)
              .map((advance) => (
                <option key={advance.id} value={advance.id}>
                  {advance.purpose || t("Work advance", "عهدة عمل")} —{" "}
                  {money(advance.amount_lyd)}
                </option>
              ))}
          </select>
          <DateInput ar={ar} />
          <input
            className="input"
            name="paymentMethod"
            required
            placeholder={t("Return method", "طريقة الإرجاع")}
          />
          <input
            className="input"
            name="note"
            placeholder={t("Optional note", "ملاحظة اختيارية")}
          />
        </ActionForm>

        {periodSupport ? <ActionForm
          title={t("Reimburse operator", "سداد مستحقات المشغّل")}
          note={t(
            "Pays approved work expenses the operator covered personally.",
            "سداد مصروفات عمل معتمدة دفعها المشغّل من ماله.",
          )}
          onSubmit={submit("reimbursement")}
          disabled={
            !periodAvailable ||
            settled ||
            reimbursementDue <= 0 ||
            saving === "reimbursement"
          }
          submitLabel={t("Record reimbursement", "تسجيل السداد للمشغّل")}
        >
          <MoneyInput ar={ar} max={reimbursementDue} />
          <DateInput ar={ar} />
          <input
            className="input"
            name="paymentMethod"
            required
            placeholder={t("Payment method", "طريقة الدفع")}
          />
          <input
            className="input"
            name="note"
            placeholder={t("Optional note", "ملاحظة اختيارية")}
          />
        </ActionForm> : null}
      </div>
    </div>
  );
}

function ActionForm({
  title,
  note,
  children,
  onSubmit,
  disabled,
  submitLabel,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  disabled: boolean;
  submitLabel: string;
}) {
  return (
    <section className="surface-card p-4">
      <h3 className="font-bold">{title}</h3>
      {note ? <p className="mt-1 text-xs text-slate-500">{note}</p> : null}
      <form className="mt-3 space-y-2" onSubmit={onSubmit}>
        <fieldset disabled={disabled} className="space-y-2 disabled:opacity-50">
          {children}
          <button className="btn-primary w-full">{submitLabel}</button>
        </fieldset>
      </form>
    </section>
  );
}

function PeriodControls({
  ar,
  period,
  post,
  saving,
}: {
  ar: boolean;
  period: Row;
  post: (action: string, body: Row) => Promise<boolean>;
  saving: string;
}) {
  const t = (english: string, arabic: string) => translated(ar, english, arabic);
  const open = period.lifecycle_status === "open";
  const settled = Boolean(period.settled_at);
  const ready =
    period.settlement_state === "ready_to_settle" ||
    (Number(period.personal_debt_remaining_lyd ?? 0) === 0 &&
      Number(period.advance_due_to_snacky_lyd ?? 0) === 0 &&
      Number(period.reimbursement_due_to_operator_lyd ?? 0) === 0 &&
      Number(period.pending_expense_count ?? 0) === 0);
  const submit = (action: string) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    void post(action, Object.fromEntries(new FormData(form).entries())).then(
      (ok) => {
        if (ok) form.reset();
      },
    );
  };

  return (
    <section className="surface-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-bold">{t("Period control", "إدارة الفترة")}</h3>
          <p className="mt-1 text-xs text-slate-500">
            {t(
              "Close to stop new entries. Mark settled only after every balance and review is complete.",
              "أغلق الفترة لإيقاف الحركات الجديدة، واعتمد التسوية بعد تصفير الأرصدة وإكمال المراجعة.",
            )}
          </p>
        </div>
        <StatusBadge
          status={settled ? "settled" : period.lifecycle_status}
          ar={ar}
        />
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {open && !settled ? (
          <form className="space-y-2" onSubmit={submit("closePeriod")}>
            <input
              className="input"
              name="note"
              placeholder={t("Closing note", "ملاحظة الإغلاق")}
            />
            <button
              className="btn-secondary w-full"
              disabled={saving === "closePeriod"}
            >
              {t("Close period", "إغلاق الفترة")}
            </button>
          </form>
        ) : null}
        {!open && !settled ? (
          <form className="space-y-2" onSubmit={submit("reopenPeriod")}>
            <input
              className="input"
              name="note"
              placeholder={t("Reason for reopening", "سبب إعادة الفتح")}
              required
            />
            <button
              className="btn-secondary w-full"
              disabled={saving === "reopenPeriod"}
            >
              {t("Reopen period", "إعادة فتح الفترة")}
            </button>
          </form>
        ) : null}
        {!open && !settled ? (
          <form className="space-y-2" onSubmit={submit("settlePeriod")}>
            <input
              className="input"
              name="note"
              placeholder={t("Settlement note", "ملاحظة التسوية")}
              required
            />
            <button
              className="btn-primary w-full"
              disabled={!ready || saving === "settlePeriod"}
              title={
                ready
                  ? undefined
                  : t(
                      "Resolve every balance and pending expense first.",
                      "يجب تسوية كل الأرصدة والمصروفات المعلقة أولاً.",
                    )
              }
            >
              {t("Mark period settled", "اعتماد تسوية الفترة")}
            </button>
          </form>
        ) : null}
      </div>
      {!ready && !settled ? (
        <p className="mt-3 text-xs font-semibold text-amber-700">
          {t(
            "This period cannot be settled yet: a balance or pending review remains.",
            "لا يمكن تسوية هذه الفترة بعد: يوجد رصيد أو مراجعة معلقة.",
          )}
        </p>
      ) : null}
    </section>
  );
}

function Recent({
  ar,
  data,
  personId,
}: {
  ar: boolean;
  data: Snapshot;
  personId: string;
}) {
  const t = (english: string, arabic: string) => translated(ar, english, arabic);
  const rows = buildEntries(data, personId, ar).slice(0, 6);
  return (
    <section className="surface-card p-4">
      <h3 className="font-bold">{t("Recent activity", "آخر الحركات")}</h3>
      {rows.length ? (
        <div className="mt-3 divide-y">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap justify-between gap-3 py-3"
            >
              <div>
                <div className="text-sm font-semibold">{row.label}</div>
                <div className="text-xs text-slate-500">{row.details}</div>
                <div className="text-xs text-slate-500">
                  {formatDate(row.date, ar)}
                </div>
              </div>
              <div className="text-end">
                {row.amount !== undefined ? <strong>{money(row.amount)}</strong> : null}
                {row.status ? (
                  <div className="mt-1">
                    <StatusBadge status={row.status} ar={ar} />
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">
          {t("No records in this period.", "لا توجد حركات في هذه الفترة.")}
        </p>
      )}
    </section>
  );
}

function MoneyInput({
  ar,
  max,
}: {
  ar: boolean;
  max?: number;
}) {
  return (
    <input
      className="input mt-2"
      name="amount"
      type="number"
      min="0.01"
      max={max && max > 0 ? max : undefined}
      step="0.01"
      required
      placeholder={ar ? "المبلغ بالدينار" : "Amount (LYD)"}
    />
  );
}

function DateInput({ ar }: { ar: boolean }) {
  return (
    <label className="block text-xs font-semibold text-slate-600">
      {translated(ar, "Date and time", "التاريخ والوقت")}
      <input
        className="input mt-1"
        name="date"
        type="datetime-local"
        defaultValue={nowLocal()}
        required
      />
    </label>
  );
}

function buildEntries(data: Snapshot, personId: string, ar: boolean) {
  const t = (english: string, arabic: string) => translated(ar, english, arabic);
  const samePerson = (row: Row) =>
    !row.person_id || String(row.person_id) === personId;
  const entries: LedgerEntry[] = [];

  data.purchases.filter(samePerson).forEach((row) => {
    const product = row.product_name || row.product?.name || t("Product", "منتج");
    entries.push({
      id: "purchase-" + row.id,
      kind: "purchase",
      label: t("Personal purchase", "شراء شخصي") + ": " + product + " × " + row.quantity,
      details:
        money(row.unit_price_lyd) +
        " " +
        t("per item", "للوحدة") +
        (row.remaining_amount_lyd !== undefined
          ? " · " + t("Remaining", "المتبقي") + " " + money(row.remaining_amount_lyd)
          : ""),
      amount: Number(row.total_lyd ?? 0),
      date: String(row.purchased_at || row.created_at || ""),
      status: row.payment_status || "unpaid",
      correction: row.corrected_from_unit_price_lyd
        ? t(
            "Price corrected from " + money(row.corrected_from_unit_price_lyd),
            "تم تصحيح السعر من " + money(row.corrected_from_unit_price_lyd),
          )
        : undefined,
    });
  });

  data.payments.filter(samePerson).forEach((row) => {
    entries.push({
      id: "payment-" + row.id,
      kind: "payment",
      label: t("Personal purchase payment", "سداد مشتريات شخصية"),
      details: String(row.payment_method || "") + (row.note ? " · " + row.note : ""),
      amount: Number(row.amount_lyd ?? 0),
      date: String(row.paid_at || row.created_at || ""),
      status: "paid",
    });
  });

  data.advances.filter(samePerson).forEach((row) => {
    entries.push({
      id: "advance-" + row.id,
      kind: "advance",
      label: t("Work advance received", "عهدة عمل مستلمة"),
      details: String(row.purpose || "") + (row.note ? " · " + row.note : ""),
      amount: Number(row.amount_lyd ?? 0),
      date: String(row.given_at || row.created_at || ""),
    });
  });

  data.expenses.filter(samePerson).forEach((row) => {
    entries.push({
      id: "expense-" + row.id,
      kind: "expense",
      label: t("Snacky work expense", "مصروف عمل سناكي"),
      details:
        String(row.expense_type || "") +
        (row.supplier_payee ? " · " + row.supplier_payee : ""),
      amount: Number(row.amount_lyd ?? 0),
      date: String(row.spent_at || row.created_at || ""),
      status: row.status,
      expenseId: String(row.id),
    });
  });

  data.returns.filter(samePerson).forEach((row) => {
    entries.push({
      id: "return-" + row.id,
      kind: "return",
      label: t("Unused work money returned", "إرجاع أموال عمل غير مستخدمة"),
      details: String(row.payment_method || "") + (row.note ? " · " + row.note : ""),
      amount: Number(row.amount_lyd ?? 0),
      date: String(row.returned_at || row.created_at || ""),
    });
  });

  data.reimbursements.filter(samePerson).forEach((row) => {
    entries.push({
      id: "reimbursement-" + row.id,
      kind: "reimbursement",
      label: t("Operator reimbursed by Snacky", "سداد سناكي لمستحقات المشغّل"),
      details: String(row.payment_method || "") + (row.note ? " · " + row.note : ""),
      amount: Number(row.amount_lyd ?? 0),
      date: String(row.paid_at || row.created_at || ""),
      status: "paid",
    });
  });

  data.events.filter(samePerson).forEach((row) => {
    entries.push({
      id: "event-" + row.id,
      kind: "event",
      label:
        row.action === "closed"
          ? t("Period closed", "تم إغلاق الفترة")
          : row.action === "reopened"
            ? t("Period reopened", "تمت إعادة فتح الفترة")
            : t("Period settled", "تمت تسوية الفترة"),
      details: String(row.note || ""),
      date: String(row.acted_at || row.created_at || ""),
      status: row.action,
    });
  });

  return entries.sort((left, right) => right.date.localeCompare(left.date));
}

function History({
  ar,
  data,
  personId,
  manager,
  post,
  saving,
}: {
  ar: boolean;
  data: Snapshot;
  personId: string;
  manager: boolean;
  post: (action: string, body: Row) => Promise<boolean>;
  saving: string;
}) {
  const t = (english: string, arabic: string) => translated(ar, english, arabic);
  const entries = buildEntries(data, personId, ar);
  return (
    <section className="surface-card p-4">
      <h2 className="text-xl font-bold">{t("Money history", "السجل المالي")}</h2>
      <p className="mt-1 text-sm text-slate-500">
        {t(
          "Every personal and work-money event for the selected period.",
          "كل حركات الأموال الشخصية وأموال العمل للفترة المحددة.",
        )}
      </p>
      {entries.length ? (
        <div className="mt-4 grid gap-3">
          {entries.map((entry) => (
            <article
              key={entry.id}
              className="rounded-2xl border border-slate-200 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-bold">{entry.label}</div>
                  {entry.details ? (
                    <div className="mt-1 text-sm text-slate-500">{entry.details}</div>
                  ) : null}
                  <div className="mt-1 text-xs text-slate-500">
                    {formatDate(entry.date, ar)}
                  </div>
                  {entry.correction ? (
                    <div className="mt-2 inline-flex rounded-full bg-violet-100 px-2.5 py-1 text-xs font-bold text-violet-800">
                      {entry.correction}
                    </div>
                  ) : null}
                </div>
                <div className="text-end">
                  {entry.amount !== undefined ? (
                    <div className="font-extrabold">{money(entry.amount)}</div>
                  ) : null}
                  {entry.status ? (
                    <div className="mt-1">
                      <StatusBadge status={entry.status} ar={ar} />
                    </div>
                  ) : null}
                </div>
              </div>
              {manager &&
              entry.kind === "expense" &&
              entry.status === "submitted" ? (
                <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
                  <button
                    className="btn-secondary"
                    disabled={saving === "reviewExpense"}
                    onClick={() =>
                      void post("reviewExpense", {
                        expenseId: entry.expenseId,
                        status: "approved",
                      })
                    }
                  >
                    {t("Approve expense", "اعتماد المصروف")}
                  </button>
                  <button
                    className="btn-secondary"
                    disabled={saving === "reviewExpense"}
                    onClick={() =>
                      void post("reviewExpense", {
                        expenseId: entry.expenseId,
                        status: "rejected",
                      })
                    }
                  >
                    {t("Reject expense", "رفض المصروف")}
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm text-slate-500">
          {t("No records in this period.", "لا توجد حركات في هذه الفترة.")}
        </p>
      )}
    </section>
  );
}
