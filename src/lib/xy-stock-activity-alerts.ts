import "server-only";
import { assessXyMachineActivity, XY_MACHINE_ACTIVITY_PROFILES, type XyActivityHistory } from "@/lib/xy-stock-activity-alert-rules";
import type { getSupabaseAdminClient } from "@/lib/supabase-server";

type Database = NonNullable<ReturnType<typeof getSupabaseAdminClient>>;
type Machine = {
  id: string;
  name: string;
  vms_machine_id: string | null;
  vms_online_status: string | null;
  last_vms_status_at: string | null;
};
export type XyStockActivityNotice = {
  kind: string;
  scope: string;
  episode: string;
  type: string;
  title: string;
  titleAr: string;
  message: string;
  messageAr: string;
  url: string;
  sourceId: string;
};

/** Called from the existing secured XY cron. Database history is aggregated
 * server-side; app users cannot query the underlying inventory history RPC.
 * A system fault must never prevent ordinary XY stock/machine-status alerts.
 */
export async function getXyStockActivityNotices(input: {
  db: Database;
  machines: Machine[];
  now: Date;
  activeStockMachineIds: Set<string>;
  activeStockImportedAt: string | null;
}): Promise<XyStockActivityNotice[]> {
  const {db,machines,now,activeStockMachineIds,activeStockImportedAt}=input;
  // The official XY worker runs every 10 minutes. Hourly anomaly checks
  // reduce repetitive heavy 29-day historical SQL computation.
  if(now.getUTCMinutes()>=10) return [];
  const nowMs=now.getTime();
  const activeAt=Date.parse(String(activeStockImportedAt??""));
  if(!Number.isFinite(activeAt) || nowMs-activeAt>25*60*1000) return [];
  const [historyResult,overrideResult]=await Promise.all([
    db.rpc("snacky_xy_stock_activity_history",{p_days:29}),
    db.from("xy_stock_activity_site_overrides")
      .select("machine_id,excluded_dates,pause_through,min_window_hours,min_expected_units"),
  ]);
  if(historyResult.error || overrideResult.error) {
    console.error("[xy-activity] Unable to assess historical inventory signals",
      historyResult.error?.message??overrideResult.error?.message);
    return [];
  }
  const data=historyResult.data;
  type Override = {
    machine_id:string;
    excluded_dates:string[]|null;
    pause_through:string|null;
    min_window_hours:number|null;
    min_expected_units:number|null;
  };
  const overrideById=new Map(((overrideResult.data??[]) as Override[])
    .map(row=>[row.machine_id,row]));
  const byId=new Map(((data??[]) as XyActivityHistory[]).map(row=>[row.machine_id,row]));
  const result:XyStockActivityNotice[]=[];
  for(const machine of machines) {
    if(!machine.vms_machine_id || !activeStockMachineIds.has(machine.id)) continue;
    const base=XY_MACHINE_ACTIVITY_PROFILES[machine.vms_machine_id];
    const override=overrideById.get(machine.id);
    const profile=base && override ? {
      ...base,
      closedDates:[...(base.closedDates??[]),...(override.excluded_dates??[])],
      pausedThrough:override.pause_through,
      minimumHours:Math.max(2,Math.min(base.maximumHours,Number(override.min_window_hours??base.minimumHours))),
      minTypicalUnits:Math.max(1,Math.min(100,Number(override.min_expected_units??base.minTypicalUnits))),
    } : base;
    const history=byId.get(machine.id);
    if(!profile || !history || machine.vms_online_status!=="1") continue;
    const statusAt=Date.parse(String(machine.last_vms_status_at??""));
    if(!Number.isFinite(statusAt) || nowMs-statusAt>25*60*1000) continue;
    const outcome=assessXyMachineActivity({nowMs,profile,history});
    if(outcome.outcome!=="attention") continue;
    const hours=outcome.hours;
    const usualUnits=outcome.usualUnits;
    const venue=machine.name;
    const hospital=outcome.kind==="hospital";
    const siteTypeAr=outcome.kind==="hospital"?"المستشفى"
      :outcome.kind==="mall"?"المجمع التجاري"
      :outcome.kind==="university"?"الجامعة":"المدرسة";
    result.push({
      kind:"xy_stock_activity_gap",
      type:"xy_stock_activity_gap",
      scope:machine.id,
      // After subsequent movement, a new episode can be reported once.
      episode:String(outcome.lastDecreaseAt??"no-known-prior-decrease"),
      title:(hospital?"Priority check":"Unusual inactivity")+": "+venue,
      titleAr:(hospital?"تنبيه مهم: حركة المنتجات متوقفة في ":"انخفاض غير معتاد في حركة المنتجات: ")+venue,
      message:`No inventory reductions observed for ${hours} operating hours at ${venue}. Comparable historical periods typically declined by ~${usualUnits} units (${outcome.evidenceDays} reference days). This may indicate a payment, vend, stock or telemetry issue; it does NOT prove zero sales. Check the machine and XY.`,
      messageAr:`لم يرصد سناكي انخفاضاً في مخزون ${siteTypeAr} «${venue}» خلال ${hours} ساعات تشغيل. في الفترات المشابهة تاريخياً كان المخزون ينخفض بنحو ${usualUnits} منتج (${outcome.evidenceDays} أيام مقارنة). قد يكون السبب الدفع أو الماكينة أو بيانات المخزون، وليس دليلاً قاطعاً على عدم وجود مبيعات. يرجى التحقق.`,
      url:`/machines/${machine.id}`,
      sourceId:machine.id,
    });
  }
  return result;
}
