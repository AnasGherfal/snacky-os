"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import OperatorMoneyLedgerClient from "./OperatorMoneyLedgerClient";
import type { PurchaseOverview, PurchaseHistoryRow, PurchaseTotals } from "@/lib/operator-purchase-overview";

type Props = ComponentProps<typeof OperatorMoneyLedgerClient> & { initialPersonId: string; lockPerson: true };
const money = (value: number) => `${value.toFixed(2)} LYD`;

/** Both existing entry pages are person-locked. Keep their working forms intact. */
export default function OperatorMoneyWorkspace(props: Props) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refreshTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = refreshTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);
  const afterSubmit = () => {
    const timers = refreshTimers.current;
    timers.forEach(clearTimeout);
    timers.clear();
    // Read again after a form submission; never infer that a save succeeded or
    // change balances optimistically. Slow requests are covered by focus/polling.
    for (const delay of [2000, 7000]) {
      const timer = setTimeout(() => { timers.delete(timer); setRefreshVersion((n) => n + 1); }, delay);
      timers.add(timer);
    }
  };
  return (
    <div className="space-y-5" onSubmitCapture={afterSubmit}>
      <PurchaseOverviewPanel key={props.initialPersonId} personId={props.initialPersonId}
        locale={props.locale || "ar"} selfServiceOnly={Boolean(props.selfServiceOnly)} refreshVersion={refreshVersion} />
      <OperatorMoneyLedgerClient {...props} />
    </div>
  );
}

function PurchaseOverviewPanel({ personId, locale, selfServiceOnly, refreshVersion }: {
  personId: string; locale: string; selfServiceOnly: boolean; refreshVersion: number;
}) {
  const [activeLocale, setActiveLocale] = useState(locale);
  const [data, setData] = useState<PurchaseOverview | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const requestId = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const ar = activeLocale === "ar";
  const t = (en: string, arabic: string) => ar ? arabic : en;

  useEffect(() => {
    const sync = () => {
      const language = document.documentElement.lang;
      setActiveLocale(language === "en" || language === "ar" ? language : locale);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang", "dir"] });
    return () => observer.disconnect();
  }, [locale]);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    setLoading(true);
    try {
      const params = new URLSearchParams({ personId, page: String(page) });
      if (selfServiceOnly) params.set("selfOnly", "1");
      const response = await fetch(`/api/operator-money/overview?${params}`, {
        cache: "no-store", signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok || body.success !== true || body.personId !== personId || !body.selected || !Array.isArray(body.history)) {
        throw new Error("Overview unavailable");
      }
      if (current !== requestId.current) return;
      setData(body as PurchaseOverview);
      setError(false);
    } catch {
      if (current !== requestId.current) return;
      setData(null); // Unverified balances must never turn into zero or look current.
      setError(true);
    } finally {
      clearTimeout(timeout);
      if (current === requestId.current) setLoading(false);
    }
  }, [personId, page, selfServiceOnly]);

  useEffect(() => {
    void load();
    const whenVisible = () => { if (document.visibilityState === "visible") void load(); };
    const timer = setInterval(whenVisible, 30_000);
    window.addEventListener("focus", whenVisible);
    document.addEventListener("visibilitychange", whenVisible);
    return () => {
      ++requestId.current;
      activeRequest.current?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", whenVisible);
      document.removeEventListener("visibilitychange", whenVisible);
    };
  }, [load, refreshVersion]);

  return (
    <section dir={ar ? "rtl" : "ltr"} className="surface-card min-w-0 space-y-4 p-4 sm:p-5" aria-busy={loading}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{t("Personal purchases — all periods", "المشتريات الشخصية — جميع الفترات")}</h2>
          <p className="mt-1 text-sm text-slate-500">
            {t("Older unpaid purchases stay visible when you change the period below.", "تبقى المشتريات القديمة غير المسددة ظاهرة عند تغيير الفترة في الأسفل.")}
          </p>
        </div>
        <button type="button" className="btn-secondary" disabled={loading} onClick={() => void load()}>
          {loading ? t("Checking…", "جارٍ التحقق…") : t("Refresh", "تحديث")}
        </button>
      </div>
      {error ? (
        <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          {t("The balance could not be verified. Refresh to retry; this does not mean the balance is zero. The forms below remain available.",
            "تعذر التحقق من الرصيد. اضغط تحديث للمحاولة؛ هذا لا يعني أن الرصيد صفر. تظل النماذج في الأسفل متاحة.")}
        </p>
      ) : !data ? <p role="status" className="text-sm text-slate-500">{t("Loading verified balances…", "جارٍ تحميل الأرصدة المؤكدة…")}</p> : null}
      {data ? <>
        <div className="text-sm font-semibold">{data.selected.name}</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Balance label={t("Total outstanding", "إجمالي المتبقي")} value={data.selected.outstanding} strong />
          <Balance label={t(`This month (${data.month})`, `هذا الشهر (${data.month})`)} value={data.selected.currentMonthOutstanding} />
          <Balance label={t("Earlier months", "الأشهر السابقة")} value={data.selected.earlierOutstanding} />
        </div>
        {data.selected.otherOutstanding > 0 ? <p className="text-sm text-amber-800">
          {t("Other-dated purchases included in the total: ", "مشتريات بتواريخ أخرى مشمولة في الإجمالي: ")}{money(data.selected.otherOutstanding)}
        </p> : null}
        <p className="text-xs text-slate-500">
          {t("All-time purchase value: ", "قيمة المشتريات منذ البداية: ")}{money(data.selected.charged)}
          {" · "}{t("Paid: ", "المسدد: ")}{money(data.selected.paid)}
          {" · "}{t("Units taken: ", "عدد المنتجات المأخوذة: ")}{data.selected.units}
        </p>
        {data.manager && !selfServiceOnly ? <TeamSummary people={data.people} ar={ar} personId={personId} /> : null}
        <details className="rounded-xl border border-slate-200">
          <summary className="cursor-pointer p-3 text-sm font-semibold">
            {t("Purchase history & storage deductions", "سجل المشتريات وخصم المخزون")} ({data.historyCount})
          </summary>
          <div className="space-y-3 border-t p-3">
            <p className="text-xs text-slate-500">
              {t("All periods. Stock deduction and payment are separate: paying later never deducts stock again.",
                "جميع الفترات. خصم المخزون والسداد منفصلان: السداد لاحقاً لا يخصم المخزون مرة ثانية.")}
            </p>
            {!data.history.length ? <p className="text-sm">{t("No personal purchases recorded.", "لا توجد مشتريات شخصية مسجلة.")}</p> : null}
            {data.history.map((row) => <PurchaseEvidence key={row.id} row={row} ar={ar} />)}
            {data.pages > 1 ? <div className="flex items-center justify-between gap-3 text-sm">
              <button type="button" className="btn-secondary" disabled={loading || data.page <= 1} onClick={() => setPage(data.page - 1)}>{t("Previous", "السابق")}</button>
              <span>{data.page} / {data.pages}</span>
              <button type="button" className="btn-secondary" disabled={loading || data.page >= data.pages} onClick={() => setPage(data.page + 1)}>{t("Next", "التالي")}</button>
            </div> : null}
          </div>
        </details>
        <p className="text-xs text-slate-400">
          {t("Checked: ", "آخر تحقق: ")}<time dateTime={data.checkedAt}>{new Date(data.checkedAt).toLocaleString(ar ? "ar-LY" : "en-GB", { timeZone: "Africa/Tripoli" })}</time>
          {" · "}{t("Refreshes every 30 seconds while visible.", "يتحدث كل 30 ثانية أثناء عرض الصفحة.")}
        </p>
      </> : null}
    </section>
  );
}

function Balance({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return <div className={`rounded-xl border p-3 ${strong ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
    <div className="text-xs text-slate-600">{label}</div><div className="mt-1 text-xl font-bold tabular-nums" dir="ltr">{money(value)}</div>
  </div>;
}

function TeamSummary({ people, ar, personId }: { people: PurchaseTotals[]; ar: boolean; personId: string }) {
  const t = (en: string, arabic: string) => ar ? arabic : en;
  return <details className="rounded-xl border border-slate-200">
    <summary className="cursor-pointer p-3 text-sm font-semibold">{t("All operators — all periods", "جميع المشغّلين — جميع الفترات")}</summary>
    <div className="overflow-x-auto border-t">
      <table className="w-full min-w-[38rem] text-start text-sm">
        <thead className="bg-slate-50"><tr>
          {[t("Operator", "المشغّل"), t("Units", "المنتجات"), t("Purchase value", "قيمة المشتريات"), t("Paid", "المسدد"), t("Outstanding", "المتبقي")].map((title) => <th key={title} className="p-3 text-start">{title}</th>)}
        </tr></thead>
        <tbody>{people.map((person) => <tr key={person.personId} className={person.personId === personId ? "border-t bg-amber-50/50" : "border-t"}>
          <td className="p-3"><a className="font-semibold underline underline-offset-2" href={`/team/${encodeURIComponent(person.personId)}/money`}>{person.name || t("Team member", "عضو فريق")}</a>
            {!person.active ? <span className="ms-2 text-xs text-slate-500">{t("Inactive", "غير نشط")}</span> : null}</td>
          <td className="p-3 tabular-nums">{person.units}</td><td className="p-3 tabular-nums">{money(person.charged)}</td>
          <td className="p-3 tabular-nums">{money(person.paid)}</td><td className="p-3 font-bold tabular-nums">{money(person.outstanding)}</td>
        </tr>)}</tbody>
      </table>
      {!people.length ? <p className="p-3 text-sm">{t("No operator records.", "لا توجد سجلات للمشغّلين.")}</p> : null}
    </div>
  </details>;
}

function PurchaseEvidence({ row, ar }: { row: PurchaseHistoryRow; ar: boolean }) {
  const t = (en: string, arabic: string) => ar ? arabic : en;
  const proofText = {
    deducted: t(`${row.proof.quantity} units deducted from storage`, `تم خصم ${row.proof.quantity} من المخزن`),
    missing: t("Storage movement missing — review needed", "حركة المخزون مفقودة — تحتاج مراجعة"),
    mismatch: t("Storage movement does not match — review needed", "حركة المخزون غير مطابقة — تحتاج مراجعة"),
    reversed: t("Storage movement was reversed — review needed", "تم عكس حركة المخزون — تحتاج مراجعة"),
    unavailable: t("Storage proof temporarily unavailable", "تعذر التحقق من حركة المخزون مؤقتاً"),
  }[row.proof.status];
  const paid = row.outstanding === 0 ? t("Paid", "مسدد") : row.paid > 0 ? t("Partially paid", "مسدد جزئياً") : t("Unpaid", "غير مسدد");
  return <article className="space-y-2 rounded-xl border border-slate-200 p-3">
    <div className="flex flex-wrap justify-between gap-2"><strong>{row.product} × {row.quantity}</strong><span className="tabular-nums">{money(row.charged)}</span></div>
    <div className="text-xs text-slate-500">{new Date(row.purchasedAt).toLocaleString(ar ? "ar-LY" : "en-GB", { timeZone: "Africa/Tripoli" })}</div>
    <div className="flex flex-wrap gap-2 text-xs">
      <span className={`rounded-lg px-2 py-1 ${row.proof.status === "deducted" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>{proofText}</span>
      <span className="rounded-lg bg-slate-100 px-2 py-1">{t("Payment: ", "السداد: ")}{paid}{row.outstanding > 0 ? ` · ${money(row.outstanding)}` : ""}</span>
    </div>
    {row.proof.status === "deducted" ? <details className="text-xs">
      <summary className="cursor-pointer font-semibold underline underline-offset-2">{t("View linked stock movement", "عرض حركة المخزون المرتبطة")}</summary>
      <dl className="mt-2 grid gap-1 rounded-lg bg-slate-50 p-3">
        <dt className="text-slate-500">{t("Movement ID", "رقم الحركة")}</dt><dd className="break-all font-mono" dir="ltr">{row.proof.movementId}</dd>
        <dt className="text-slate-500">{t("Source", "المصدر")}</dt><dd>{row.proof.storageName || t("Storage", "المخزن")}</dd>
        <dt className="text-slate-500">{t("Destination", "الوجهة")}</dt><dd>{t("Personal purchase (not refill stock)", "شراء شخصي (ليس مخزون تعبئة)")}</dd>
        <dt className="text-slate-500">{t("Recorded in inventory", "تاريخ تسجيل حركة المخزون")}</dt><dd>{new Date(row.proof.recordedAt!).toLocaleString(ar ? "ar-LY" : "en-GB", { timeZone: "Africa/Tripoli" })}</dd>
      </dl>
    </details> : null}
  </article>;
}
