"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { canApprovePayroll, canManagePayroll } from "@/lib/authz";
import { getRequiredFinanceWriteClient } from "@/lib/finance-write-client";
import {
  buildPayrollPeriodSummary,
  getPayrollServerClient,
  loadRoutePayData,
} from "@/lib/payroll-server";
import {
  defaultOperatorPayProfileValues,
  ensureRoutePayRules,
  moneyLabel,
  normalizeOperatorRoleLevel,
  resolveRoutePayExtraAmount,
  toMoney,
  type PayrollPeriodRow,
  type RoutePayBreakdownRow,
  type RoutePayCalculationResult,
} from "@/lib/payroll";

type PayrollServerClient = NonNullable<Awaited<ReturnType<typeof getPayrollServerClient>>>;

type MutablePayrollPeriodRow = PayrollPeriodRow & {
  created_by?: string | null;
  updated_by?: string | null;
  finance_transaction_id?: string | null;
};

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function optionalMoney(value: FormDataEntryValue | null) {
  const text = clean(value).replace(/,/g, "");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function requiredMoney(value: FormDataEntryValue | null, fallback = 0) {
  const parsed = optionalMoney(value);
  return parsed === null ? fallback : parsed;
}

function periodStartFromInput(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function dateInputFromValue(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function errorField(error: unknown, key: string) {
  if (!error || typeof error !== "object") return null;
  return (error as Record<string, unknown>)[key] ?? null;
}

function errorText(error: unknown) {
  return ["code", "message", "details", "hint"]
    .map((key) => String(errorField(error, key) ?? ""))
    .join(" ")
    .toLowerCase();
}

function isMissingColumnError(error: unknown) {
  const text = errorText(error);
  return text.includes("column") && text.includes("does not exist");
}

async function requirePayrollAccess(path: string, approvalOnly = false) {
  const profile = await getCurrentProfile();
  if (!profile || !(approvalOnly ? canApprovePayroll(profile) : canManagePayroll(profile))) redirect("/unauthorized");
  const supabase = await getPayrollServerClient();
  if (!supabase) fail(path, "Supabase is not configured.");
  return { profile, supabase };
}

function revalidatePayrollPaths({ routeId, periodId, teamMemberId }: { routeId?: string | null; periodId?: string | null; teamMemberId?: string | null } = {}) {
  revalidatePath("/payroll");
  revalidatePath("/payroll/profiles");
  revalidatePath("/payroll/rules");
  revalidatePath("/payroll/periods");
  revalidatePath("/operator");
  revalidatePath("/operator/routes");
  revalidatePath("/routes");
  if (routeId) {
    revalidatePath(`/routes/${routeId}`);
    revalidatePath(`/payroll/routes/${routeId}`);
    revalidatePath(`/operator/routes/${routeId}`);
  }
  if (periodId) {
    revalidatePath(`/payroll/periods/${periodId}`);
  }
  if (teamMemberId) {
    revalidatePath(`/payroll/profiles/${teamMemberId}`);
    revalidatePath(`/team/${teamMemberId}`);
  }
  revalidatePath("/finance");
  revalidatePath("/finance/transactions");
}

async function persistRoutePayCalculation({
  supabase,
  calculation,
  existingBreakdown,
  extraFields = {},
}: {
  supabase: PayrollServerClient;
  calculation: RoutePayCalculationResult;
  existingBreakdown?: RoutePayBreakdownRow | null;
  extraFields?: Record<string, unknown>;
}) {
  const now = new Date().toISOString();
  const payload = {
    route_id: calculation.routeId,
    operator_id: calculation.operatorId,
    operator_pay_profile_id: calculation.operatorPayProfileId,
    pay_rule_id: calculation.payRuleId,
    storage_location_id: calculation.storageLocationId,
    route_status: calculation.routeStatus,
    distance_km: calculation.distanceKm,
    distance_zone: calculation.distanceZone,
    distance_source: calculation.distanceSource,
    stop_count: calculation.stopCount,
    total_stop_multiplier: calculation.totalStopMultiplier,
    route_base_lyd: calculation.routeBasePay,
    stop_pay_lyd: calculation.stopPay,
    distance_pay_lyd: calculation.distancePay,
    load_difficulty_pay_lyd: calculation.loadDifficultyPay,
    extras_pay_lyd: calculation.extrasPay,
    manual_adjustment_lyd: calculation.manualAdjustment,
    manual_adjustment_reason: calculation.manualAdjustmentReason,
    total_pay_lyd: calculation.totalPay,
    approval_required: calculation.approvalRequired,
    breakdown: calculation.breakdown,
    recalculated_at: now,
    updated_at: now,
    ...extraFields,
  };
  const saveBreakdownResult = existingBreakdown?.id
    ? await supabase
        .from("route_pay_breakdowns")
        .update(payload)
        .eq("id", existingBreakdown.id)
        .select("*")
        .single()
    : await supabase
        .from("route_pay_breakdowns")
        .upsert(payload, { onConflict: "route_id" })
        .select("*")
        .single();
  const { data, error } = saveBreakdownResult;
  if (error) throw error;

  const routeUpdate = {
    storage_location_id: calculation.storageLocationId,
    distance_km: calculation.distanceKm,
    distance_zone: calculation.distanceZone,
    distance_source: calculation.distanceSource,
    load_difficulty_pay_lyd: calculation.loadDifficultyPay,
  };
  const routeUpdateResult = await supabase.from("routes").update(routeUpdate).eq("id", calculation.routeId);
  if (routeUpdateResult.error) throw routeUpdateResult.error;

  return data;
}

async function refreshPayrollPeriodRecord({
  supabase,
  actorTeamMemberId,
  operatorId,
  periodStart,
  periodEnd,
  existingPeriod,
}: {
  supabase: PayrollServerClient;
  actorTeamMemberId: string | null;
  operatorId: string;
  periodStart: string;
  periodEnd: string;
  existingPeriod?: MutablePayrollPeriodRow | null;
}) {
  const summary = await buildPayrollPeriodSummary({
    supabase,
    operatorId,
    periodStart,
    periodEnd,
    existingPeriodId: existingPeriod?.id ?? null,
  });
  if (!summary) throw new Error("This operator needs a pay profile before payroll can be calculated.");
  if (existingPeriod?.status === "paid") throw new Error("Paid payroll periods cannot be recalculated.");

  const now = new Date().toISOString();
  const payload = {
    operator_id: operatorId,
    operator_pay_profile_id: summary.payProfile.id,
    period_start: summary.periodStart,
    period_end: summary.periodEnd,
    status: existingPeriod?.status === "disputed" ? "disputed" : "calculated",
    base_salary_lyd: summary.baseSalaryAmount,
    base_salary_amount_lyd: summary.baseSalaryAmount,
    car_allowance_lyd: 0,
    phone_allowance_lyd: 0,
    route_pay_total_lyd: toMoney(summary.routePayAmount + summary.stopPayAmount + summary.distancePayAmount + summary.fuelAllowanceAmount),
    route_pay_amount_lyd: summary.routePayAmount,
    stop_pay_amount_lyd: summary.stopPayAmount,
    distance_pay_amount_lyd: summary.distancePayAmount,
    fuel_allowance_amount_lyd: summary.fuelAllowanceAmount,
    buying_trip_total_lyd: 0,
    emergency_total_lyd: 0,
    bonus_total_lyd: summary.bonusAmount,
    deduction_total_lyd: summary.deductionAmount,
    gross_total_lyd: summary.grossPay,
    net_total_lyd: summary.netPay,
    route_count: summary.completedRoutesCount,
    completed_routes_count: summary.completedRoutesCount,
    completed_stops_count: summary.completedStopsCount,
    total_payroll_distance_km: summary.totalPayrollDistanceKm,
    missing_distance_stop_count: summary.missingDistanceWarnings.length,
    calculation_snapshot: summary.calculationSnapshot,
    updated_by: actorTeamMemberId,
    updated_at: now,
    created_by: existingPeriod?.created_by ?? actorTeamMemberId,
  };

  const savePeriodResult = existingPeriod?.id
    ? await supabase
        .from("payroll_periods")
        .update(payload)
        .eq("id", existingPeriod.id)
        .select("*")
        .single()
    : await supabase
        .from("payroll_periods")
        .insert(payload)
        .select("*")
        .single();
  const { data: savedPeriod, error: periodError } = savePeriodResult;
  if (periodError) throw periodError;

  return { period: savedPeriod, summary };
}

function buildPayrollFinancePayload({
  period,
  operatorName,
  createdBy,
  paidAt,
}: {
  period: MutablePayrollPeriodRow;
  operatorName: string;
  createdBy: string | null;
  paidAt: string;
}) {
  const amount = toMoney(period.net_total_lyd);
  const date = paidAt.slice(0, 10);
  const routeCount = period.completed_routes_count ?? period.route_count ?? 0;
  const stopCount = period.completed_stops_count ?? 0;
  const notes = `Payroll ${period.period_start} to ${period.period_end} - ${routeCount} routes, ${stopCount} stops`;
  return {
    transaction_date: date,
    transaction_datetime: paidAt,
    direction: "money_out",
    transaction_kind: "manual_money_out",
    transaction_type: "Salary to employee",
    category: "Salary to employee",
    description: `Salary to ${operatorName}`,
    notes,
    amount,
    signed_amount: -amount,
    currency: "LYD",
    account_id: "snacky_lyd",
    account_key: "snacky_lyd",
    transaction_effect: "expense",
    source_account_id: null,
    destination_account_id: null,
    bucket: "Operations",
    final_bucket: "Salary to employee",
    import_status: "confirmed",
    review_status: "confirmed",
    needs_review: false,
    transaction_status: "active",
    is_void: false,
    voided_at: null,
    void_reason: null,
    payment_method: "payroll",
    payer_text: null,
    payee_text: operatorName,
    paid_to_text: operatorName,
    counterparty_text: operatorName,
    source_type: "payroll",
    source_id: period.id,
    created_by: createdBy,
    metadata: {
      payroll_period_id: period.id,
      route_count: routeCount,
      stop_count: stopCount,
      period_start: period.period_start,
      period_end: period.period_end,
    },
    updated_at: new Date().toISOString(),
  };
}

export async function saveOperatorPayProfile(formData: FormData) {
  const teamMemberId = clean(formData.get("team_member_id"));
  const path = teamMemberId ? `/payroll/profiles/${teamMemberId}` : "/payroll/profiles";
  if (!teamMemberId) fail("/payroll/profiles", "Choose a team member.");
  const { profile, supabase } = await requirePayrollAccess(path);

  const beforeResult = await supabase.from("operator_pay_profiles").select("*").eq("team_member_id", teamMemberId).maybeSingle();
  const existingProfile = (beforeResult.data ?? null) as Record<string, unknown> | null;
  const roleLevel = normalizeOperatorRoleLevel(clean(formData.get("role_level")) || String(existingProfile?.role_level ?? "junior_operator"));
  const defaults = defaultOperatorPayProfileValues(roleLevel);
  const activeFrom = dateInputFromValue(clean(formData.get("active_from")))
    || dateInputFromValue(String(existingProfile?.active_from ?? defaults.active_from ?? ""))
    || new Date().toISOString().slice(0, 10);
  const activeTo = dateInputFromValue(clean(formData.get("active_to"))) || null;
  const baseMonthlySalary = requiredMoney(formData.get("base_monthly_salary_lyd"), toMoney(existingProfile?.base_monthly_salary_lyd ?? existingProfile?.base_salary_lyd ?? defaults.base_monthly_salary_lyd ?? defaults.base_salary_lyd));
  const payPerRoute = requiredMoney(formData.get("pay_per_route_lyd"), toMoney(existingProfile?.pay_per_route_lyd ?? existingProfile?.default_route_base_lyd ?? defaults.pay_per_route_lyd ?? defaults.default_route_base_lyd));
  const payPerStop = requiredMoney(formData.get("pay_per_stop_lyd"), toMoney(existingProfile?.pay_per_stop_lyd ?? existingProfile?.default_stop_rate_lyd ?? defaults.pay_per_stop_lyd ?? defaults.default_stop_rate_lyd));
  const payPerKm = requiredMoney(formData.get("pay_per_km_lyd"), toMoney(existingProfile?.pay_per_km_lyd ?? existingProfile?.default_km_rate_lyd ?? defaults.pay_per_km_lyd ?? defaults.default_km_rate_lyd));
  const fuelAllowancePerKm = requiredMoney(formData.get("fuel_allowance_per_km_lyd"), toMoney(existingProfile?.fuel_allowance_per_km_lyd ?? defaults.fuel_allowance_per_km_lyd));
  const bonus = requiredMoney(formData.get("bonus_lyd"), toMoney(existingProfile?.bonus_lyd ?? defaults.bonus_lyd));
  const deduction = requiredMoney(formData.get("deduction_lyd"), toMoney(existingProfile?.deduction_lyd ?? defaults.deduction_lyd));
  const isActive = clean(formData.get("is_active")) !== "false";
  const notes = clean(formData.get("notes")) || null;
  const now = new Date().toISOString();

  const payload = {
    team_member_id: teamMemberId,
    role_level: roleLevel,
    base_salary_lyd: baseMonthlySalary,
    base_monthly_salary_lyd: baseMonthlySalary,
    car_allowance_lyd: toMoney(existingProfile?.car_allowance_lyd ?? defaults.car_allowance_lyd),
    phone_allowance_lyd: toMoney(existingProfile?.phone_allowance_lyd ?? defaults.phone_allowance_lyd),
    default_route_base_lyd: payPerRoute,
    pay_per_route_lyd: payPerRoute,
    default_stop_rate_lyd: payPerStop,
    pay_per_stop_lyd: payPerStop,
    default_km_rate_lyd: payPerKm,
    pay_per_km_lyd: payPerKm,
    fuel_allowance_per_km_lyd: fuelAllowancePerKm,
    bonus_lyd: bonus,
    deduction_lyd: deduction,
    can_collect_cash: Boolean(existingProfile?.can_collect_cash ?? defaults.can_collect_cash),
    can_buy_stock: Boolean(existingProfile?.can_buy_stock ?? defaults.can_buy_stock),
    active: isActive,
    active_from: activeFrom,
    active_to: activeTo,
    is_active: isActive,
    notes,
    updated_at: now,
  };

  const legacyPayload = {
    team_member_id: teamMemberId,
    role_level: roleLevel,
    base_salary_lyd: baseMonthlySalary,
    car_allowance_lyd: toMoney(existingProfile?.car_allowance_lyd ?? defaults.car_allowance_lyd),
    phone_allowance_lyd: toMoney(existingProfile?.phone_allowance_lyd ?? defaults.phone_allowance_lyd),
    default_route_base_lyd: payPerRoute,
    default_stop_rate_lyd: payPerStop,
    default_km_rate_lyd: payPerKm,
    can_collect_cash: Boolean(existingProfile?.can_collect_cash ?? defaults.can_collect_cash),
    can_buy_stock: Boolean(existingProfile?.can_buy_stock ?? defaults.can_buy_stock),
    active: isActive,
    notes,
    updated_at: now,
  };

  let saveResult = await supabase
    .from("operator_pay_profiles")
    .upsert(payload, { onConflict: "team_member_id" })
    .select("*")
    .single();

  if (saveResult.error && isMissingColumnError(saveResult.error)) {
    console.warn("[payroll] saveOperatorPayProfile retrying with legacy payload", {
      current_user_id: profile.id,
      current_user_role: profile.role,
      current_user_roles: profile.roles,
      current_team_member_id: profile.team_member_id,
      selected_operator_id: teamMemberId,
      missing_column_error_code: errorField(saveResult.error, "code"),
      missing_column_error_message: errorField(saveResult.error, "message"),
    });

    saveResult = await supabase
      .from("operator_pay_profiles")
      .upsert(legacyPayload, { onConflict: "team_member_id" })
      .select("*")
      .single();
  }

  const { data: after, error } = saveResult;
  if (error || !after) {
    console.error("[payroll] Could not save operator pay profile", {
      current_user_id: profile.id,
      current_user_role: profile.role,
      current_user_roles: profile.roles,
      current_team_member_id: profile.team_member_id,
      selected_operator_id: teamMemberId,
      action_path: path,
      payload,
      legacy_payload: legacyPayload,
      existing_profile_found: Boolean(existingProfile),
      prefetch_error_code: errorField(beforeResult.error, "code"),
      prefetch_error_message: errorField(beforeResult.error, "message"),
      supabase_error_code: errorField(error, "code"),
      supabase_error_message: errorField(error, "message"),
      supabase_error_details: errorField(error, "details"),
      supabase_error_hint: errorField(error, "hint"),
      supabase_error_constraint: errorField(error, "constraint"),
    });
    fail(path, "Could not save the operator pay profile.");
  }

  const { data: member } = await supabase.from("team_members").select("id, full_name").eq("id", teamMemberId).maybeSingle();
  await logActivity({
    profile,
    action: beforeResult.data ? "update" : "create",
    entityType: "operator_pay_profile",
    entityId: after.id,
    entityLabel: member?.full_name ?? "Operator pay profile",
    beforeData: beforeResult.data,
    afterData: after,
    summary: beforeResult.data ? `Updated payroll profile for ${member?.full_name ?? "operator"}` : `Created payroll profile for ${member?.full_name ?? "operator"}`,
  });

  revalidatePayrollPaths({ teamMemberId });
  redirect(`${path}?saved=1`);
}

export async function updateRoutePayRules(formData: FormData) {
  const { profile, supabase } = await requirePayrollAccess("/payroll/rules");
  const before = await supabase.from("route_pay_rules").select("*").eq("id", "default").maybeSingle();
  const payload = {
    id: "default",
    distance_pay_mode: clean(formData.get("distance_pay_mode")) || "zone",
    zone_0_10_lyd: requiredMoney(formData.get("zone_0_10_lyd")),
    zone_11_20_lyd: requiredMoney(formData.get("zone_11_20_lyd")),
    zone_21_35_lyd: requiredMoney(formData.get("zone_21_35_lyd")),
    zone_36_50_lyd: requiredMoney(formData.get("zone_36_50_lyd")),
    zone_51_70_lyd: requiredMoney(formData.get("zone_51_70_lyd")),
    zone_70_plus_lyd: optionalMoney(formData.get("zone_70_plus_lyd")),
    zone_over_70_requires_approval: clean(formData.get("zone_over_70_requires_approval")) === "yes",
    cash_collection_extra_lyd: requiredMoney(formData.get("cash_collection_extra_lyd")),
    deep_cleaning_extra_lyd: requiredMoney(formData.get("deep_cleaning_extra_lyd")),
    simple_fix_extra_lyd: requiredMoney(formData.get("simple_fix_extra_lyd")),
    emergency_extra_lyd: requiredMoney(formData.get("emergency_extra_lyd")),
    friday_holiday_extra_lyd: requiredMoney(formData.get("friday_holiday_extra_lyd")),
    buying_trip_extra_lyd: requiredMoney(formData.get("buying_trip_extra_lyd")),
    heavy_load_extra_lyd: requiredMoney(formData.get("heavy_load_extra_lyd")),
    notes: clean(formData.get("notes")) || null,
    updated_at: new Date().toISOString(),
  };

  const { data: after, error } = await supabase.from("route_pay_rules").upsert(payload, { onConflict: "id" }).select("*").single();
  if (error || !after) fail("/payroll/rules", "Could not save route pay rules.");

  await logActivity({
    profile,
    action: before.data ? "update" : "create",
    entityType: "route_pay_rules",
    entityId: "default",
    entityLabel: "Route pay rules",
    beforeData: before.data,
    afterData: after,
    summary: "Updated route pay rules",
  });

  revalidatePayrollPaths();
  redirect("/payroll/rules?saved=1");
}

export async function recalculateRoutePay(formData: FormData) {
  const routeId = clean(formData.get("route_id"));
  const path = routeId ? `/payroll/routes/${routeId}` : "/payroll";
  if (!routeId) fail("/payroll", "Route is required.");
  const { profile } = await requirePayrollAccess(path);

  const manualAdjustment = optionalMoney(formData.get("manual_adjustment_lyd")) ?? 0;
  const manualAdjustmentReason = clean(formData.get("manual_adjustment_reason")) || null;
  if (manualAdjustment !== 0 && !manualAdjustmentReason) fail(path, "Manual adjustment reason is required.");

  const routeData = await loadRoutePayData(routeId, {
    storage_location_id: clean(formData.get("storage_location_id")) || null,
    distance_km: optionalMoney(formData.get("distance_km")),
    distance_zone: clean(formData.get("distance_zone")) || null,
    distance_source: clean(formData.get("distance_source")) || undefined,
    load_difficulty_pay_lyd: optionalMoney(formData.get("load_difficulty_pay_lyd")) ?? 0,
    manual_adjustment_lyd: manualAdjustment,
    manual_adjustment_reason: manualAdjustmentReason,
  });
  if (!routeData) fail(path, "Route pay data could not be loaded.");
  if (!routeData.payProfile || !routeData.calculation) fail(path, "This route needs an assigned operator and pay profile before payroll can be calculated.");

  const savedBreakdown = await persistRoutePayCalculation({
    supabase: routeData.supabase,
    calculation: routeData.calculation,
    existingBreakdown: routeData.breakdown,
  });

  await logActivity({
    profile,
    action: "recalculate_pay",
    entityType: "route_pay_breakdown",
    entityId: savedBreakdown.id,
    entityLabel: `Route ${routeId.slice(0, 8)} pay`,
    beforeData: routeData.breakdown,
    afterData: savedBreakdown,
    summary: `Recalculated route pay for ${routeData.route.route_date ?? routeId.slice(0, 8)} (${moneyLabel(routeData.calculation.totalPay)})`,
  });

  revalidatePayrollPaths({ routeId, teamMemberId: routeData.operator?.id ?? null });
  redirect(`${path}?saved=1`);
}

export async function saveRoutePayExtra(formData: FormData) {
  const routeId = clean(formData.get("route_id"));
  const path = routeId ? `/payroll/routes/${routeId}` : "/payroll";
  if (!routeId) fail("/payroll", "Route is required.");
  const { profile, supabase } = await requirePayrollAccess(path);
  const extraType = clean(formData.get("extra_type"));
  const rules = await ensureRoutePayRules(supabase as any);
  const amount = optionalMoney(formData.get("amount_lyd")) ?? resolveRoutePayExtraAmount(extraType, rules);
  if (amount < 0) fail(path, "Extra amount must be zero or greater.");

  const { data: extra, error } = await supabase
    .from("route_pay_extra_items")
    .insert({
      route_id: routeId,
      route_stop_id: clean(formData.get("route_stop_id")) || null,
      extra_type: extraType,
      amount_lyd: amount,
      notes: clean(formData.get("notes")) || null,
      created_by: profile.team_member_id,
      updated_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error || !extra) fail(path, "Could not save route extra.");

  await logActivity({
    profile,
    action: "create",
    entityType: "route_pay_extra",
    entityId: extra.id,
    entityLabel: `Route ${routeId.slice(0, 8)} extra`,
    afterData: extra,
    summary: `Added ${extraType.replaceAll("_", " ")} to route pay`,
  });

  revalidatePayrollPaths({ routeId });
  redirect(`${path}?saved=1`);
}

export async function deleteRoutePayExtra(formData: FormData) {
  const routeId = clean(formData.get("route_id"));
  const extraId = clean(formData.get("extra_id"));
  const path = routeId ? `/payroll/routes/${routeId}` : "/payroll";
  if (!routeId || !extraId) fail("/payroll", "Route extra is required.");
  const { profile, supabase } = await requirePayrollAccess(path);
  const before = await supabase.from("route_pay_extra_items").select("*").eq("id", extraId).maybeSingle();
  const deletion = await supabase.from("route_pay_extra_items").delete().eq("id", extraId);
  if (deletion.error) fail(path, "Could not delete route extra.");

  await logActivity({
    profile,
    action: "delete",
    entityType: "route_pay_extra",
    entityId: extraId,
    entityLabel: `Route ${routeId.slice(0, 8)} extra`,
    beforeData: before.data,
    summary: "Deleted route pay extra",
  });

  revalidatePayrollPaths({ routeId });
  redirect(`${path}?saved=1`);
}

export async function verifyRoutePay(formData: FormData) {
  const routeId = clean(formData.get("route_id"));
  const path = routeId ? `/payroll/routes/${routeId}` : "/payroll";
  if (!routeId) fail("/payroll", "Route is required.");

  const { profile, supabase } = await requirePayrollAccess(path);
  const manualAdjustment = optionalMoney(formData.get("manual_adjustment_lyd")) ?? 0;
  const manualAdjustmentReason = clean(formData.get("manual_adjustment_reason")) || null;
  if (manualAdjustment !== 0 && !manualAdjustmentReason) fail(path, "Manual adjustment reason is required.");
  const routeData = await loadRoutePayData(routeId, {
    storage_location_id: clean(formData.get("storage_location_id")) || null,
    distance_km: optionalMoney(formData.get("distance_km")),
    distance_zone: clean(formData.get("distance_zone")) || null,
    distance_source: clean(formData.get("distance_source")) || undefined,
    load_difficulty_pay_lyd: optionalMoney(formData.get("load_difficulty_pay_lyd")) ?? 0,
    manual_adjustment_lyd: manualAdjustment,
    manual_adjustment_reason: manualAdjustmentReason,
  });
  if (!routeData || !routeData.payProfile || !routeData.calculation) fail(path, "Route pay data could not be loaded.");
  if (!["completed", "reviewed", "verified", "disputed", "payroll_pending"].includes(String(routeData.route.status ?? ""))) {
    fail(path, "Only completed routes can be verified for payroll.");
  }
  if (routeData.calculation.approvalRequired && !canApprovePayroll(profile)) {
    fail(path, "Routes above 70 km need owner/admin approval.");
  }

  const now = new Date().toISOString();
  const savedBreakdown = await persistRoutePayCalculation({
    supabase,
    calculation: routeData.calculation,
    existingBreakdown: routeData.breakdown,
    extraFields: {
      approved_by: routeData.calculation.approvalRequired ? profile.team_member_id : routeData.breakdown?.approved_by ?? null,
      approved_at: routeData.calculation.approvalRequired ? now : routeData.breakdown?.approved_at ?? null,
    },
  });

  const routeUpdate = await supabase
    .from("routes")
    .update({
      status: "verified",
      verified_at: now,
      verified_by: profile.team_member_id,
      pay_dispute_reason: null,
      pay_disputed_at: null,
      pay_disputed_by: null,
    })
    .eq("id", routeId)
    .select("*")
    .single();
  if (routeUpdate.error) fail(path, "Could not mark this route as verified.");

  await logActivity({
    profile,
    action: "verify_pay",
    entityType: "route",
    entityId: routeId,
    entityLabel: `Route ${routeData.route.route_date ?? routeId.slice(0, 8)}`,
    beforeData: routeData.route,
    afterData: routeUpdate.data,
    metadata: { route_pay_breakdown_id: savedBreakdown.id, approval_required: routeData.calculation.approvalRequired },
    summary: `Verified route pay at ${moneyLabel(routeData.calculation.totalPay)}`,
  });

  revalidatePayrollPaths({ routeId, teamMemberId: routeData.operator?.id ?? null });
  redirect(`${path}?verified=1`);
}

export async function markRoutePayDisputed(formData: FormData) {
  const routeId = clean(formData.get("route_id"));
  const reason = clean(formData.get("reason"));
  const path = routeId ? `/payroll/routes/${routeId}` : "/payroll";
  if (!routeId) fail("/payroll", "Route is required.");
  if (!reason) fail(path, "Dispute reason is required.");
  const { profile, supabase } = await requirePayrollAccess(path);
  const routeData = await loadRoutePayData(routeId);
  if (!routeData) fail(path, "Route pay data could not be loaded.");

  const now = new Date().toISOString();
  const routeUpdate = await supabase
    .from("routes")
    .update({
      status: "disputed",
      pay_dispute_reason: reason,
      pay_disputed_at: now,
      pay_disputed_by: profile.team_member_id,
    })
    .eq("id", routeId)
    .select("*")
    .single();
  if (routeUpdate.error) fail(path, "Could not mark this route as disputed.");

  if (routeData.breakdown?.payroll_period_id) {
    const periodUpdate = await supabase
      .from("payroll_periods")
      .update({ status: "disputed", updated_by: profile.team_member_id, updated_at: now })
      .eq("id", routeData.breakdown.payroll_period_id)
      .neq("status", "paid");
    if (periodUpdate.error) fail(path, "Route was marked disputed, but the payroll period could not be updated.");
  }

  await logActivity({
    profile,
    action: "dispute_pay",
    entityType: "route",
    entityId: routeId,
    entityLabel: `Route ${routeData.route.route_date ?? routeId.slice(0, 8)}`,
    beforeData: routeData.route,
    afterData: routeUpdate.data,
    metadata: { reason },
    summary: "Marked route pay as disputed",
  });

  revalidatePayrollPaths({ routeId, periodId: routeData.breakdown?.payroll_period_id ?? null, teamMemberId: routeData.operator?.id ?? null });
  redirect(`${path}?saved=1`);
}

export async function refreshPayrollPeriod(formData: FormData) {
  const operatorId = clean(formData.get("operator_id"));
  const periodStart = periodStartFromInput(clean(formData.get("period_start")));
  const periodEnd = dateInputFromValue(clean(formData.get("period_end")));
  const path = clean(formData.get("return_path")) || "/payroll/periods";
  if (!operatorId) fail(path, "Choose an operator.");
  if (!periodStart) fail(path, "Choose a payroll start date.");
  if (!periodEnd) fail(path, "Choose a payroll end date.");
  if (periodEnd < periodStart) fail(path, "Payroll end date must be on or after the start date.");

  const { profile, supabase } = await requirePayrollAccess(path);
  const existingPeriod = await supabase
    .from("payroll_periods")
    .select("*")
    .eq("operator_id", operatorId)
    .eq("period_start", periodStart)
    .maybeSingle();

  const { period, summary } = await refreshPayrollPeriodRecord({
    supabase,
    actorTeamMemberId: profile.team_member_id,
    operatorId,
    periodStart,
    periodEnd,
    existingPeriod: existingPeriod.data ?? null,
  });

  await logActivity({
    profile,
    action: existingPeriod.data ? "update" : "create",
    entityType: "payroll_period",
    entityId: period.id,
    entityLabel: summary.summaryLabel,
    beforeData: existingPeriod.data,
    afterData: period,
    summary: existingPeriod.data ? `Refreshed payroll period for ${summary.operator?.full_name ?? "operator"}` : `Created payroll period for ${summary.operator?.full_name ?? "operator"}`,
  });

  revalidatePayrollPaths({ periodId: period.id, teamMemberId: operatorId });
  redirect(`${path}?saved=1`);
}

export async function savePayrollAdjustment(formData: FormData) {
  const payrollPeriodId = clean(formData.get("payroll_period_id"));
  const path = payrollPeriodId ? `/payroll/periods/${payrollPeriodId}` : "/payroll/periods";
  if (!payrollPeriodId) fail("/payroll/periods", "Payroll period is required.");
  const { profile, supabase } = await requirePayrollAccess(path);
  const adjustmentType = clean(formData.get("adjustment_type"));
  const amount = requiredMoney(formData.get("amount_lyd"));
  const label = clean(formData.get("label"));
  const reason = clean(formData.get("reason"));
  if (!["bonus", "deduction"].includes(adjustmentType)) fail(path, "Adjustment type must be bonus or deduction.");
  if (!label || !reason || amount <= 0) fail(path, "Adjustment label, amount, and reason are required.");

  const periodResult = await supabase.from("payroll_periods").select("*").eq("id", payrollPeriodId).maybeSingle();
  const period = periodResult.data;
  if (!period) fail(path, "Payroll period not found.");
  if (period.status === "paid") fail(path, "Paid payroll periods cannot be changed.");

  const { data: adjustment, error } = await supabase
    .from("payroll_adjustments")
    .insert({
      payroll_period_id: payrollPeriodId,
      adjustment_type: adjustmentType,
      label,
      amount_lyd: amount,
      reason,
      created_by: profile.team_member_id,
      updated_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error || !adjustment) fail(path, "Could not save the payroll adjustment.");

  await refreshPayrollPeriodRecord({
    supabase,
    actorTeamMemberId: profile.team_member_id,
    operatorId: period.operator_id,
    periodStart: period.period_start,
    periodEnd: period.period_end,
    existingPeriod: period,
  });

  await logActivity({
    profile,
    action: "create",
    entityType: "payroll_adjustment",
    entityId: adjustment.id,
    entityLabel: label,
    afterData: adjustment,
    summary: `Added ${adjustmentType} to payroll period`,
  });

  revalidatePayrollPaths({ periodId: payrollPeriodId, teamMemberId: period.operator_id });
  redirect(`${path}?saved=1`);
}

export async function deletePayrollAdjustment(formData: FormData) {
  const payrollPeriodId = clean(formData.get("payroll_period_id"));
  const adjustmentId = clean(formData.get("adjustment_id"));
  const path = payrollPeriodId ? `/payroll/periods/${payrollPeriodId}` : "/payroll/periods";
  if (!payrollPeriodId || !adjustmentId) fail("/payroll/periods", "Payroll adjustment is required.");
  const { profile, supabase } = await requirePayrollAccess(path);

  const periodResult = await supabase.from("payroll_periods").select("*").eq("id", payrollPeriodId).maybeSingle();
  const period = periodResult.data;
  if (!period) fail(path, "Payroll period not found.");
  if (period.status === "paid") fail(path, "Paid payroll periods cannot be changed.");

  const before = await supabase.from("payroll_adjustments").select("*").eq("id", adjustmentId).maybeSingle();
  const deletion = await supabase.from("payroll_adjustments").delete().eq("id", adjustmentId);
  if (deletion.error) fail(path, "Could not delete the payroll adjustment.");

  await refreshPayrollPeriodRecord({
    supabase,
    actorTeamMemberId: profile.team_member_id,
    operatorId: period.operator_id,
    periodStart: period.period_start,
    periodEnd: period.period_end,
    existingPeriod: period,
  });

  await logActivity({
    profile,
    action: "delete",
    entityType: "payroll_adjustment",
    entityId: adjustmentId,
    entityLabel: before.data?.label ?? "Payroll adjustment",
    beforeData: before.data,
    summary: "Deleted payroll adjustment",
  });

  revalidatePayrollPaths({ periodId: payrollPeriodId, teamMemberId: period.operator_id });
  redirect(`${path}?saved=1`);
}

export async function markPayrollPeriodPaid(formData: FormData) {
  const payrollPeriodId = clean(formData.get("payroll_period_id"));
  const path = payrollPeriodId ? `/payroll/periods/${payrollPeriodId}` : "/payroll/periods";
  if (!payrollPeriodId) fail("/payroll/periods", "Payroll period is required.");

  const { profile, supabase } = await requirePayrollAccess(path);
  const financeWriteSupabase = getRequiredFinanceWriteClient();
  const periodResult = await supabase.from("payroll_periods").select("*").eq("id", payrollPeriodId).maybeSingle();
  const period = periodResult.data;
  if (!period) fail(path, "Payroll period not found.");
  if (period.status === "paid") fail(path, "Payroll period is already paid.");

  const refreshed = await refreshPayrollPeriodRecord({
    supabase,
    actorTeamMemberId: profile.team_member_id,
    operatorId: period.operator_id,
    periodStart: period.period_start,
    periodEnd: period.period_end,
    existingPeriod: period,
  });

  const paidAt = new Date().toISOString();
  const operatorResult = await supabase.from("team_members").select("id, full_name").eq("id", period.operator_id).maybeSingle();
  const operatorName = operatorResult.data?.full_name ?? "Operator";
  const financePayload = buildPayrollFinancePayload({
    period: refreshed.period,
    operatorName,
    createdBy: profile.team_member_id,
    paidAt,
  });
  const financeResult = await financeWriteSupabase
    .from("financial_transactions")
    .upsert(financePayload, { onConflict: "source_type,source_id" })
    .select("*")
    .single();
  if (financeResult.error || !financeResult.data) fail(path, "Could not create the payroll finance transaction.");

  const periodUpdate = await supabase
    .from("payroll_periods")
    .update({
      status: "paid",
      paid_at: paidAt,
      paid_by: profile.team_member_id,
      finance_transaction_id: financeResult.data.id,
      updated_by: profile.team_member_id,
      updated_at: paidAt,
    })
    .eq("id", payrollPeriodId)
    .select("*")
    .single();
  if (periodUpdate.error) fail(path, "Finance transaction was created, but the payroll period could not be marked paid.");

  const routeIds = refreshed.summary.includedRouteIds;
  if (routeIds.length) {
    const routeUpdate = await supabase
      .from("routes")
      .update({ status: "paid", paid_at: paidAt })
      .in("id", routeIds);
    if (routeUpdate.error) fail(path, "Payroll was marked paid, but linked routes could not be updated.");
  }

  await logActivity({
    profile,
    action: "mark_paid",
    entityType: "payroll_period",
    entityId: payrollPeriodId,
    entityLabel: `${operatorName} payroll`,
    beforeData: period,
    afterData: periodUpdate.data,
    metadata: { finance_transaction_id: financeResult.data.id, route_count: refreshed.summary.completedRoutesCount, stop_count: refreshed.summary.completedStopsCount },
    summary: `Marked payroll period paid for ${operatorName}`,
  });

  revalidatePayrollPaths({ periodId: payrollPeriodId, teamMemberId: period.operator_id });
  redirect(`${path}?paid=1`);
}
