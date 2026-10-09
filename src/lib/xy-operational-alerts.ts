import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { getXyLiveSalesConfig } from "@/lib/xy-live-sales-sync";
import { lastSaleTimestamp, noSalesFor24Hours, verifiedSalesCoverage, xyOperationalAlertEventKey } from "@/lib/xy-operational-alert-rules";

type Db = NonNullable<ReturnType<typeof getSupabaseAdminClient>>;
type Notice = {
  kind: string;
  scope: string;
  episode: string;
  type: string;
  title: string;
  message: string;
  titleAr: string;
  messageAr: string;
  url: string;
  sourceId?: string;
};
type Machine = {
  id: string; name: string; machine_code: string | null; status: string;
  vms_machine_id: string | null; vms_online_status: string | null;
  last_vms_status_at: string | null; created_at: string;
};

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function dateMs(value: unknown): number | null {
  const valueMs = Date.parse(String(value ?? ""));
  return Number.isFinite(valueMs) ? valueMs : null;
}

function reportError(error: { message?: string } | null, task: string) {
  if (error) throw new Error(`XY alert scan ${task} failed: ${error.message ?? "unknown database error"}`);
}

function simpleNotice(kind: string, scope: string, episode: string, title: string, message: string, titleAr: string, messageAr: string, url = "/admin/vms-api", sourceId?: string): Notice {
  return { kind, scope, episode, type: kind, title, message, titleAr, messageAr, url, sourceId };
}

/**
 * Read-only operational scan; creates records in Snacky OS's existing in-app
 * notification bell, NOT phone push, email, or ChatGPT reminders.
 * It is safe to retry every ten minutes: the existing unique event_key
 * constraint makes delivery idempotent across concurrently running workers.
 */
export async function scanXyOperationalAlerts(options: { now?: Date } = {}) {
  const db = getSupabaseAdminClient();
  if (!db) throw new Error("XY operational notifications unavailable: no service database");
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const thirtyMinutesAgo = new Date(nowMs - 30 * MINUTE).toISOString();
  const notices: Notice[] = [];

  const [
    ownersResult, machinesResult, activeStockResult, stockRunResult,
    activeBatchResult, salesRunResult, lastSalesSuccessResult,
    productQueueResult, selectionQueueResult,
  ] = await Promise.all([
    db.from("profiles").select("id,role,roles").eq("active_status", "active"),
    db.from("machines").select("id,name,machine_code,status,vms_machine_id,vms_online_status,last_vms_status_at,created_at").not("vms_machine_id", "is", null).eq("status", "active"),
    db.from("latest_vms_stock_by_slot").select("machine_id").eq("source_provider", "xy").limit(2000),
    db.from("vms_sync_runs").select("id,status,completed_at,response_summary,created_at").eq("provider", "xy").eq("sync_type", "machine_goods").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("vms_import_batches").select("id,imported_at").eq("source_type", "api").eq("report_type", "stock").eq("is_active", true).order("imported_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("vms_sync_runs").select("id,status,completed_at,response_summary").eq("provider", "xy_web").eq("sync_type", "sales_live").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("vms_sync_runs").select("id").eq("provider", "xy_web").eq("sync_type", "sales_live").in("status", ["completed", "completed_with_warnings"]).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("xy_pending_slot_changes").select("id,machine_id,slot_code,status,last_error,created_at").in("status", ["pending", "conflict"]).order("created_at", { ascending: false }).limit(200),
    db.from("xy_stop_quantity_syncs").select("id,machine_id,slot_code,status,last_error,created_at").in("status", ["pending", "conflict"]).order("created_at", { ascending: false }).limit(200),
  ]);
  for (const [label,result] of [
    ["owners",ownersResult], ["machines",machinesResult],["active machine stock",activeStockResult],
    ["stock sync",stockRunResult],["active stock batch",activeBatchResult],
    ["sales sync",salesRunResult],["last successful sales sync",lastSalesSuccessResult],
    ["product queue",productQueueResult],["selection queue",selectionQueueResult],
  ] as Array<[string,{error:{message:string}|null}]>) reportError(result.error, label);

  const owners = (ownersResult.data ?? []).filter((profile) =>
    profile.role === "owner" || (Array.isArray(profile.roles) && profile.roles.includes("owner")));
  if (!owners.length) return { checked: true, ownerCount: 0, created: 0, existing: 0, alerts: 0 };

  const machines = (machinesResult.data ?? []) as Machine[];
  const nameById = new Map(machines.map((machine) => [machine.id, machine.name]));
  const stockedMachineIds = new Set((activeStockResult.data ?? []).map((row) => String(row.machine_id ?? "")).filter(Boolean));
  const active = activeBatchResult.data;
  const activeMs = dateMs(active?.imported_at);

  // These mean the import pipeline is unavailable, not that there were no sales.
  if (activeMs === null || nowMs - activeMs > 30 * MINUTE) {
    notices.push(simpleNotice(
      "xy_stock_stale", "global", String(active?.id ?? "none"),
      "XY inventory updates are delayed",
      "No verified XY inventory batch became active during the last 30 minutes. Route quantities may be outdated.",
      "تأخر تحديث مخزون XY",
      "لم يتم تفعيل بيانات مخزون مؤكدة من XY خلال آخر 30 دقيقة. قد تكون كميات جولات التعبئة قديمة.",
    ));
  }

  const stockSummary = (stockRunResult.data?.response_summary ?? {}) as Record<string, unknown>;
  const validation = (stockSummary.laneValidation ?? {}) as Record<string, unknown>;
  const fallback = Array.isArray(validation.stale_verified_fallback_details) ? validation.stale_verified_fallback_details : [];
  for (const item of fallback.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const row = item as { machine?: unknown; slot?: unknown; verified_at?: unknown };
    const vmsId = String(row.machine ?? "").trim();
    const slotCode = String(row.slot ?? "").trim();
    const lastVerifiedAt = String(row.verified_at ?? "").trim();
    if (!vmsId || !slotCode || !lastVerifiedAt) continue;
    const machine = machines.find((entry) => entry.vms_machine_id === vmsId);
    const machineName = machine?.name ?? vmsId;
    notices.push(simpleNotice(
      "xy_lane_stale", `${vmsId}:${slotCode}`, lastVerifiedAt,
      `XY inventory needs review: ${machineName}`,
      `Selection ${slotCode} has an impossible XY quantity. Snacky uses its last verified value, not a live reading. Correct the stock or capacity in XY.`,
      `مخزون XY يحتاج مراجعة: ${machineName}`,
      `الخانة ${slotCode} ترجع كمية غير صحيحة من XY. يعرض سناكي آخر كمية مؤكدة وليس قراءة مباشرة. يرجى تصحيح الكمية أو السعة.`,
      "/admin/vms-api", machine?.id,
    ));
  }

  for (const machine of machines) {
    // No-stock registered/standby machines are not necessarily operating.
    if (!stockedMachineIds.has(machine.id)) continue;
    const statusAt = dateMs(machine.last_vms_status_at);
    if (statusAt === null || nowMs - statusAt > 30 * MINUTE) {
      notices.push(simpleNotice(
        "xy_machine_status_stale", machine.id, String(machine.last_vms_status_at ?? "never"),
        `XY status is outdated: ${machine.name}`,
        "No verified machine connection status in the last 30 minutes. Check XY before treating the machine as online.",
        `حالة الماكينة غير محدثة: ${machine.name}`,
        "لم تصل حالة اتصال مؤكدة من XY خلال آخر 30 دقيقة. يرجى التأكد من حالة الماكينة.",
        "/machines/status",machine.id,
      ));
      continue;
    }
    if (machine.vms_online_status === "0") {
      const lastOnline = await db.from("vms_machine_status_snapshots")
        .select("captured_at").eq("machine_id", machine.id).eq("network_status", "1")
        .order("captured_at", { ascending: false }).limit(1).maybeSingle();
      reportError(lastOnline.error, "last online status");
      notices.push(simpleNotice(
        "xy_machine_offline", machine.id, String(lastOnline.data?.captured_at ?? "never-online"),
        `Machine reported offline: ${machine.name}`,
        "XY currently reports this stocked machine as offline. Check power and network connection.",
        `الماكينة غير متصلة: ${machine.name}`,
        "تفيد XY بأن هذه الماكينة غير متصلة حالياً. يرجى فحص الكهرباء والإنترنت.",
        "/machines/status",machine.id,
      ));
    }
  }

  for (const [kind,rows] of [
    ["Product/price",productQueueResult.data ?? []],
    ["Selection stock/price",selectionQueueResult.data ?? []],
  ] as const) {
    for (const row of rows) {
      if (row.status === "pending" && String(row.created_at ?? "") > thirtyMinutesAgo) continue;
      const name = nameById.get(String(row.machine_id)) ?? "Unknown machine";
      notices.push(simpleNotice(
        row.status === "conflict" ? "xy_write_conflict" : "xy_write_delayed",
        String(row.id), row.status === "conflict" ? "conflict" : "delayed-30m",
        `XY change requires attention: ${name}`,
        `${kind} update at selection ${row.slot_code ?? "?"} is ${row.status === "conflict" ? "in conflict" : "still unverified after 30 minutes"}.${row.last_error ? " " + String(row.last_error).slice(0, 170) : ""}`,
        `تعديل XY يحتاج متابعة: ${name}`,
        `تعديل ${kind === "Product/price" ? "المنتج أو السعر" : "المخزون أو السعر"} للخانة ${row.slot_code ?? "؟"} ${row.status === "conflict" ? "فشل أو تعارض" : "لم يتم تأكيده منذ 30 دقيقة"}.`,
      ));
    }
  }

  const salesConfig = getXyLiveSalesConfig();
  const latestSales = salesRunResult.data;
  const summary = (latestSales?.response_summary ?? {}) as Record<string, unknown>;
  const salesReady = salesConfig.ready && verifiedSalesCoverage({
    status: latestSales?.status ?? null,
    completed_at: latestSales?.completed_at ?? null,
    range_start: typeof summary.range_start === "string" ? summary.range_start : null,
    range_end: typeof summary.range_end === "string" ? summary.range_end : null,
    fetched_rows: Number(summary.fetched_rows ?? 0),
    mapped_machine_rows: Number(summary.mapped_machine_rows ?? 0),
    coverage_complete: summary.coverage_complete === true,
  }, nowMs);

  if (!salesReady) {
    notices.push(simpleNotice(
      "xy_sales_feed_unavailable", "global", String(lastSalesSuccessResult.data?.id ?? "never-ready"),
      "Automatic XY sales monitoring is unavailable",
      "Sales data is disabled, delayed, incomplete or unverified. Snacky will NOT claim a machine made no sales until its XY transaction feed is verified.",
      "تعذر التحقق من مبيعات XY التلقائية",
      "بيانات المبيعات غير مفعلة أو متأخرة أو غير مكتملة. لن يعتبر سناكي أن الماكينة لم تبع إلا بعد التأكد من مصدر العمليات.",
    ));
  } else {
    // Only once a complete, recent XY transaction-window is verified can an
    // absence of sales be treated as a meaningful signal.
    for (const machine of machines) {
      if (!stockedMachineIds.has(machine.id)) continue;
      if (machine.vms_online_status !== "1") continue;
      const [payment,delivery] = await Promise.all([
        db.from("vms_transactions_raw").select("payment_time,delivery_time")
          .eq("mapped_machine_id",machine.id).eq("transaction_status","successful_sale")
          .order("payment_time",{ascending:false,nullsFirst:false}).limit(1).maybeSingle(),
        db.from("vms_transactions_raw").select("payment_time,delivery_time")
          .eq("mapped_machine_id",machine.id).eq("transaction_status","successful_sale")
          .order("delivery_time",{ascending:false,nullsFirst:false}).limit(1).maybeSingle(),
      ]);
      reportError(payment.error,"payment-time sales");
      reportError(delivery.error,"delivery-time sales");
      const latestAt = Math.max(
        lastSaleTimestamp(payment.data) ?? 0,
        lastSaleTimestamp(delivery.data) ?? 0,
      ) || null;
      if (!noSalesFor24Hours(latestAt, dateMs(machine.created_at) ?? Number.NaN, nowMs)) continue;
      const recentAtLabel = latestAt ? new Date(latestAt).toISOString() : "no-history";
      notices.push(simpleNotice(
        "xy_machine_no_sales_24h", machine.id, recentAtLabel,
        `No sales for 24 hours: ${machine.name}`,
        "XY's verified live transaction feed contains no successful sale for this machine in the past 24 hours. Inspect the machine and payment system.",
        `لا توجد مبيعات منذ 24 ساعة: ${machine.name}`,
        "لم تُسجّل بيانات XY المؤكدة أي عملية بيع ناجحة لهذه الماكينة خلال آخر 24 ساعة. يرجى فحص الماكينة ونظام الدفع.",
        "/sales", machine.id,
      ));
    }
  }

  let created = 0;
  let existing = 0;
  // Notifications.event_key has a unique partial index. Treat collisions as
  // already delivered; never update read_at or repeatedly push to a phone.
  for (const owner of owners) {
    for (const notice of notices) {
      const eventKey = xyOperationalAlertEventKey(notice.kind, `${owner.id}:${notice.scope}`, notice.episode);
      const { error } = await db.from("notifications").insert({
        user_id: owner.id,
        type: notice.type,
        title: notice.title,
        message: notice.message,
        title_ar: notice.titleAr,
        message_ar: notice.messageAr,
        action_url: notice.url,
        related_route_id: null,
        source_kind: "xy_operational_alert",
        source_id: notice.sourceId ?? null,
        event_key: eventKey,
      });
      if (error?.code === "23505") { existing++; continue; }
      reportError(error,"persist in-app notification");
      created++;
    }
  }
  return { checked: true, ownerCount: owners.length, created, existing, alerts: notices.length, salesMonitoringReady: salesReady };
}
