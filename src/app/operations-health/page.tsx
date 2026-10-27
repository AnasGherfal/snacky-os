import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { DataHealthActionButton } from "@/components/DataHealthActionButton";
import { OperatorBagReconcileControl } from "@/components/OperatorBagReconcileControl";
import { OwnerDailyCloseoutActionCenter } from "@/components/OwnerDailyCloseoutActionCenter";
import { OwnerCashCustodyAuditPanel } from "@/components/OwnerCashCustodyAuditPanel";
import { readOwnerCashCustodyAudit } from "@/lib/owner-cash-custody-source";
import { readOwnerDueRouteCloseout } from "@/lib/owner-closeout-source";
import { getAuthenticatedSupabaseServerClient, getCurrentProfile } from "@/lib/auth";
import { hasAnyRole } from "@/lib/authz";
import { getServerI18n } from "@/lib/i18n/server";
import { ROUTE_INVENTORY_OPEN_STATUSES } from "@/lib/route-inventory-discrepancies";

export const dynamic = "force-dynamic";

function fmt(value: unknown) {
  if (!value) return "-";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Tripoli" }).format(d);
}
function daysAgo(days:number){const d=new Date();d.setUTCDate(d.getUTCDate()-days);return d.toISOString();}
function verifiedCount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export default async function OperationsHealthPage() {
  const profile=await getCurrentProfile();
  if(!profile||profile.active_status!=="active"||!hasAnyRole(profile,["owner","admin"]))redirect("/unauthorized");
  const db=await getAuthenticatedSupabaseServerClient();
  if(!db)return <EmptyState title="Data Health unavailable" body="The signed-in database session is unavailable."/>;

  const { locale } = await getServerI18n();
  const ar = locale === "ar";
  const tr = (en: string, arabic: string) => ar ? arabic : en;

  const tripoliDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const todayStart = `${tripoliDate}T00:00:00+02:00`;
  const tomorrowStart = new Date(Date.parse(todayStart) + 86400000).toISOString();
  const [
    todayCashResult,todayCashUncountedResult,todayRoutesResult,
    workspaceResult,machinesResult,locationsResult,currentCashResult,
    routeDiscrepanciesResult,cashSourceGapsResult,
    allCashWithoutCountResult,cashReconciliationReviewResult,dueRouteCloseoutResult,cashCustodyAuditResult,
  ] = await Promise.all([
    db.from("cash_collections").select("id",{count:"exact",head:true})
      .is("voided_at",null).gte("collected_at",todayStart).lt("collected_at",tomorrowStart),
    db.from("cash_collections").select("id",{count:"exact",head:true})
      .is("voided_at",null).gte("collected_at",todayStart).lt("collected_at",tomorrowStart)
      .is("counted_at",null),
    db.from("routes").select("id",{count:"exact",head:true})
      .gte("route_date",tripoliDate).lte("route_date",tripoliDate)
      .not("status","in", "(cancelled,canceled,voided)"),
    db.rpc("snacky_data_health_workspace_v1"),
    db.from("machines").select("id,machine_code,name,status,location_id,location:locations(id,name,address,distance_from_storage_km)").order("machine_code"),
    db.from("locations").select("id,name,address,status,distance_from_storage_km").eq("status","active").order("name"),
    db.from("cash_collections").select("id",{count:"exact",head:true}).is("voided_at",null).in("reconciliation_status",["pending","variance_review"]).gte("collected_at",daysAgo(30)).lt("collected_at",daysAgo(3)),
    db.from("route_inventory_discrepancies").select("id",{count:"exact",head:true}).in("status",[...ROUTE_INVENTORY_OPEN_STATUSES]),
    db.from("cash_collections").select("id",{count:"exact",head:true}).is("voided_at",null).in("reconciliation_status",["pending","variance_review"]).is("expected_source",null),
    db.from("cash_collections").select("id",{count:"exact",head:true})
      .is("voided_at",null).not("collected_at","is",null).is("counted_at",null),
    db.from("cash_collections").select("id",{count:"exact",head:true})
      .is("voided_at",null).in("reconciliation_status",["pending","variance_review"]),
    readOwnerDueRouteCloseout(db,tripoliDate),
    readOwnerCashCustodyAudit(db),
  ]);
  const todayCashCount = !todayCashResult.error && typeof todayCashResult.count === "number" ? todayCashResult.count : null;
  const todayCashUncounted = !todayCashUncountedResult.error && typeof todayCashUncountedResult.count === "number" ? todayCashUncountedResult.count : null;
  const todayRouteCount = !todayRoutesResult.error && typeof todayRoutesResult.count === "number" ? todayRoutesResult.count : null;
  const allCashWithoutCount = !allCashWithoutCountResult.error && typeof allCashWithoutCountResult.count === "number"
    ? allCashWithoutCountResult.count : null;
  const cashReconciliationReviewCount = !cashReconciliationReviewResult.error && typeof cashReconciliationReviewResult.count === "number"
    ? cashReconciliationReviewResult.count : null;



  if(workspaceResult.error||!workspaceResult.data||typeof workspaceResult.data!=="object"){
    console.error("[data-health] Workspace unavailable",workspaceResult.error);
    // Closeout is a separate read-only source; keep it usable when the
    // legacy cleanup RPC is unavailable. NEVER show a green "no issues"
    // state for a workspace that could not be verified.
    return <div className="space-y-6">
      <PageHeader title={tr("Data Health", "صحة البيانات")}
        subtitle={tr("Owner daily closeout and operational checks", "ملخص الإغلاق اليومي ومراجعة التشغيل")}
        action={<SecondaryButton href="/dashboard">{tr("Dashboard", "لوحة التحكم")}</SecondaryButton>} />
      <OwnerDailyCloseoutActionCenter
        locale={locale}
        date={tripoliDate}
        routes={dueRouteCloseoutResult.data}
        todayCashNotCounted={todayCashUncounted}
        allCashNotCounted={allCashWithoutCount}
        pendingCashReviews={cashReconciliationReviewCount}
        openRouteStockDifferences={null}
      />
      <OwnerCashCustodyAuditPanel audit={cashCustodyAuditResult.data} locale={locale} />
      <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        {tr("Data Health cleanup workspace could not be verified. Inventory exception totals and cleanup controls are unavailable; this is not an all-clear.",
          "تعذر التحقق من مساحة تنظيف صحة البيانات. إحصاءات فروقات المخزون وإجراءات التنظيف غير متاحة؛ لا يعني ذلك خلو التشغيل من المشاكل.")}
      </div>
    </div>;
  }

  const data=workspaceResult.data as any,counts=data.counts??{};
  const inventoryHealth=Array.isArray(data.inventory_health)?data.inventory_health:[];
  const staleRefills=Array.isArray(data.stale_refills)?data.stale_refills:[];
  const legacyCash=Array.isArray(data.legacy_cash)?data.legacy_cash:[];
  const vmsCleanup=Array.isArray(data.vms_cleanup)?data.vms_cleanup:[];
  const machineSetupVerified = !machinesResult.error && !locationsResult.error
    && Array.isArray(machinesResult.data) && Array.isArray(locationsResult.data);
  const machines=machinesResult.data??[],locations=locationsResult.data??[];
  const missingMachineLocation=machines.filter((m:any)=>!m.location_id);
  const missingDistance=locations.filter((l:any)=>l.distance_from_storage_km===null||l.distance_from_storage_km===undefined);
  const currentCashCount = !currentCashResult.error && typeof currentCashResult.count === "number"
    ? currentCashResult.count : null;
  const openRouteDiscrepancyCount = !routeDiscrepanciesResult.error && typeof routeDiscrepanciesResult.count === "number"
    ? routeDiscrepanciesResult.count : null;
  const cashSourceGapCount = !cashSourceGapsResult.error && typeof cashSourceGapsResult.count === "number"
    ? cashSourceGapsResult.count : null;

  const negativeInventoryCount = verifiedCount(counts.negative_inventory);
  const safeRefillCancellationCount = verifiedCount(counts.safe_refill_cancellations);
  const recentVmsAttentionCount = verifiedCount(counts.vms_recent_attention);
  const cards=[
    ...(openRouteDiscrepancyCount !== null ? [["Open route stock differences",openRouteDiscrepancyCount,"/routes/inventory-review"] as const] : []),
    ...(cashSourceGapCount !== null ? [["Cash missing expected-source verification",cashSourceGapCount,"/cash-collections"] as const] : []),
    ...(machineSetupVerified ? [["Machines missing site",missingMachineLocation.length,"/machines/setup"] as const] : []),
    ...(machineSetupVerified ? [["Active sites missing distance",missingDistance.length,"/machines/setup"] as const] : []),
    ...(negativeInventoryCount !== null ? [["Negative stock balances",negativeInventoryCount,"#inventory-health"] as const] : []),
    ...(safeRefillCancellationCount !== null ? [["Safe stale refill cancellations",safeRefillCancellationCount,"#stale-refills"] as const] : []),
    ...(currentCashCount !== null ? [["Cash actions 3–30 days old",currentCashCount,"/cash-collections/action-queue"] as const] : []),
    ...(recentVmsAttentionCount !== null ? [["Recent VMS failures / partial",recentVmsAttentionCount,"#vms-health"] as const] : []),
  ] as const;
  const labelsAr: Record<string, string> = {
    "Open route stock differences": "فروقات مخزون الجولات المفتوحة",
    "Cash missing expected-source verification": "نقد يحتاج إلى التحقق من مصدره المتوقع",
    "Machines missing site": "أجهزة دون موقع مسجل",
    "Active sites missing distance": "مواقع نشطة دون مسافة مسجلة",
    "Negative stock balances": "أرصدة مخزون سالبة",
    "Safe stale refill cancellations": "طلبات تعبئة قديمة قابلة للإلغاء الآمن",
    "Cash actions 3–30 days old": "مهام نقد متأخرة من ٣ إلى ٣٠ يوماً",
    "Recent VMS failures / partial": "استيرادات VMS فاشلة أو غير مكتملة",
    "Today's cash removals": "تحصيلات النقد اليوم",
    "Today's cash bags awaiting count": "أكياس النقد بانتظار العد اليوم",
    "Today's routes recorded": "الجولات المسجلة اليوم",
  };
  const uiLabel = (en: string) => ar ? labelsAr[en] ?? en : en;
  const activeCards=cards.filter(([,value])=>value>0);
  const dataHealthCountsIncomplete = !machineSetupVerified || currentCashCount === null
    || openRouteDiscrepancyCount === null || cashSourceGapCount === null
    || todayCashCount === null || todayCashUncounted === null || todayRouteCount === null
    || negativeInventoryCount === null || safeRefillCancellationCount === null
    || recentVmsAttentionCount === null
    || allCashWithoutCount === null || cashReconciliationReviewCount === null
    || !dueRouteCloseoutResult.data;

  return <div className="space-y-6">
    <PageHeader title={tr("Data Health", "صحة البيانات")} subtitle={tr("Fix operational exceptions safely. Cleanup preserves audit history.", "راجع الحالات التشغيلية دون فقدان سجل المراجعة أو إجراء تعديلات تلقائية.")} action={<div className="flex flex-wrap gap-2"><SecondaryButton href="/machines/setup">{tr("Machine setup", "إعداد الأجهزة")}</SecondaryButton><SecondaryButton href="/dashboard">{tr("Dashboard", "لوحة التحكم")}</SecondaryButton></div>}/>

    <OwnerDailyCloseoutActionCenter
      locale={locale}
      date={tripoliDate}
      routes={dueRouteCloseoutResult.data}
      todayCashNotCounted={todayCashUncounted}
      allCashNotCounted={allCashWithoutCount}
      pendingCashReviews={cashReconciliationReviewCount}
      openRouteStockDifferences={openRouteDiscrepancyCount}
    />
    <OwnerCashCustodyAuditPanel audit={cashCustodyAuditResult.data} locale={locale} />

    <section aria-label={tr("Daily closeout", "الإغلاق اليومي")} className="surface-card space-y-3 border-t-4 border-t-emerald-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="text-lg font-semibold">{tr("Daily owner closeout", "ملخص الإغلاق اليومي")} · <span dir="ltr" className="inline-block tabular-nums">{tripoliDate}</span></h2>
        <p className="mt-1 text-sm text-slate-600">{tr("Read-only counts in Tripoli time. Recorded activity does not prove that every task was completed.", "أرقام للعرض فقط بتوقيت طرابلس. تسجيل الحركة لا يعني اكتمال جميع المهام.")}</p></div>
        <div className="flex flex-wrap gap-2"><SecondaryButton href="/cash-collections/action-queue">{tr("Cash action queue", "مهام النقد")}</SecondaryButton><SecondaryButton href="/routes/inventory-review">{tr("Inventory differences", "فروقات المخزون")}</SecondaryButton></div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {([
          ["Today's cash removals",todayCashCount,"/cash-collections"],
          ["Today's cash bags awaiting count",todayCashUncounted,"/cash-collections/action-queue"],
          ["Today's routes recorded",todayRouteCount,"/routes"],
        ] as const).map(([label,count,href])=><Link key={label} href={href} className="rounded-lg border border-slate-200 p-4">
          <div className="text-xs font-medium text-slate-600">{uiLabel(label)}</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{count === null ? tr("Unverified", "غير مؤكد") : count}</div>
          <div className="mt-2 text-xs font-semibold text-emerald-800">{tr("Review records", "عرض السجلات")}</div>
        </Link>)}
      </div>
      {todayCashCount === null || todayCashUncounted === null || todayRouteCount === null ? (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{tr("One or more daily closeout sources could not be verified. Unknown counts are not shown as zero.", "تعذر التحقق من أحد مصادر الإغلاق اليومي. لا تُعرض الأرقام غير المعروفة كأنها صفر.")}</p>
      ) : null}
      <p className="text-xs leading-5 text-slate-500">{tr("Older cash, unpaid purchases, sales sources and stock exceptions remain in the review sections below. This snapshot never posts cash, closes routes or changes stock.", "تبقى مهام النقد السابقة والمشتريات غير المدفوعة ومصادر المبيعات وفروقات المخزون في الأقسام أدناه. هذا الملخص لا يثبت النقد أو يغلق الجولات أو يغير المخزون.")}</p>
    </section>

    {(currentCashCount === null || !machineSetupVerified) ? (
      <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        {currentCashCount === null ? "Historical cash action count could not be verified. " : ""}
        {!machineSetupVerified ? "Machine and location setup data could not be verified." : ""}
        {" "}Unknown counts are never treated as zero.
      </p>
    ) : null}
    {(openRouteDiscrepancyCount === null || cashSourceGapCount === null) ? (
      <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
        {openRouteDiscrepancyCount === null ? <>Route inventory discrepancy totals could not be verified. They have not been treated as zero. <Link className="underline underline-offset-2" href="/routes/inventory-review">Review route differences</Link>. </> : null}
        {cashSourceGapCount === null ? <>Cash expected-source coverage could not be verified. Missing data has not been treated as zero. <Link className="underline underline-offset-2" href="/cash-collections">Review cash records</Link>.</> : null}
      </div>
    ) : null}

    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {activeCards.length?activeCards.map(([label,value,href])=><Link key={label} href={href}
        className="group rounded-xl border border-slate-200 border-s-4 border-s-amber-400 bg-white p-4 shadow-sm transition-colors hover:border-emerald-400 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">
        <div className="text-xs font-semibold text-slate-600">{uiLabel(label)}</div>
        <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-950">{value}</div>
        <div className="mt-2 text-xs font-semibold text-emerald-800">{tr("Review records", "عرض السجلات")}</div>
      </Link>):<div role={dataHealthCountsIncomplete ? "alert" : "status"} className={dataHealthCountsIncomplete
        ? "rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900"
        : "rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800"}>
        {dataHealthCountsIncomplete ? tr("Some data-health counts are unverified. Do not treat an empty list as an all-clear.", "بعض إحصاءات صحة البيانات غير مؤكدة؛ لا تعتبر القائمة الفارغة دليلاً على خلوها من المشاكل.") : tr("No active data-health exceptions.", "لا توجد مشاكل ظاهرة في سجلات صحة البيانات المتاحة.")}
      </div>}
    </section>

    <section className="surface-card">
      <div className="mb-4"><h2 className="text-lg font-semibold">{tr("Machine & location setup", "إعداد الأجهزة والمواقع")}</h2><p className="mt-1 text-sm text-slate-500">{tr("Every operating machine needs its real current site; every active site should have one-way distance from storage.", "كل جهاز عامل يحتاج إلى موقعه الفعلي، وكل موقع نشط يحتاج إلى المسافة باتجاه واحد من المخزن.")}</p></div>
      {!machineSetupVerified ? (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Machine and location setup could not be verified. No missing-site totals have been assumed to be zero.
        </p>
      ) : !missingMachineLocation.length&&!missingDistance.length?<EmptyState title="Machine setup is complete" body="Every machine has a site and every active site has a distance."/>:
      <div className="grid gap-5 xl:grid-cols-2">
        <div><h3 className="mb-2 font-medium">Machines without site</h3>{missingMachineLocation.map((m:any)=><div key={m.id} className="mb-2 rounded-lg border p-3"><strong>{m.name}</strong><p className="text-xs text-slate-500">{m.machine_code} · {m.status}</p></div>)}</div>
        <div><h3 className="mb-2 font-medium">Sites missing distance</h3>{missingDistance.map((l:any)=><div key={l.id} className="mb-2 rounded-lg border p-3"><strong>{l.name}</strong><p className="text-xs text-slate-500">{l.address??"No address recorded"}</p></div>)}</div>
      </div>}
    </section>

    <section className="surface-card" id="inventory-health">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold">Inventory integrity</h2><p className="mt-1 text-sm text-slate-500">A negative balance becomes an audit case. Snacky OS never invents stock to make the warning disappear.</p></div>
        <div className="flex flex-wrap gap-2"><DataHealthActionButton action="scan_negative_inventory" label="Scan / refresh cases" requiresReason={false}/><SecondaryButton href="/inventory/reconciliation">Inventory reconciliation</SecondaryButton></div>
      </div>
      {!inventoryHealth.length?<EmptyState title="No open inventory health cases" body="Scan when a negative balance appears; corrected cases stay open until you close them with a note."/>:
      <DataTable headers={["Location","Product","Current qty","Case","Action"]}>{inventoryHealth.slice(0,50).map((row:any,index:number)=><tr key={row.case_id??[row.location_type,row.location_id,row.product_id,index].join("-")}>
        <td><div className="font-medium">{row.location_name??"-"}</div><div className="text-xs text-slate-500">{row.location_type}</div></td>
        <td>
          <div>{row.product_name}</div>
          {row.location_type==="operator_bag" && row.location_id && row.product_id ? (
            <Link className="mt-1 inline-block text-xs font-semibold text-emerald-800 underline underline-offset-2"
              href={`/inventory/movements?product_id=${encodeURIComponent(String(row.product_id))}&bag_id=${encodeURIComponent(String(row.location_id))}`}>
              Review exact bag movements
            </Link>
          ) : null}
        </td>
        <td className={Number(row.current_quantity??0)<0?"font-semibold text-rose-700":"font-semibold text-emerald-700"}>{row.current_quantity??0}</td>
        <td>{row.case_id?<StatusBadge status={row.ready_to_resolve?"corrected_waiting_close":"open"}/>:<span className="text-xs text-amber-700">Scan cases first</span>}</td>
        <td>{row.ready_to_resolve&&row.case_id?<DataHealthActionButton action="resolve_inventory_case" targetId={row.case_id} label="Close corrected case" defaultReason="Physical and ledger balance verified after correction"/>:row.case_id&&row.location_type==="operator_bag"&&Number(row.current_quantity??0)<0?<OperatorBagReconcileControl caseId={row.case_id} currentQty={Number(row.current_quantity??0)} operatorName={row.location_name??"Operator"} productName={row.product_name??"Product"}/>:<Link className="link-secondary" href="/inventory/reconciliation">Review inventory</Link>}</td>
      </tr>)}</DataTable>}
    </section>

    <section className="surface-card" id="stale-refills">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Stale refill orders</h2><p className="mt-1 text-sm text-slate-500">{Number(counts.safe_refill_cancellations??0)>0?Number(counts.safe_refill_cancellations)+" can be cancelled safely. ":""}{Number(counts.picked_refill_review??0)>0?Number(counts.picked_refill_review)+" picked orders remain review-only because physical custody may already exist.":""}</p></div>{Number(counts.safe_refill_cancellations??0)>0?<DataHealthActionButton action="bulk_cancel_stale_refills" label={"Cancel all "+Number(counts.safe_refill_cancellations)+" safe stale refills"} defaultReason="Bulk cleanup of obsolete refill orders with no inventory movement and no active route"/>:null}</div>
      {!staleRefills.length?<EmptyState title="No stale refill work" body="All unfinished refill orders are recent."/>:
      <DataTable headers={["Generated","Machine","Refill","Route","Ledger","Action"]}>{staleRefills.slice(0,50).map((row:any)=><tr key={row.id}>
        <td>{fmt(row.generated_at)}</td><td>{row.machine_name??row.machine_code??row.machine_id??"-"}</td><td><StatusBadge status={row.status}/></td>
        <td>{row.route_id?<><StatusBadge status={row.route_status??"unknown"}/> <Link className="link-secondary" href={"/routes/"+row.route_id}>Route</Link></>:"No route"}</td>
        <td>{row.has_movements?"Inventory movements exist":"No linked inventory movement"}</td>
        <td>{row.can_cancel?<DataHealthActionButton action="cancel_stale_refill" targetId={row.id} label="Cancel stale refill" defaultReason="Obsolete refill order; no inventory movement and no active route"/>:<span className="text-xs font-medium text-amber-700">{row.status==="picked"?"Picked stock requires manual inventory review":"Cancellation blocked by safety checks"}</span>}</td>
      </tr>)}</DataTable>}
    </section>

    <section className="surface-card">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Cash backlog classification</h2><p className="mt-1 text-sm text-slate-500">Classification does not reconcile cash, change amounts, or post Finance. It only separates historical backlog from current controls. Missing expected-source information does not establish a cash shortage.</p></div><div className="flex flex-wrap gap-2"><SecondaryButton href="/cash-collections/action-queue">Current cash actions</SecondaryButton><SecondaryButton href="/cash-collections">All cash</SecondaryButton></div></div>
      {((currentCashCount !== null && currentCashCount > 0)||Number(counts.legacy_cash_unclassified??0)>0||Number(counts.legacy_cash_classified??0)>0)?<div className="mb-4 grid gap-3 sm:grid-cols-3">{(currentCashCount !== null && currentCashCount > 0)?<div className="rounded-xl border border-amber-200 bg-amber-50 p-3"><div className="text-xs">Current 3–30 day actions</div><strong className="text-2xl">{currentCashCount}</strong></div>:null}{Number(counts.legacy_cash_unclassified??0)>0?<div className="rounded-xl border p-3"><div className="text-xs">Legacy unclassified</div><strong className="text-2xl">{Number(counts.legacy_cash_unclassified)}</strong></div>:null}{Number(counts.legacy_cash_classified??0)>0?<div className="rounded-xl border bg-slate-50 p-3"><div className="text-xs">Legacy classified</div><strong className="text-2xl">{Number(counts.legacy_cash_classified)}</strong></div>:null}</div>:null}
      {!legacyCash.length?<EmptyState title="No legacy cash backlog" body="Older unresolved cash has been cleared or classified."/>:
      <DataTable headers={["Collected","Custody","Reconciliation","Counted","Expected","Classification","Action"]}>{legacyCash.slice(0,50).map((row:any)=><tr key={row.id}>
        <td>{fmt(row.collected_at)}</td><td><StatusBadge status={row.custody_status}/></td><td><StatusBadge status={row.reconciliation_status}/></td><td>{row.actual_cash_collected??"-"}</td><td>{row.vms_expected_cash??"-"}</td>
        <td>{row.classification==="legacy_backlog"?<><strong>Legacy backlog</strong><div className="text-xs text-slate-500">{row.classification_reason}</div></>:"Unclassified"}</td>
        <td>{row.classification==="legacy_backlog"?<DataHealthActionButton action="unclassify_legacy_cash" targetId={row.id} label="Restore to legacy queue" requiresReason={false}/>:<DataHealthActionButton action="classify_legacy_cash" targetId={row.id} label="Mark legacy backlog" defaultReason="Historical record predates current cash reconciliation controls"/>}</td>
      </tr>)}</DataTable>}
    </section>

    <section className="surface-card" id="vms-health">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">VMS health & cleanup</h2><p className="mt-1 text-sm text-slate-500">Only old, inactive batches with zero imported rows can be archived here. Recent partial imports stay visible for repair.</p></div><div className="flex flex-wrap gap-2">{Number(counts.vms_cleanup_candidates??0)>0?<DataHealthActionButton action="bulk_archive_vms_batches" label={"Archive all "+Number(counts.vms_cleanup_candidates)+" safe batches"} defaultReason="Bulk cleanup of abandoned inactive zero-import VMS batches"/>:null}<SecondaryButton href="/vms-import">Open VMS imports</SecondaryButton></div></div>
      {(Number(counts.vms_recent_attention??0)>0||Number(counts.vms_cleanup_candidates??0)>0)?<div className="mb-4 grid gap-3 sm:grid-cols-2">{Number(counts.vms_recent_attention??0)>0?<div className="rounded-xl border border-rose-200 bg-rose-50 p-3"><div className="text-xs">Recent failures / partial / warnings</div><strong className="text-2xl">{Number(counts.vms_recent_attention)}</strong></div>:null}{Number(counts.vms_cleanup_candidates??0)>0?<div className="rounded-xl border p-3"><div className="text-xs">Safe archive candidates</div><strong className="text-2xl">{Number(counts.vms_cleanup_candidates)}</strong></div>:null}</div>:null}
      {!vmsCleanup.length?<EmptyState title="No VMS cleanup items" body="There are no recent problem batches or old abandoned batches."/>:
      <DataTable headers={["Uploaded","File","Type","Status","Imported","Errors","Review","Action"]}>{vmsCleanup.slice(0,60).map((row:any)=><tr key={row.id}>
        <td>{fmt(row.uploaded_at)}</td><td>{row.original_file_name??row.file_name??"-"}</td><td>{row.report_type??"-"}</td><td><StatusBadge status={row.status}/></td><td>{Number(row.rows_imported??0)}</td><td>{Number(row.error_count??0)}</td><td>{Number(row.rows_needing_review??0)}</td>
        <td>{row.can_archive?<DataHealthActionButton action="archive_vms_batch" targetId={row.id} label="Archive abandoned batch" defaultReason="Abandoned zero-import VMS batch; archived from Data Health"/>:<Link className="link-secondary" href={"/vms-import/"+row.id}>Review batch</Link>}</td>
      </tr>)}</DataTable>}
    </section>
  </div>;
}
