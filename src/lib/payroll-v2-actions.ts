"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity-log";
import { getCurrentProfile } from "@/lib/auth";
import { canManagePayroll } from "@/lib/authz";
import { getRequiredFinanceWriteClient } from "@/lib/finance-write-client";
import {
  buildPayrollRunPreview,
  getPayrollV2ServerClient,
  payrollFinancePayload,
  previousDate,
  type OperatorIncidentRow,
  type OperatorPayProfileVersionRow,
  type PayrollRunRow,
} from "@/lib/payroll-v2";

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

function optionalDate(value: FormDataEntryValue | null) {
  const text = clean(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function errorField(error: unknown, key: string) {
  if (!error || typeof error !== "object") return null;
  return (error as Record<string, unknown>)[key] ?? null;
}

async function requirePayrollAccess(path: string) {
  const profile = await getCurrentProfile();
  if (!profile || !canManagePayroll(profile)) redirect("/unauthorized");
  const supabase = await getPayrollV2ServerClient();
  if (!supabase) fail(path, "Supabase is not configured.");
  return { profile, supabase };
}

function revalidatePayrollPaths({ operatorId, runId, locationId }: { operatorId?: string | null; runId?: string | null; locationId?: string | null } = {}) {
  revalidatePath("/payroll");
  revalidatePath("/payroll/profiles");
  revalidatePath("/payroll/periods");
  revalidatePath("/payroll/incidents");
  revalidatePath("/payroll/distances");
  revalidatePath("/operator");
  revalidatePath("/operator/routes");
  revalidatePath("/locations");
  if (operatorId) {
    revalidatePath(`/payroll/profiles/${operatorId}`);
  }
  if (runId) {
    revalidatePath(`/payroll/periods/${runId}`);
  }
  if (locationId) {
    revalidatePath(`/locations/${locationId}`);
  }
}

function profilePayloadFromFormData(formData: FormData) {
  return {
    base_monthly_salary_lyd: requiredMoney(formData.get("base_monthly_salary_lyd")),
    pay_per_route_lyd: requiredMoney(formData.get("pay_per_route_lyd")),
    pay_per_stop_lyd: requiredMoney(formData.get("pay_per_stop_lyd")),
    pay_per_km_lyd: requiredMoney(formData.get("pay_per_km_lyd")),
    fuel_allowance_per_km_lyd: requiredMoney(formData.get("fuel_allowance_per_km_lyd")),
    is_active: clean(formData.get("is_active")) !== "false",
    active_from: optionalDate(formData.get("active_from")) ?? new Date().toISOString().slice(0, 10),
    active_to: optionalDate(formData.get("active_to")),
    notes: clean(formData.get("notes")) || null,
  };
}

function hasMaterialProfileChanges(current: OperatorPayProfileVersionRow | null, payload: ReturnType<typeof profilePayloadFromFormData>) {
  if (!current) return true;
  return (
    Number(current.base_monthly_salary_lyd ?? 0) !== payload.base_monthly_salary_lyd
    || Number(current.pay_per_route_lyd ?? 0) !== payload.pay_per_route_lyd
    || Number(current.pay_per_stop_lyd ?? 0) !== payload.pay_per_stop_lyd
    || Number(current.pay_per_km_lyd ?? 0) !== payload.pay_per_km_lyd
    || Number(current.fuel_allowance_per_km_lyd ?? 0) !== payload.fuel_allowance_per_km_lyd
    || Boolean(current.is_active ?? true) !== payload.is_active
    || String(current.active_from ?? "") !== payload.active_from
    || String(current.active_to ?? "") !== String(payload.active_to ?? "")
    || String(current.notes ?? "") !== String(payload.notes ?? "")
  );
}

export async function saveOperatorPayProfileVersion(formData: FormData) {
  const operatorId = clean(formData.get("operator_id"));
  const path = operatorId ? `/payroll/profiles/${operatorId}` : "/payroll/profiles";
  if (!operatorId) fail("/payroll/profiles", "Choose an operator.");
  const { profile, supabase } = await requirePayrollAccess(path);
  const requestedProfileId = clean(formData.get("profile_id")) || null;
  const payload = profilePayloadFromFormData(formData);
  const now = new Date().toISOString();

  const existingRowsResult = await supabase
    .from("operator_pay_profile_versions")
    .select("*")
    .eq("operator_id", operatorId)
    .order("is_active", { ascending: false })
    .order("active_from", { ascending: false })
    .order("updated_at", { ascending: false });
  const existingRows = (existingRowsResult.data ?? []) as OperatorPayProfileVersionRow[];
  const currentActive = existingRows.find((row) => Boolean(row.is_active)) ?? null;
  const selectedProfile = requestedProfileId ? existingRows.find((row) => row.id === requestedProfileId) ?? null : currentActive;
  const before = selectedProfile ?? currentActive;

  const updateCurrentInPlace = Boolean(
    selectedProfile
    && currentActive
    && selectedProfile.id === currentActive.id
    && requestedProfileId === currentActive.id
    && (!hasMaterialProfileChanges(currentActive, payload) || payload.active_from <= String(currentActive.active_from ?? payload.active_from) || !payload.is_active),
  );

  try {
    let after: OperatorPayProfileVersionRow | null = null;

    if (updateCurrentInPlace && currentActive) {
      const updatePayload = {
        ...payload,
        active_to: payload.is_active ? payload.active_to : payload.active_to ?? payload.active_from,
        updated_by_user_id: profile.id,
        updated_at: now,
      };
      const { data, error } = await supabase
        .from("operator_pay_profile_versions")
        .update(updatePayload)
        .eq("id", currentActive.id)
        .select("*")
        .single();
      if (error || !data) throw error ?? new Error("Could not update the current pay profile.");
      after = data as OperatorPayProfileVersionRow;
    } else {
      if (currentActive) {
        const closePayload = {
          is_active: false,
          active_to: previousDate(payload.active_from),
          updated_by_user_id: profile.id,
          updated_at: now,
        };
        const { error: closeError } = await supabase
          .from("operator_pay_profile_versions")
          .update(closePayload)
          .eq("id", currentActive.id);
        if (closeError) throw closeError;
      }

      const insertPayload = {
        operator_id: operatorId,
        ...payload,
        active_to: payload.is_active ? payload.active_to : payload.active_to ?? payload.active_from,
        created_by_user_id: profile.id,
        updated_by_user_id: profile.id,
        created_at: now,
        updated_at: now,
      };
      const { data, error } = await supabase
        .from("operator_pay_profile_versions")
        .insert(insertPayload)
        .select("*")
        .single();
      if (error || !data) throw error ?? new Error("Could not create the operator pay profile.");
      after = data as OperatorPayProfileVersionRow;
    }

    const { data: member } = await supabase.from("team_members").select("id, full_name").eq("id", operatorId).maybeSingle();
    await logActivity({
      profile,
      action: before ? "update" : "create",
      entityType: "operator_pay_profile_version",
      entityId: after?.id ?? null,
      entityLabel: member?.full_name ?? "Operator pay profile",
      beforeData: before,
      afterData: after,
      summary: before ? `Updated payroll profile for ${member?.full_name ?? "operator"}` : `Created payroll profile for ${member?.full_name ?? "operator"}`,
    });
  } catch (error) {
    console.error("[payroll] Could not save operator pay profile", {
      current_user_id: profile.id,
      current_user_role: profile.role,
      current_user_roles: profile.roles,
      current_team_member_id: profile.team_member_id,
      selected_operator_id: operatorId,
      action_path: path,
      payload,
      existing_profile_id: requestedProfileId,
      existing_active_profile_id: currentActive?.id ?? null,
      supabase_error_code: errorField(error, "code"),
      supabase_error_message: errorField(error, "message"),
      supabase_error_details: errorField(error, "details"),
      supabase_error_hint: errorField(error, "hint"),
      supabase_error_constraint: errorField(error, "constraint"),
    });
    fail(path, "Could not save the operator pay profile.");
  }

  revalidatePayrollPaths({ operatorId });
  redirect(`${path}?saved=1`);
}

export async function saveLocationPayrollDistance(formData: FormData) {
  const locationId = clean(formData.get("location_id"));
  const path = "/payroll/distances";
  if (!locationId) fail(path, "Choose a location.");
  const { profile, supabase } = await requirePayrollAccess(path);

  const payload = {
    payroll_storage_location_id: clean(formData.get("payroll_storage_location_id")) || null,
    distance_from_storage_km: optionalMoney(formData.get("distance_from_storage_km")),
    use_round_trip_distance: clean(formData.get("use_round_trip_distance")) === "yes",
    payroll_distance_notes: clean(formData.get("payroll_distance_notes")) || null,
    updated_at: new Date().toISOString(),
  };

  const beforeResult = await supabase.from("locations").select("*").eq("id", locationId).maybeSingle();
  const { data: after, error } = await supabase.from("locations").update(payload).eq("id", locationId).select("*").single();
  if (error || !after) {
    console.error("[payroll] Could not save payroll location distance", {
      current_user_id: profile.id,
      current_user_role: profile.role,
      location_id: locationId,
      payload,
      supabase_error_code: errorField(error, "code"),
      supabase_error_message: errorField(error, "message"),
      supabase_error_details: errorField(error, "details"),
      supabase_error_constraint: errorField(error, "constraint"),
    });
    fail(path, "Could not save the location payroll distance.");
  }

  await logActivity({
    profile,
    action: "update",
    entityType: "location_payroll_distance",
    entityId: locationId,
    entityLabel: String((after as { name?: string | null }).name ?? "Location payroll distance"),
    beforeData: beforeResult.data,
    afterData: after,
    summary: `Updated payroll distance for ${String((after as { name?: string | null }).name ?? "location")}`,
  });

  revalidatePayrollPaths({ locationId });
  redirect(`${path}?saved=1`);
}

export async function createOperatorIncident(formData: FormData) {
  const path = "/payroll/incidents";
  const operatorId = clean(formData.get("operator_id"));
  if (!operatorId) fail(path, "Choose an operator.");
  const { profile, supabase } = await requirePayrollAccess(path);

  const payload = {
    operator_id: operatorId,
    route_id: clean(formData.get("route_id")) || null,
    stop_id: clean(formData.get("stop_id")) || null,
    machine_id: clean(formData.get("machine_id")) || null,
    location_id: clean(formData.get("location_id")) || null,
    incident_date: optionalDate(formData.get("incident_date")) ?? new Date().toISOString().slice(0, 10),
    mistake_type: clean(formData.get("mistake_type")) || "other",
    severity: clean(formData.get("severity")) || "level_1_small",
    description: clean(formData.get("description")),
    evidence_photo_url: clean(formData.get("evidence_photo_url")) || null,
    deduction_amount_lyd: requiredMoney(formData.get("deduction_amount_lyd")),
    status: "pending",
    notes: clean(formData.get("notes")) || null,
    created_by_user_id: profile.id,
    updated_at: new Date().toISOString(),
  };
  if (!payload.description) fail(path, "Describe the incident.");

  const { data: after, error } = await supabase.from("operator_incidents").insert(payload).select("*").single();
  if (error || !after) {
    console.error("[payroll] Could not create operator incident", {
      current_user_id: profile.id,
      current_user_role: profile.role,
      selected_operator_id: operatorId,
      payload,
      supabase_error_code: errorField(error, "code"),
      supabase_error_message: errorField(error, "message"),
      supabase_error_details: errorField(error, "details"),
      supabase_error_constraint: errorField(error, "constraint"),
    });
    fail(path, "Could not create the operator incident.");
  }

  await logActivity({
    profile,
    action: "create",
    entityType: "operator_incident",
    entityId: after.id,
    entityLabel: payload.description,
    afterData: after,
    summary: "Created operator incident",
  });

  revalidatePayrollPaths({ operatorId });
  redirect(`${path}?saved=1`);
}

export async function approveOperatorIncident(formData: FormData) {
  const incidentId = clean(formData.get("incident_id"));
  const path = "/payroll/incidents";
  if (!incidentId) fail(path, "Choose an incident.");
  const { profile, supabase } = await requirePayrollAccess(path);

  const beforeResult = await supabase.from("operator_incidents").select("*").eq("id", incidentId).maybeSingle();
  const before = (beforeResult.data ?? null) as OperatorIncidentRow | null;
  if (!before) fail(path, "Incident not found.");

  const now = new Date().toISOString();
  const { data: after, error } = await supabase
    .from("operator_incidents")
    .update({
      status: "approved",
      approved_by_user_id: profile.id,
      approved_at: now,
      cancelled_by_user_id: null,
      cancelled_at: null,
      updated_at: now,
    })
    .eq("id", incidentId)
    .select("*")
    .single();
  if (error || !after) fail(path, "Could not approve the incident.");

  await logActivity({
    profile,
    action: "approve",
    entityType: "operator_incident",
    entityId: incidentId,
    entityLabel: before.description ?? "Operator incident",
    beforeData: before,
    afterData: after,
    summary: "Approved operator incident deduction",
  });

  revalidatePayrollPaths({ operatorId: before.operator_id });
  redirect(`${path}?saved=1`);
}

export async function cancelOperatorIncident(formData: FormData) {
  const incidentId = clean(formData.get("incident_id"));
  const path = "/payroll/incidents";
  if (!incidentId) fail(path, "Choose an incident.");
  const { profile, supabase } = await requirePayrollAccess(path);

  const beforeResult = await supabase.from("operator_incidents").select("*").eq("id", incidentId).maybeSingle();
  const before = (beforeResult.data ?? null) as OperatorIncidentRow | null;
  if (!before) fail(path, "Incident not found.");

  const now = new Date().toISOString();
  const { data: after, error } = await supabase
    .from("operator_incidents")
    .update({
      status: "cancelled",
      approved_by_user_id: null,
      approved_at: null,
      cancelled_by_user_id: profile.id,
      cancelled_at: now,
      applied_payroll_run_id: null,
      updated_at: now,
    })
    .eq("id", incidentId)
    .select("*")
    .single();
  if (error || !after) fail(path, "Could not cancel the incident.");

  await logActivity({
    profile,
    action: "cancel",
    entityType: "operator_incident",
    entityId: incidentId,
    entityLabel: before.description ?? "Operator incident",
    beforeData: before,
    afterData: after,
    summary: "Cancelled operator incident deduction",
  });

  revalidatePayrollPaths({ operatorId: before.operator_id });
  redirect(`${path}?saved=1`);
}

async function syncRunIncidentLinks({
  supabase,
  runId,
  incidentIds,
}: {
  supabase: NonNullable<Awaited<ReturnType<typeof getPayrollV2ServerClient>>>;
  runId: string;
  incidentIds: string[];
}) {
  const now = new Date().toISOString();
  const linkedResult = await supabase.from("operator_incidents").select("id").eq("applied_payroll_run_id", runId);
  const linkedIds = ((linkedResult.data ?? []) as Array<{ id: string }>).map((row) => row.id);
  const keepIds = new Set(incidentIds);
  const unlinkIds = linkedIds.filter((id) => !keepIds.has(id));

  if (unlinkIds.length) {
    const { error } = await supabase
      .from("operator_incidents")
      .update({
        status: "approved",
        applied_payroll_run_id: null,
        updated_at: now,
      })
      .in("id", unlinkIds);
    if (error) throw error;
  }

  if (incidentIds.length) {
    const { error } = await supabase
      .from("operator_incidents")
      .update({
        status: "applied_to_payroll",
        applied_payroll_run_id: runId,
        updated_at: now,
      })
      .in("id", incidentIds);
    if (error) throw error;
  }
}

export async function savePayrollRun(formData: FormData) {
  const operatorId = clean(formData.get("operator_id"));
  const periodStart = optionalDate(formData.get("period_start"));
  const periodEnd = optionalDate(formData.get("period_end"));
  if (!operatorId) fail("/payroll/periods", "Choose an operator.");
  if (!periodStart) fail("/payroll/periods", "Choose a payroll start date.");
  if (!periodEnd) fail("/payroll/periods", "Choose a payroll end date.");
  if (periodEnd < periodStart) fail("/payroll/periods", "Payroll end date must be on or after the start date.");

  const path = clean(formData.get("return_path")) || `/payroll/periods?operator_id=${operatorId}&period_start=${periodStart}&period_end=${periodEnd}`;
  const { profile, supabase } = await requirePayrollAccess(path);

  const existingResult = await supabase
    .from("payroll_runs")
    .select("*")
    .eq("operator_id", operatorId)
    .eq("period_start", periodStart)
    .eq("period_end", periodEnd)
    .maybeSingle();
  const existing = (existingResult.data ?? null) as PayrollRunRow | null;
  if (existing?.status === "paid") fail(path, "Paid payroll runs cannot be changed.");

  const preview = await buildPayrollRunPreview({
    supabase,
    operatorId,
    periodStart,
    periodEnd,
    existingRunId: existing?.id ?? null,
  });
  if (!preview) fail(path, "This operator needs an active pay profile before payroll can be created.");

  const now = new Date().toISOString();
  const payload = {
    operator_id: operatorId,
    period_start: periodStart,
    period_end: periodEnd,
    pay_profile_id: preview.payProfile.id,
    completed_routes_count: preview.completedRoutesCount,
    completed_stops_count: preview.completedStopsCount,
    total_payroll_distance_km: preview.totalPayrollDistanceKm,
    base_salary_amount_lyd: preview.baseSalaryAmount,
    route_pay_amount_lyd: preview.routePayAmount,
    stop_pay_amount_lyd: preview.stopPayAmount,
    distance_pay_amount_lyd: preview.distancePayAmount,
    fuel_allowance_amount_lyd: preview.fuelAllowanceAmount,
    bonus_amount_lyd: preview.bonusAmount,
    deduction_amount_lyd: preview.deductionAmount,
    gross_pay_lyd: preview.grossPay,
    net_pay_lyd: preview.netPay,
    status: "approved",
    calculation_snapshot: preview.calculationSnapshot,
    notes: clean(formData.get("notes")) || existing?.notes || null,
    created_by_user_id: existing?.created_by_user_id ?? profile.id,
    approved_by_user_id: profile.id,
    updated_at: now,
  };

  const saveResult = existing?.id
    ? await supabase.from("payroll_runs").update(payload).eq("id", existing.id).select("*").single()
    : await supabase.from("payroll_runs").insert({ ...payload, created_at: now }).select("*").single();
  const run = (saveResult.data ?? null) as PayrollRunRow | null;
  if (saveResult.error || !run) fail(path, "Could not create the payroll run.");

  await syncRunIncidentLinks({
    supabase,
    runId: run.id,
    incidentIds: preview.includedIncidents.map((incident) => incident.incidentId),
  });

  await logActivity({
    profile,
    action: existing ? "update" : "create",
    entityType: "payroll_run",
    entityId: run.id,
    entityLabel: preview.summaryLabel,
    beforeData: existing,
    afterData: run,
    metadata: {
      included_route_ids: preview.includedRouteIds,
      included_incident_ids: preview.includedIncidents.map((incident) => incident.incidentId),
    },
    summary: existing ? `Updated payroll run for ${preview.operator?.full_name ?? "operator"}` : `Created payroll run for ${preview.operator?.full_name ?? "operator"}`,
  });

  revalidatePayrollPaths({ operatorId, runId: run.id });
  redirect(`/payroll/periods/${run.id}?saved=1`);
}

export async function markPayrollRunPaid(formData: FormData) {
  const runId = clean(formData.get("payroll_run_id"));
  const path = runId ? `/payroll/periods/${runId}` : "/payroll/periods";
  if (!runId) fail("/payroll/periods", "Payroll run is required.");

  const { profile, supabase } = await requirePayrollAccess(path);
  const financeWriteSupabase = getRequiredFinanceWriteClient();
  const runResult = await supabase.from("payroll_runs").select("*").eq("id", runId).maybeSingle();
  const existingRun = (runResult.data ?? null) as PayrollRunRow | null;
  if (!existingRun) fail(path, "Payroll run not found.");
  if (existingRun.status === "paid") fail(path, "Payroll run is already paid.");

  const preview = await buildPayrollRunPreview({
    supabase,
    operatorId: existingRun.operator_id,
    periodStart: existingRun.period_start,
    periodEnd: existingRun.period_end,
    existingRunId: existingRun.id,
  });
  if (!preview) fail(path, "This payroll run no longer has an active pay profile.");

  const refreshPayload = {
    pay_profile_id: preview.payProfile.id,
    completed_routes_count: preview.completedRoutesCount,
    completed_stops_count: preview.completedStopsCount,
    total_payroll_distance_km: preview.totalPayrollDistanceKm,
    base_salary_amount_lyd: preview.baseSalaryAmount,
    route_pay_amount_lyd: preview.routePayAmount,
    stop_pay_amount_lyd: preview.stopPayAmount,
    distance_pay_amount_lyd: preview.distancePayAmount,
    fuel_allowance_amount_lyd: preview.fuelAllowanceAmount,
    bonus_amount_lyd: preview.bonusAmount,
    deduction_amount_lyd: preview.deductionAmount,
    gross_pay_lyd: preview.grossPay,
    net_pay_lyd: preview.netPay,
    calculation_snapshot: preview.calculationSnapshot,
    approved_by_user_id: profile.id,
    updated_at: new Date().toISOString(),
  };
  const refreshResult = await supabase.from("payroll_runs").update(refreshPayload).eq("id", runId).select("*").single();
  const refreshedRun = (refreshResult.data ?? null) as PayrollRunRow | null;
  if (refreshResult.error || !refreshedRun) fail(path, "Could not refresh the payroll run before payment.");

  await syncRunIncidentLinks({
    supabase,
    runId,
    incidentIds: preview.includedIncidents.map((incident) => incident.incidentId),
  });

  const paidAt = new Date().toISOString();
  const { data: operator } = await supabase.from("team_members").select("id, full_name").eq("id", existingRun.operator_id).maybeSingle();
  const operatorName = String(operator?.full_name ?? "Operator");
  const financePayload = payrollFinancePayload({
    run: refreshedRun,
    operatorName,
    createdByTeamMemberId: profile.team_member_id,
    paidAt,
  });

  const financeBeforeResult = await financeWriteSupabase
    .from("financial_transactions")
    .select("*")
    .eq("source_type", "payroll")
    .eq("source_id", runId)
    .order("created_at", { ascending: true })
    .limit(1);
  const existingFinance = (financeBeforeResult.data ?? [])[0] as Record<string, unknown> | undefined;
  const financeResult = existingFinance?.id
    ? await financeWriteSupabase.from("financial_transactions").update(financePayload).eq("id", existingFinance.id).select("*").single()
    : await financeWriteSupabase.from("financial_transactions").insert(financePayload).select("*").single();
  const financeRow = financeResult.data;
  if (financeResult.error || !financeRow) fail(path, "Could not create the payroll finance transaction.");

  const { data: paidRun, error: paidRunError } = await supabase
    .from("payroll_runs")
    .update({
      status: "paid",
      paid_at: paidAt,
      paid_by_user_id: profile.id,
      finance_transaction_id: String((financeRow as { id?: string | null }).id ?? ""),
      updated_at: paidAt,
    })
    .eq("id", runId)
    .select("*")
    .single();
  if (paidRunError || !paidRun) fail(path, "Finance transaction was created, but the payroll run could not be marked paid.");

  if (preview.includedRouteIds.length) {
    const routeUpdate = await supabase
      .from("routes")
      .update({ status: "paid", paid_at: paidAt })
      .in("id", preview.includedRouteIds);
    if (routeUpdate.error) fail(path, "Payroll was marked paid, but linked routes could not be updated.");
  }

  await logActivity({
    profile,
    action: "mark_paid",
    entityType: "payroll_run",
    entityId: runId,
    entityLabel: `${operatorName} payroll`,
    beforeData: existingRun,
    afterData: paidRun,
    metadata: {
      finance_transaction_id: (financeRow as { id?: string | null }).id ?? null,
      route_count: preview.completedRoutesCount,
      stop_count: preview.completedStopsCount,
      included_incident_ids: preview.includedIncidents.map((incident) => incident.incidentId),
    },
    summary: `Marked payroll run paid for ${operatorName}`,
  });

  revalidatePayrollPaths({ operatorId: existingRun.operator_id, runId });
  redirect(`${path}?paid=1`);
}
