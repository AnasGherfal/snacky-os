import "server-only";

import { buildMachineRefillForecasts, type RefillFillLine, type RefillMachine, type RefillStockHistory } from "@/lib/refill-forecast";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { notifyRouteAssigned } from "@/lib/notification-delivery";
import {
  ROUTE_ASSIGNED_STATUS,
  ROUTE_DRAFT_STATUS,
  ROUTE_RESERVATION_STATUSES,
} from "@/lib/route-workflow";

type AutomationSettings = {
  enabled: boolean;
  default_operator_id: string | null;
  evaluation_minutes: number;
  batch_window_minutes: number;
  max_wait_minutes: number;
  min_batch_stops: number;
  max_batch_stops: number;
  pickup_refresh_enabled: boolean;
  pickup_refresh_max_age_minutes: number;
};

type QueueRow = {
  id: string;
  machine_id: string;
  state: "pending" | "scheduled" | "resolved" | "dismissed";
  urgency: "fill_now" | "fill_today" | "fill_next_open";
  action_date: string;
  first_triggered_at: string;
  last_triggered_at: string;
  last_evaluated_at: string;
  latest_snapshot_at: string | null;
  stock_percent: number | null;
  units_to_target: number;
  reason: string | null;
  route_id: string | null;
  route_stop_id: string | null;
  scheduled_at: string | null;
};

type ActiveStopRow = {
  id: string;
  route_id: string;
  machine_id: string;
  status: string;
  route?: {
    id?: string | null;
    status?: string | null;
    route_date?: string | null;
    operator_id?: string | null;
    auto_generated?: boolean | null;
    automation_kind?: string | null;
  } | Array<{
    id?: string | null;
    status?: string | null;
    route_date?: string | null;
    operator_id?: string | null;
    auto_generated?: boolean | null;
    automation_kind?: string | null;
  }> | null;
};

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function integer(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function dateKeyInTripoli(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Tripoli",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function urgencyRank(value: string) {
  if (value === "fill_now") return 0;
  if (value === "fill_today") return 1;
  return 2;
}

function snapshotIsAfter(value: string | null | undefined, comparison: string | null | undefined) {
  if (!value || !comparison) return false;
  const a = Date.parse(value);
  const b = Date.parse(comparison);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

function batchKey(now: Date, dateKey: string, operatorId: string | null, windowMinutes: number) {
  const sizeMs = Math.max(10, windowMinutes || 30) * 60_000;
  const bucket = Math.floor(now.getTime() / sizeMs);
  return `refill:${dateKey}:${operatorId ?? "unassigned"}:${bucket}`;
}

async function loadSettings() {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("refill_route_automation_settings")
    .select("enabled, default_operator_id, evaluation_minutes, batch_window_minutes, max_wait_minutes, min_batch_stops, max_batch_stops, pickup_refresh_enabled, pickup_refresh_max_age_minutes")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`Could not load refill automation settings: ${error.message}`);
  return data as AutomationSettings | null;
}

export async function getRefillRouteAutomationSettings() {
  return loadSettings();
}

export async function runRefillRouteAutomation(now = new Date()) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return { enabled: false, reason: "Supabase admin client is unavailable." };
  }

  const settings = await loadSettings();
  if (!settings?.enabled) {
    return { enabled: false, reason: "Refill route automation is disabled." };
  }

  const since = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
  const today = dateKeyInTripoli(now);
  const [
    machinesResult,
    latestResult,
    historyResult,
    fillsResult,
    recommendationsResult,
    activeStopsResult,
    queueResult,
  ] = await Promise.all([
    supabase
      .from("machines")
      .select("id, name, machine_code, status, refill_open_days, refill_critical_percent, refill_today_percent, refill_target_percent, refill_minimum_units, refill_manual_daily_units, location:locations(distance_from_storage_km)")
      .eq("status", "active"),
    supabase
      .from("latest_vms_stock_by_slot")
      .select("machine_id, product_id, slot_code, current_qty, capacity, captured_at, import_batch_id")
      .eq("source_provider", "xy"),
    supabase
      .from("vms_stock_snapshots")
      .select("machine_id, product_id, slot_code, current_qty, capacity, captured_at, import_batch_id, batch:vms_import_batches!inner(status, deleted_at)")
      .eq("source_provider", "xy")
      .eq("import_row_status", "imported")
      .in("batch.status", ["imported", "imported_with_warnings"])
      .gte("captured_at", since),
    supabase
      .from("route_stop_fill_lines")
      .select("machine_id, product_id, actual_qty, created_at")
      .gte("created_at", since),
    supabase
      .from("refill_recommendations")
      .select("machine_id, suggested_qty, final_qty_to_take"),
    supabase
      .from("route_stops")
      .select("id, route_id, machine_id, status, route:routes!inner(id, status, route_date, operator_id, auto_generated, automation_kind)")
      .in("route.status", [...ROUTE_RESERVATION_STATUSES]),
    supabase
      .from("refill_service_queue")
      .select("id, machine_id, state, urgency, action_date, first_triggered_at, last_triggered_at, last_evaluated_at, latest_snapshot_at, stock_percent, units_to_target, reason, route_id, route_stop_id, scheduled_at"),
  ]);

  const queryErrors = [
    machinesResult.error,
    latestResult.error,
    historyResult.error,
    fillsResult.error,
    recommendationsResult.error,
    activeStopsResult.error,
    queueResult.error,
  ].filter(Boolean);
  if (queryErrors.length) {
    throw new Error(`Could not evaluate refill route automation: ${queryErrors.map((error) => error?.message).join(" | ")}`);
  }

  const coverageByMachine = new Map<string, { machineId: string; requestedUnits: number; fillableUnits: number }>();
  (recommendationsResult.data ?? []).forEach((row: any) => {
    const machineId = String(row.machine_id ?? "");
    if (!machineId) return;
    const current = coverageByMachine.get(machineId) ?? { machineId, requestedUnits: 0, fillableUnits: 0 };
    current.requestedUnits += integer(row.suggested_qty);
    current.fillableUnits += integer(row.final_qty_to_take);
    coverageByMachine.set(machineId, current);
  });

  const forecasts = buildMachineRefillForecasts({
    machines: (machinesResult.data ?? []) as RefillMachine[],
    latestStock: (latestResult.data ?? []) as RefillStockHistory[],
    stockHistory: (historyResult.data ?? []) as RefillStockHistory[],
    fills: (fillsResult.data ?? []) as RefillFillLine[],
    storageCoverage: Array.from(coverageByMachine.values()),
    now,
  });

  const queueByMachine = new Map(
    ((queueResult.data ?? []) as QueueRow[]).map((row) => [String(row.machine_id), row]),
  );
  const activeStopByMachine = new Map<string, ActiveStopRow>();
  ((activeStopsResult.data ?? []) as ActiveStopRow[]).forEach((stop) => {
    const machineId = String(stop.machine_id ?? "");
    if (machineId && !activeStopByMachine.has(machineId)) activeStopByMachine.set(machineId, stop);
  });

  const actionableStatuses = new Set(["fill_now", "fill_today", "fill_next_open"]);
  const queueWrites: Record<string, unknown>[] = [];
  const resolveIds: string[] = [];

  forecasts.forEach((forecast) => {
    const existing = queueByMachine.get(forecast.machineId);
    const activeStop = activeStopByMachine.get(forecast.machineId);
    const activeRoute = firstRelation(activeStop?.route);

    if (activeStop && activeRoute?.id) {
      queueWrites.push({
        machine_id: forecast.machineId,
        state: "scheduled",
        urgency: actionableStatuses.has(forecast.status) ? forecast.status : existing?.urgency ?? "fill_today",
        action_date: forecast.actionDate,
        first_triggered_at: existing?.first_triggered_at ?? now.toISOString(),
        last_triggered_at: now.toISOString(),
        last_evaluated_at: now.toISOString(),
        latest_snapshot_at: forecast.latestSnapshotAt,
        stock_percent: forecast.stockPercent,
        units_to_target: forecast.unitsToTarget,
        reason: forecast.reason,
        route_id: String(activeRoute.id),
        route_stop_id: String(activeStop.id),
        scheduled_at: existing?.scheduled_at ?? now.toISOString(),
        resolved_at: null,
        updated_at: now.toISOString(),
        metadata: {
          forecast_status: forecast.status,
          days_to_empty: forecast.daysToEmpty,
          empty_lanes: forecast.emptyLanes,
          average_daily_units: forecast.averageDailyUnits,
        },
      });
      return;
    }

    if (!actionableStatuses.has(forecast.status)) {
      if (existing?.state === "pending") resolveIds.push(existing.id);
      return;
    }

    if (
      existing?.state === "scheduled"
      && existing.scheduled_at
      && !snapshotIsAfter(forecast.latestSnapshotAt, existing.scheduled_at)
    ) {
      return;
    }

    const continuingPending = existing?.state === "pending";
    queueWrites.push({
      machine_id: forecast.machineId,
      state: "pending",
      urgency: forecast.status,
      action_date: forecast.actionDate,
      first_triggered_at: continuingPending ? existing.first_triggered_at : now.toISOString(),
      last_triggered_at: now.toISOString(),
      last_evaluated_at: now.toISOString(),
      latest_snapshot_at: forecast.latestSnapshotAt,
      stock_percent: forecast.stockPercent,
      units_to_target: forecast.unitsToTarget,
      reason: forecast.reason,
      route_id: null,
      route_stop_id: null,
      scheduled_at: null,
      resolved_at: null,
      updated_at: now.toISOString(),
      metadata: {
        forecast_status: forecast.status,
        days_to_empty: forecast.daysToEmpty,
        empty_lanes: forecast.emptyLanes,
        low_lanes: forecast.lowLanes,
        current_units: forecast.currentUnits,
        capacity_units: forecast.capacityUnits,
        average_daily_units: forecast.averageDailyUnits,
        storage_requested_units: forecast.storageRequestedUnits,
        storage_fillable_units: forecast.storageFillableUnits,
      },
    });
  });

  if (queueWrites.length) {
    const { error } = await supabase
      .from("refill_service_queue")
      .upsert(queueWrites, { onConflict: "machine_id" });
    if (error) throw new Error(`Could not update refill service queue: ${error.message}`);
  }

  if (resolveIds.length) {
    const { error } = await supabase
      .from("refill_service_queue")
      .update({ state: "resolved", resolved_at: now.toISOString(), last_evaluated_at: now.toISOString(), updated_at: now.toISOString() })
      .in("id", resolveIds);
    if (error) throw new Error(`Could not resolve stale refill queue rows: ${error.message}`);
  }

  const { data: pendingRows, error: pendingError } = await supabase
    .from("refill_service_queue")
    .select("id, machine_id, state, urgency, action_date, first_triggered_at, last_triggered_at, last_evaluated_at, latest_snapshot_at, stock_percent, units_to_target, reason, route_id, route_stop_id, scheduled_at")
    .eq("state", "pending")
    .lte("action_date", today)
    .order("first_triggered_at", { ascending: true });
  if (pendingError) throw new Error(`Could not load pending refill queue: ${pendingError.message}`);

  const pending = (pendingRows ?? []) as QueueRow[];
  if (!pending.length) {
    return {
      enabled: true,
      evaluatedMachines: forecasts.length,
      queuedMachines: 0,
      routeId: null,
      stopsAdded: 0,
      createdRoute: false,
    };
  }

  let openRouteQuery = supabase
    .from("routes")
    .select("id, route_date, operator_id, status, auto_generated, automation_kind, automation_batch_key, created_at")
    .eq("route_date", today)
    .eq("auto_generated", true)
    .eq("automation_kind", "refill")
    .in("status", [ROUTE_DRAFT_STATUS, ROUTE_ASSIGNED_STATUS])
    .order("created_at", { ascending: false })
    .limit(1);

  openRouteQuery = settings.default_operator_id
    ? openRouteQuery.eq("operator_id", settings.default_operator_id)
    : openRouteQuery.is("operator_id", null);

  const { data: openRouteRows, error: openRouteError } = await openRouteQuery;
  if (openRouteError) throw new Error(`Could not load open automatic refill batch: ${openRouteError.message}`);
  let route = (openRouteRows ?? [])[0] as any | undefined;

  const oldestPendingMs = Math.min(...pending.map((row) => Date.parse(row.first_triggered_at)).filter(Number.isFinite));
  const waitMinutes = Number.isFinite(oldestPendingMs) ? (now.getTime() - oldestPendingMs) / 60_000 : 0;
  const hasCritical = pending.some((row) => row.urgency === "fill_now");
  const shouldCreate = Boolean(route)
    || hasCritical
    || pending.length >= integer(settings.min_batch_stops, 2)
    || waitMinutes >= integer(settings.max_wait_minutes, 60);

  if (!shouldCreate) {
    return {
      enabled: true,
      evaluatedMachines: forecasts.length,
      queuedMachines: pending.length,
      routeId: null,
      stopsAdded: 0,
      createdRoute: false,
      waitingForBatch: true,
      oldestWaitMinutes: Math.round(waitMinutes),
    };
  }

  let createdRoute = false;
  if (!route) {
    const automationBatchKey = batchKey(now, today, settings.default_operator_id, settings.batch_window_minutes);
    const routePayload = {
      route_date: today,
      operator_id: settings.default_operator_id,
      status: settings.default_operator_id ? ROUTE_ASSIGNED_STATUS : ROUTE_DRAFT_STATUS,
      created_by: null,
      notes: "Automatically batched from refill service queue.",
      auto_generated: true,
      automation_kind: "refill",
      automation_batch_key: automationBatchKey,
      automation_last_planned_at: null,
    };
    const { data: created, error: createError } = await supabase
      .from("routes")
      .insert(routePayload)
      .select("id, route_date, operator_id, status, auto_generated, automation_kind, automation_batch_key, created_at")
      .single();

    if (createError) {
      if (createError.code === "23505") {
        const { data: existing, error: existingError } = await supabase
          .from("routes")
          .select("id, route_date, operator_id, status, auto_generated, automation_kind, automation_batch_key, created_at")
          .eq("automation_batch_key", automationBatchKey)
          .maybeSingle();
        if (existingError || !existing) throw new Error(`Could not recover automatic refill batch: ${existingError?.message ?? createError.message}`);
        route = existing;
      } else {
        throw new Error(`Could not create automatic refill route: ${createError.message}`);
      }
    } else {
      route = created;
      createdRoute = true;
    }
  }

  if (!route?.id || ![ROUTE_DRAFT_STATUS, ROUTE_ASSIGNED_STATUS].includes(String(route.status) as any)) {
    return {
      enabled: true,
      evaluatedMachines: forecasts.length,
      queuedMachines: pending.length,
      routeId: route?.id ?? null,
      stopsAdded: 0,
      createdRoute,
      waitingForNextBatch: true,
    };
  }

  const { data: currentStops, error: currentStopsError } = await supabase
    .from("route_stops")
    .select("id, machine_id, stop_order")
    .eq("route_id", route.id)
    .order("stop_order", { ascending: true });
  if (currentStopsError) throw new Error(`Could not load automatic route stops: ${currentStopsError.message}`);

  const existingMachineIds = new Set((currentStops ?? []).map((row: any) => String(row.machine_id)));
  const capacityLeft = Math.max(0, integer(settings.max_batch_stops, 6) - (currentStops ?? []).length);
  if (capacityLeft <= 0) {
    return {
      enabled: true,
      evaluatedMachines: forecasts.length,
      queuedMachines: pending.length,
      routeId: route.id,
      stopsAdded: 0,
      createdRoute,
      batchFull: true,
    };
  }

  const machineById = new Map((machinesResult.data ?? []).map((machine: any) => [String(machine.id), machine]));
  const candidates = pending
    .filter((row) => !existingMachineIds.has(row.machine_id))
    .sort((a, b) => {
      const urgency = urgencyRank(a.urgency) - urgencyRank(b.urgency);
      if (urgency) return urgency;
      const firstTriggered = Date.parse(a.first_triggered_at) - Date.parse(b.first_triggered_at);
      if (firstTriggered) return firstTriggered;
      const aMachine: any = machineById.get(a.machine_id);
      const bMachine: any = machineById.get(b.machine_id);
      const aLocation = firstRelation(aMachine?.location);
      const bLocation = firstRelation(bMachine?.location);
      const aDistance = Number((aLocation as any)?.distance_from_storage_km ?? Number.POSITIVE_INFINITY);
      const bDistance = Number((bLocation as any)?.distance_from_storage_km ?? Number.POSITIVE_INFINITY);
      return aDistance - bDistance;
    })
    .slice(0, capacityLeft);

  if (!candidates.length) {
    return {
      enabled: true,
      evaluatedMachines: forecasts.length,
      queuedMachines: pending.length,
      routeId: route.id,
      stopsAdded: 0,
      createdRoute,
    };
  }

  const startOrder = (currentStops ?? []).reduce((max: number, row: any) => Math.max(max, integer(row.stop_order)), 0);
  const stopRows = candidates.map((row, index) => ({
    route_id: route.id,
    machine_id: row.machine_id,
    stop_order: startOrder + index + 1,
    status: "pending",
    notes: `Auto refill trigger: ${row.urgency}`,
  }));

  const { data: insertedStops, error: insertStopsError } = await supabase
    .from("route_stops")
    .insert(stopRows)
    .select("id, machine_id, stop_order");
  if (insertStopsError) throw new Error(`Could not add automatic refill stops: ${insertStopsError.message}`);

  const stopByMachine = new Map((insertedStops ?? []).map((stop: any) => [String(stop.machine_id), stop]));
  for (const candidate of candidates) {
    const stop = stopByMachine.get(candidate.machine_id);
    if (!stop) continue;
    const { error } = await supabase
      .from("refill_service_queue")
      .update({
        state: "scheduled",
        route_id: route.id,
        route_stop_id: stop.id,
        scheduled_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", candidate.id)
      .eq("state", "pending");
    if (error) throw new Error(`Could not link refill queue to route stop: ${error.message}`);
  }

  if (createdRoute && route.operator_id) {
    try {
      await notifyRouteAssigned(supabase, {
        routeId: String(route.id),
        routeDate: today,
        operatorTeamMemberId: String(route.operator_id),
        assignedBy: "Snacky automation",
        stopCount: (currentStops ?? []).length + (insertedStops?.length ?? 0),
      });
    } catch (error) {
      console.warn("[refill-route-automation] Could not notify operator about automatic refill route", {
        route_id: route.id,
        operator_id: route.operator_id,
        error,
      });
    }
  }

  return {
    enabled: true,
    evaluatedMachines: forecasts.length,
    queuedMachines: pending.length,
    routeId: String(route.id),
    stopsAdded: insertedStops?.length ?? 0,
    createdRoute,
    operatorId: route.operator_id ?? null,
  };
}
