import Link from "next/link";
import { readCompleteList } from "@/lib/complete-list-read";
import { classifyPaymentTender, xyTransactionIdentity, cashAmountCents, withinCashInterval, tripoliHourKey } from "@/lib/cash-interval-model";
import { redirect } from "next/navigation";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { canAccessPath, canViewFinancials } from "@/lib/authz";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { PageHeader, SecondaryButton, ErrorState } from "@/components/ui";
import { getServerI18n } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

type CashRow = {
  id: string;
  machine_id: string | null;
  operator_id: string | null;
  collected_at: string;
  actual_cash_collected: number | string | null;
  cash_bag_id: string | null;
  custody_status: string;
  voided_at: string | null;
};
type MachineLine = {
  cash_collection_id: string;
  machine_id: string;
  removal_type: string;
  compartments: string[];
  expectation_metadata?: Record<string, unknown> | null;
};
type RawSale = {
  id: string;
  import_batch_id: string;
  created_at: string;
  machine_code: string | null;
  order_number: string | null;
  third_party_transaction_number: string | null;
  duplicate_hash: string | null;
  payment_time: string | null;
  delivery_time: string | null;
  payment_amount: number | string | null;
  transaction_status: string;
  raw_row: Record<string, unknown> | null;
  normalized_row: Record<string, unknown> | null;
};
type ImportBatch = {
  id: string;
  status: string;
  deleted_at: string | null;
  is_active: boolean | null;
  imported_at: string | null;
};
type Hour = { label: string; cash: number; card: number; unknown: number; transactions: number };
type XyPreview = {
  status: "no_data" | "partial" | "error";
  cash: number | null;
  card: number | null;
  unknown: number | null;
  numberOfSales: number;
  unknownMethods: number;
  unknownAmounts: number;
  hours: Hour[];
  error?: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const cashStatuses = new Set(["imported", "imported_with_warnings", "partially_imported"]);
const formatter = (locale: "en" | "ar") => new Intl.DateTimeFormat(locale === "ar" ? "ar-LY" : "en-GB", {
  timeZone: "Africa/Tripoli", dateStyle: "medium", timeStyle: "medium", hour12: false,
});
function timestamp(value: string | null | undefined, locale: "en" | "ar") {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : formatter(locale).format(d);
}
const money = (value: number | string | null) => value == null ? "—" :
  `${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} LYD`;
function classifyPayment(row: RawSale): "cash" | "card" | "unknown" {
  const pick = (obj: Record<string, unknown> | null, keys: string[]) => {
    for (const key of keys) {
      const value = obj?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  const keys = ["mode_of_payment", "Mode of payment", "Mode of Payment", "payment_method", "payment_type", "paymentMethod", "Payment Method", "Payment method",
    "Payment Type", "payment", "Payment", "tender", "Tender", "method", "Method"];
  const value = (pick(row.normalized_row, keys) || pick(row.raw_row, keys)).toLowerCase().replace(/\s+/g, " ");
  return classifyPaymentTender(value);
}

async function loadDetailedXyPreview(
  db: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  machineId: string,
  start: string,
  end: string,
): Promise<XyPreview> {
  // Pagination is bounded and fail-closed. This is a read-only exploratory preview;
  // the authoritative Finance reconciliation never uses these numbers automatically.
  const rows: RawSale[] = [];
  const readSignal = AbortSignal.timeout(10000);
  const fields = "id,import_batch_id,created_at,machine_code,order_number,third_party_transaction_number,duplicate_hash,payment_time,delivery_time,payment_amount,transaction_status,raw_row,normalized_row";
  for (const source of ["payment", "delivery"] as const) {
    const result = await readCompleteList<RawSale>(({from,to,signal}) => {
      let query = db.from("vms_transactions_raw").select(fields,{count:"exact"}).eq("mapped_machine_id",machineId);
      query = source === "payment"
        ? query.gt("payment_time",start).lte("payment_time",end)
        : query.is("payment_time",null).gt("delivery_time",start).lte("delivery_time",end);
      return query.order("created_at",{ascending:false}).order("id").range(from,to).abortSignal(signal);
    }, {key:row=>row.id,maxRows:10000,signal:readSignal});
    if (result.error) return {status:"error",cash:null,card:null,unknown:null,numberOfSales:0,unknownMethods:0,unknownAmounts:0,hours:[],
      error:"The complete XY interval could not be verified. No partial cash total is shown."};
    rows.push(...result.data);
  }
  if (!rows.length) return { status: "no_data", cash: null, card: null, unknown: null,
    numberOfSales: 0, unknownMethods: 0, unknownAmounts: 0, hours: [] };

  const batchIds = [...new Set(rows.map(row => row.import_batch_id).filter(Boolean))];
  const batches = new Map<string, ImportBatch>();
  for (let n = 0; n < batchIds.length; n += 100) {
    const { data, error } = await db.from("vms_import_batches")
      .select("id,status,deleted_at,is_active,imported_at").in("id", batchIds.slice(n, n + 100)).abortSignal(readSignal);
    if (error) return { status: "error", cash: null, card: null, unknown: null,
      numberOfSales: 0, unknownMethods: 0, unknownAmounts: 0, hours: [],
      error: "XY source provenance could not be checked." };
    (data ?? []).forEach(item => batches.set(item.id, item as ImportBatch));
  }
  const eligible = rows.filter(row => {
    const batch = batches.get(row.import_batch_id);
    return batch && cashStatuses.has(batch.status) && batch.deleted_at === null && batch.is_active !== false;
  });
  if (!eligible.length) return { status: "no_data", cash: null, card: null, unknown: null,
    numberOfSales: 0, unknownMethods: 0, unknownAmounts: 0, hours: [] };
  eligible.sort((a, b) => {
    const left = Date.parse(batches.get(a.import_batch_id)?.imported_at ?? a.created_at);
    const right = Date.parse(batches.get(b.import_batch_id)?.imported_at ?? b.created_at);
    return right - left || Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id);
  });
  const seen = new Set<string>();
  const hourly = new Map<string, Hour>();
  let cashCents = 0, cardCents = 0, unknownCents = 0, unknownMethods = 0, unknownAmounts = 0, numberOfSales = 0;
  for (const row of eligible) {
    const key = xyTransactionIdentity(row);
    if (seen.has(key)) continue;
    seen.add(key);
    // Latest imported state wins BEFORE eligibility: a later refund/failed
    // delivery cannot revive an older successful row for the same order.
    if (row.transaction_status !== "successful_sale") continue;
    const time = row.payment_time ?? row.delivery_time;
    if (!time || !withinCashInterval(time, start, end)) continue;
    const category = classifyPayment(row);
    const cents = cashAmountCents(row.payment_amount);
    if (cents === null) {
      unknownAmounts++;
      continue;
    }
    numberOfSales++;
    if (category === "unknown") unknownMethods++;
    const hourKey = tripoliHourKey(time);
    const hour = hourly.get(hourKey) ?? { label: hourKey, cash: 0, card: 0, unknown: 0, transactions: 0 };
    hour.transactions++;
    hour[category] += cents;
    hourly.set(hourKey, hour);
    if (category === "cash") cashCents += cents;
    else if (category === "card") cardCents += cents;
    else unknownCents += cents;
  }
  if (!numberOfSales && !unknownAmounts) return { status: "no_data", cash: null, card: null, unknown: null,
    numberOfSales: 0, unknownMethods: 0, unknownAmounts: 0, hours: [] };
  return {
    status: "partial", cash: cashCents / 100, card: cardCents / 100, unknown: unknownCents / 100,
    numberOfSales, unknownMethods, unknownAmounts,
    hours: [...hourly.values()].sort((a, b) => a.label.localeCompare(b.label))
      .map(hour => ({ ...hour, cash: hour.cash / 100, card: hour.card / 100, unknown: hour.unknown / 100 })),
  };
}

export default async function CashIntervalComparisonPage({
  searchParams,
}: {
  searchParams: Promise<{ collection?: string }>;
}) {
  const { locale } = await getServerI18n();
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const profile = await getCurrentProfile();
  const context = profile ? {
    id: profile.id, role: profile.role, roles: profile.roles, canAddProducts: profile.can_add_products,
    teamMemberId: profile.team_member_id, activeStatus: profile.active_status,
  } : null;
  if (!context || !canViewFinancials(context) || !canAccessPath(context, "/cash-collections"))
    redirect("/unauthorized");

  const client = await getAuthenticatedSupabaseServerClient();
  const db = getSupabaseAdminClient();
  if (!client || !db) return <ErrorState title={tr("Cash data unavailable", "بيانات النقد غير متاحة")} body={tr("Cash sources could not be accessed.", "تعذر الوصول لمصادر النقد.")} />;
  const params = await searchParams;
  const requested = String(params.collection ?? "");
  const { data: recent, error: recentError } = await client.from("cash_collections")
    .select("id,machine_id,operator_id,collected_at,actual_cash_collected,cash_bag_id,custody_status,voided_at")
    .not("actual_cash_collected", "is", null).is("voided_at", null)
    .order("collected_at", { ascending: false }).limit(40);
  if (recentError) return <ErrorState title={tr("Cash collections unavailable", "تعذر تحميل سحوبات النقد")} body={tr("Please refresh and retry.", "حدّث الصفحة وحاول مرة أخرى.")} />;
  const list = (recent ?? []) as CashRow[];
  const selectedId = uuid.test(requested) ? requested : list[0]?.id ?? null;
  const specific = selectedId && !list.some(row => row.id === selectedId)
    ? await client.from("cash_collections").select("id,machine_id,operator_id,collected_at,actual_cash_collected,cash_bag_id,custody_status,voided_at").eq("id", selectedId).maybeSingle()
    : null;
  if (specific?.error) return <ErrorState title="Cash record unavailable" body="This record could not be read." />;
  const selected = (list.find(row => row.id === selectedId) ?? specific?.data ?? null) as CashRow | null;
  if (!selected || selected.voided_at) {
    return <ErrorState title={tr("Cash pickup not found", "السحب غير موجود")} body={tr("Choose a counted removal from the cash history.", "اختر سحباً تم عدّه من سجل النقد.")} />;
  }
  const machineIds = [...new Set(list.map(row => row.machine_id).filter(Boolean))] as string[];
  if (selected.machine_id && !machineIds.includes(selected.machine_id)) machineIds.push(selected.machine_id);
  const operatorIds = [...new Set(list.map(row => row.operator_id).filter(Boolean))] as string[];
  const [machinesResult,operatorsResult, previousResult, lineResult, latestSalesResult] = await Promise.all([
    client.from("machines").select("id,name").in("id",machineIds),
    operatorIds.length ? client.from("team_members").select("id,full_name").in("id",operatorIds) : Promise.resolve({ data: [], error: null }),
    selected.machine_id ? client.from("cash_collections")
      .select("id,machine_id,operator_id,collected_at,actual_cash_collected,cash_bag_id,custody_status,voided_at")
      .eq("machine_id",selected.machine_id).is("voided_at",null).lt("collected_at",selected.collected_at)
      .order("collected_at",{ascending:false}).limit(1).maybeSingle() : Promise.resolve({ data: null, error: null }),
    db.from("cash_collection_machines").select("cash_collection_id,machine_id,removal_type,compartments,expectation_metadata")
      .eq("cash_collection_id",selected.id),
    db.from("vms_transactions_raw").select("payment_time,delivery_time")
      .not("payment_time","is",null).order("payment_time",{ascending:false}).limit(1),
  ]);
  const machineById = new Map((machinesResult.data ?? []).map(x=>[x.id,x.name]));
  const operatorById = new Map((operatorsResult.data ?? []).map(x=>[x.id,x.full_name]));
  const previous = previousResult.error ? null : (previousResult.data as CashRow | null);
  const endAt = selected.collected_at;
  const startAt = previous?.collected_at ?? null;
  const currentLine = ((lineResult.data ?? []) as MachineLine[]).find(x=>x.machine_id===selected.machine_id);
  const previousLineResult = previous ? await db.from("cash_collection_machines")
    .select("cash_collection_id,machine_id,removal_type,compartments,expectation_metadata")
    .eq("cash_collection_id",previous.id).eq("machine_id",selected.machine_id).maybeSingle()
    : { data: null, error: null };
  const prevLine = previousLineResult.data as MachineLine | null;
  const previousMayBeFull = prevLine?.removal_type === "full";
  const metadata = prevLine?.expectation_metadata ?? {};
  const previousTimeIsOnlyProxy = Boolean(
    metadata.removal_time_placeholder ||
    metadata.collected_at_is_noon_placeholder ||
    metadata.interval_end_is_date_only_placeholder ||
    metadata.time_proxy ||
    metadata.actual_removal_time_unknown ||
    metadata.exact_removal_time_unknown
  );
  const compartmentsVerified = Boolean(currentLine?.compartments?.includes("notes") && currentLine?.compartments?.includes("coins"));
  const lastImportTime = latestSalesResult.data?.[0]?.payment_time ?? null;

  const preview = startAt && selected.machine_id
    ? await loadDetailedXyPreview(db,selected.machine_id,startAt,endAt)
    : null;

  return (
    <div className="space-y-6" dir={ar?"rtl":"ltr"}>
      <PageHeader title={tr("XY cash comparison by pickup time", "مقارنة نقد XY حسب ساعة السحب")}
        subtitle={tr(
          "Read-only preview: compare each counted collection with machine cash sales after its previous pickup and up to its exact removal timestamp. Dates alone are not cash intervals.",
          "مقارنة للعرض فقط: نقد الماكينة بعد السحب السابق وحتى لحظة السحب الحالي بالساعة والدقيقة. تجميع اليوم بالكامل غير صحيح."
        )}
        breadcrumbs={[{label:tr("Cash custody","النقدية"),href:"/cash-collections"},{label:tr("Exact pickup intervals","فترات السحب الدقيقة")}]}
        action={<div className="flex flex-wrap gap-2">
          <SecondaryButton href="/cash-collections">{tr("Cash history","سجل النقد")}</SecondaryButton>
          <SecondaryButton href="/vms-import">{tr("Import XY transactions","استيراد معاملات XY")}</SecondaryButton>
        </div>}/>
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <strong>{tr("XY data availability", "توفر بيانات XY")}</strong>
        <p className="mt-1">{lastImportTime
          ? tr(`Latest imported timestamped XY payment: ${timestamp(lastImportTime,locale)} (Tripoli). Recent stock snapshots and monthly profit totals do not replace exact transaction timestamps.`,
               `آخر عملية دفع مفصلة مستوردة من XY: ${timestamp(lastImportTime,locale)} بتوقيت طرابلس. جرد الماكينات أو أرباح الشهر لا يحلان محل معاملات دقيقة بالساعة.`)
          : tr("No timestamped XY payment feed is currently available. A zero in a monthly sales total must not be treated as missing cash.",
               "لا توجد معاملات دفع مفصلة بوقت البيع حالياً؛ عدم وجود البيانات لا يعني عجزاً نقدياً.")}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <section className="surface-card h-fit p-4">
          <h2 className="mb-3 font-bold">{tr("Counted pickups", "السحوبات التي تم عدّها")}</h2>
          <div className="space-y-2">
            {list.map(row=><Link key={row.id} href={`/cash-collections/interval-comparison?collection=${row.id}`}
              className={`block rounded-lg border p-3 text-sm ${row.id===selected.id?"border-emerald-500 bg-emerald-50":"border-slate-200 bg-white hover:border-emerald-300"}`}>
              <div className="font-semibold">{machineById.get(row.machine_id??"") ?? tr("Machine","ماكينة")}</div>
              <div className="mt-1 text-slate-600">{timestamp(row.collected_at,locale)}</div>
              <div className="mt-1 flex justify-between gap-2"><span>{operatorById.get(row.operator_id??"")??"—"}</span><strong>{money(row.actual_cash_collected)}</strong></div>
            </Link>)}
          </div>
        </section>
        <section className="space-y-4">
          <div className="surface-card p-5">
            <h2 className="text-xl font-bold text-slate-950">{machineById.get(selected.machine_id??"")??tr("Selected machine","الماكينة المختارة")}</h2>
            <p className="mt-2 text-sm text-slate-500">{tr("Collected by","سحب بواسطة")} {operatorById.get(selected.operator_id??"")??"—"}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{tr("Previous pickup — EXCLUSIVE start","السحب السابق — بداية غير شاملة")}</div>
                <div className="mt-1 font-bold">{timestamp(startAt,locale)}</div>
                <p className="mt-1 text-xs text-slate-500">{previous
                  ? previousTimeIsOnlyProxy
                    ? tr("⚠ Previous recorded time is a PLACEHOLDER/route arrival, not a verified removal time. Hourly totals cannot be certified.", "⚠ توقيت السحب السابق تقريبي أو وقت وصول الجولة، وليس وقت سحب النقد المؤكد. لا تعتمد نتيجة المقارنة بالساعة.")
                    : tr("Recorded machine pickup time; confirm it is the actual cash-clearance time.", "وقت السحب المسجل؛ تأكد أنه وقت تفريغ النقد الفعلي.")
                  : tr("No previous pickup found. Interval start unknown.","لم يوجد سحب سابق؛ بداية الفترة غير معلومة.")}</p>
              </div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <div className="text-xs text-emerald-800">{tr("Current pickup — INCLUSIVE cutoff","السحب الحالي — نهاية شاملة")}</div>
                <div className="mt-1 font-bold">{timestamp(endAt,locale)}</div>
                <p className="mt-1 text-xs text-emerald-900">{tr("Sales strictly AFTER this timestamp belong to the NEXT pickup.","أي مبيعات بعد هذا الوقت تخص السحب القادم.")}</p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-slate-50 p-4"><p className="text-xs text-slate-500">{tr("Anas's physical cash count","العد الفعلي بواسطة أنس")}</p><strong className="mt-1 block text-xl">{money(selected.actual_cash_collected)}</strong></div>
              <div className="rounded-lg bg-slate-50 p-4"><p className="text-xs text-slate-500">{tr("XY cash in exact interval","نقد XY في نفس الفترة")}</p><strong className="mt-1 block text-xl">{preview?.status==="partial" && preview.unknownAmounts===0?money(preview.cash):tr("Not available","غير متاح")}</strong></div>
              <div className="rounded-lg bg-slate-50 p-4"><p className="text-xs text-slate-500">{tr("Confirmed cash difference","الفرق النقدي المؤكد")}</p><strong className="mt-1 block text-xl">{tr("Not verified","غير مؤكد")}</strong></div>
            </div>
            <p className="mt-4 text-sm leading-6 text-slate-700">
              {tr("Only successful cash payments belong in an expected cashbox figure; card transactions must be excluded. XY is previewed by exact timestamps, but source coverage, partial pickups, float/coins, refunds, and manual repair sales must be verified before concluding money is missing.",
                  "النقد المتوقع يعتمد على عمليات الدفع النقدي الناجحة فقط؛ معاملات البطاقة مستبعدة. العرض يحترم وقت السحب بالثانية، لكن يجب التأكد من اكتمال بيانات XY وحالة سحب الفكة والعملات والمبيعات اليدوية والاستردادات قبل اعتبار أي مبلغ ناقصاً.")}
            </p>
            {(!startAt||previousTimeIsOnlyProxy||!previousMayBeFull||!compartmentsVerified)?<div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              {tr("Evidence limitation: ", "نقص في التوثيق: ")}
              {!startAt?tr("No previous pickup timestamp is available. ","لا يوجد وقت سحب سابق. "):null}
              {previousTimeIsOnlyProxy?tr("Previous cash pickup time is a placeholder, so hourly start is uncertain. ","وقت السحب السابق تقريبي، لذلك بداية الفترة بالساعة غير مؤكدة. "):null}
              {startAt&&!previousMayBeFull?tr("Previous pickup is not documented as a full cash clearance. ","السحب السابق غير موثّق كسحب كامل. "):null}
              {!compartmentsVerified?tr("Notes/coins compartments are not both documented as cleared. ","تفريغ صندوق الأوراق والعملات غير موثق بالكامل. "):null}
              {tr("These limits prevent treating an indicative sales difference as a proven shortage.",
                  "لا يمكن اعتبار الفرق الظاهر عجزاً مؤكداً قبل معالجة ذلك.")}
            </div>:null}
            <Link href={`/cash-collections/${selected.id}`} className="link-secondary mt-4 inline-flex">{tr("View original cash receipt & audit","عرض إيصال السحب وسجل المراجعة")} →</Link>
          </div>
          {preview?.status==="error"?<div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">{preview.error}</div>:null}
          {preview?.status==="no_data"?<div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <strong>{tr("No usable XY transaction records in this exact interval", "لا توجد معاملات XY مفصلة صالحة لهذه الفترة")}</strong>
            <p className="mt-2">{tr("This means XY data are missing, NOT that there were zero sales and NOT that cash is missing. Export XY order/transaction details including machine ID, payment time, payment type, amount, status, and refunds; import the file into Snacky OS.",
                  "هذا يعني أن بيانات XY غير متاحة، وليس أن المبيعات صفر أو أن هناك عجزاً نقدياً. صدّر تفاصيل معاملات XY التي تتضمن الماكينة ووقت الدفع ونوع الدفع والمبلغ والحالة والاستردادات، ثم استوردها في سناكي.")}</p>
            <Link className="btn-secondary mt-3 inline-flex" href="/vms-import">{tr("Import transaction details","استيراد تفاصيل المعاملات")}</Link>
          </div>:null}
          {preview?.status==="partial"?<>
            <div className="surface-card p-4">
              <h3 className="text-lg font-semibold">{tr("Provisional XY sales — exact timestamps","مبيعات XY المبدئية — حسب الوقت الفعلي")}</h3>
              <p className="mt-1 text-sm text-slate-600">{tr("Payment feed coverage is not independently certified. Do NOT accept a cash variance from this preview alone.","اكتمال مصدر معاملات الدفع لم يتم التحقق منه بعد؛ لا تعتمد أي فرق نقدي بناءً على هذه المعاينة فقط.")}</p>
              <dl className="mt-3 grid gap-3 sm:grid-cols-4">
                <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs text-slate-500">XY cash</dt><dd className="font-semibold">{money(preview.cash)}</dd></div>
                <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs text-slate-500">XY card</dt><dd className="font-semibold">{money(preview.card)}</dd></div>
                <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs text-slate-500">{tr("Unknown method","طريقة غير معروفة")}</dt><dd className="font-semibold">{money(preview.unknown)}</dd></div>
                <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs text-slate-500">{tr("Successful rows","معاملات ناجحة")}</dt><dd className="font-semibold">{preview.numberOfSales}</dd></div>
              </dl>
              {preview.unknownMethods>0||preview.unknownAmounts>0?<p className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-900">{tr(`${preview.unknownMethods} payments have unknown tender types and ${preview.unknownAmounts} have unusable amounts; this is NOT a complete cash estimate.`,
                `${preview.unknownMethods} عملية بنوع دفع غير معروف و${preview.unknownAmounts} بمبالغ غير قابلة للتحقق؛ لا تعتبر المجموع نقداً مؤكداً.`)}</p>:null}
            </div>
            <div className="surface-card overflow-x-auto p-4">
              <h3 className="mb-3 font-semibold">{tr("Sales by hour — Tripoli local time","المبيعات حسب الساعة — توقيت طرابلس")}</h3>
              <table className="w-full min-w-[550px] text-sm"><thead className="bg-slate-50"><tr>
                <th className="p-2 text-start">{tr("Hour","الساعة")}</th><th className="p-2 text-end">Cash</th><th className="p-2 text-end">Card</th><th className="p-2 text-end">{tr("Unknown","غير معروف")}</th><th className="p-2 text-end">{tr("Transactions","عمليات")}</th>
              </tr></thead><tbody>{preview.hours.map(hour=><tr key={hour.label} className="border-t border-slate-100">
                <td className="p-2">{hour.label}</td><td className="p-2 text-end">{money(hour.cash)}</td><td className="p-2 text-end">{money(hour.card)}</td><td className="p-2 text-end">{money(hour.unknown)}</td><td className="p-2 text-end">{hour.transactions}</td>
              </tr>)}</tbody></table>
            </div>
          </>:null}
          {!startAt?<p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{tr("Exact hourly comparison requires a previous collection timestamp. This is not a daily-total comparison.",
                  "المقارنة بالساعة تحتاج وقت السحب السابق. لن نستخدم مجموع مبيعات اليوم بديلاً عنه.")}</p>:null}
        </section>
      </div>
    </div>
  );
}
