import "server-only";

import { getAuthAccessToken } from "@/lib/auth";
import {
  inferredRoleLevelFromTeamMember,
  isWithinPeriod,
  locationPayrollDistanceKm,
  moneyLabel,
  toMoney,
  type OperatorPayProfileRow,
} from "@/lib/payroll";
import { isCompletedRouteStatus } from "@/lib/route-workflow";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

type PayrollServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>;
type ProfileLike = {
  id?: string | null;
  role?: string | null;
  roles?: string[] | null;
  team_member_id?: string | null;
};

export type OperatorPayProfileVersionRow = {
  id: string;
  operator_id: string;
  base_monthly_salary_lyd?: number | string | null;
  pay_per_route_lyd?: number | string | null;
  pay_per_stop_lyd?: number | string | null;
  pay_per_km_lyd?: number | string | null;
  fuel_allowance_per_km_lyd?: number | string | null;
  is_active?: boolean | null;
  active_from?: string | null;
  active_to?: string | null;
  notes?: string | null;
  created_by_user_id?: string | null;
  updated_by_user_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type PayrollRunRow = {
  id: string;
  operator_id: string;
  period_start: string;
  period_end: string;
  pay_profile_id?: string | null;
  completed_routes_count?: number | null;
  completed_stops_count?: number | null;
  total_payroll_distance_km?: number | string | null;
  base_salary_amount_lyd?: number | string | null;
  route_pay_amount_lyd?: number | string | null;
  stop_pay_amount_lyd?: number | string | null;
  distance_pay_amount_lyd?: number | string | null;
  fuel_allowance_amount_lyd?: number | string | null;
  bonus_amount_lyd?: number | string | null;
  deduction_amount_lyd?: number | string | null;
  gross_pay_lyd?: number | string | null;
  net_pay_lyd?: number | string | null;
  status?: string | null;
  calculation_snapshot?: Record<string, unknown> | null;
  created_by_user_id?: string | null;
  approved_by_user_id?: string | null;
  paid_by_user_id?: string | null;
  paid_at?: string | null;
  finance_transaction_id?: string | null;
  notes?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type OperatorIncidentRow = {
  id: string;
  operator_id: string;
  route_id?: string | null;
  stop_id?: string | null;
  machine_id?: string | null;
  location_id?: string | null;
  incident_date?: string | null;
  mistake_type?: string | null;
  severity?: string | null;
  description?: string | null;
  evidence_photo_url?: string | null;
  deduction_amount_lyd?: number | string | null;
  status?: string | null;
  approved_by_user_id?: string | null;
  approved_at?: string | null;
  cancelled_by_user_id?: string | null;
  cancelled_at?: string | null;
  applied_payroll_run_id?: string | null;
  notes?: string | null;
  created_by_user_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type TeamMemberSummaryRow = {
  id: string;
  full_name?: string | null;
  role?: string | null;
  roles?: string[] | null;
  active?: boolean | null;
  active_status?: string | null;
};

type LegacyPayProfileCompanionRow = OperatorPayProfileRow;

type PayrollRouteRow = {
  id: string;
  route_date?: string | null;
  status?: string | null;
  completed_at?: string | null;
  paid_at?: string | null;
};

type PayrollStopRow = {
  id: string;
  route_id: string;
  stop_order?: number | null;
  status?: string | null;
  machine_id?: string | null;
  completed_at?: string | null;
};

type PayrollMachineRow = {
  id: string;
  name?: string | null;
  machine_code?: string | null;
  location_id?: string | null;
};

type PayrollLocationRow = {
  id: string;
  name?: string | null;
  payroll_storage_location_id?: string | null;
  distance_from_storage_km?: number | string | null;
  use_round_trip_distance?: boolean | null;
  payroll_distance_notes?: string | null;
};

type PayrollRunIncludedStop = {
  stopId: string;
  routeId: string;
  routeDate: string | null;
  routeStatus: string | null;
  stopOrder: number;
  completedAt: string | null;
  machineId: string | null;
  machineName: string;
  machineCode: string | null;
  locationId: string | null;
  locationName: string | null;
  payrollDistanceKm: number;
  distanceMissing: boolean;
};

export type PayrollRunIncludedRoute = {
  routeId: string;
  routeDate: string | null;
  routeStatus: string | null;
  completedAt: string | null;
  completedStopsCount: number;
  totalPayrollDistanceKm: number;
  missingDistanceStopCount: number;
};

export type PayrollDistanceWarning = {
  routeId: string;
  stopId: string;
  machineName: string;
  locationName: string | null;
  reason: string;
};

export type PayrollRunIncludedIncident = {
  incidentId: string;
  incidentDate: string | null;
  routeId: string | null;
  machineId: string | null;
  machineName: string;
  locationName: string | null;
  mistakeType: string;
  severity: string;
  description: string;
  deductionAmountLyd: number;
  status: string;
};

export type PayrollRunPreview = {
  operator: { id: string; full_name?: string | null } | null;
  payProfile: OperatorPayProfileVersionRow;
  legacyPayProfile: OperatorPayProfileRow;
  periodStart: string;
  periodEnd: string;
  includedRouteIds: string[];
  includedRoutes: PayrollRunIncludedRoute[];
  includedStops: PayrollRunIncludedStop[];
  includedIncidents: PayrollRunIncludedIncident[];
  missingDistanceWarnings: PayrollDistanceWarning[];
  completedRoutesCount: number;
  completedStopsCount: number;
  totalPayrollDistanceKm: number;
  baseSalaryAmount: number;
  routePayAmount: number;
  stopPayAmount: number;
  distancePayAmount: number;
  fuelAllowanceAmount: number;
  bonusAmount: number;
  deductionAmount: number;
  grossPay: number;
  netPay: number;
  summaryLabel: string;
  calculationSnapshot: Record<string, unknown>;
};

export type PayrollQueryIssue = {
  table: string;
  step: string;
  error: unknown;
  resultEmpty?: boolean | null;
};

function errorTextValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function extractMissingRelation(message: string) {
  const relationMatch = message.match(/relation ["']?(?:public\.)?([a-z0-9_]+)["']? does not exist/i);
  if (relationMatch) return relationMatch[1] ?? null;

  const tableMatch = message.match(/table ["']?(?:public\.)?([a-z0-9_]+)["']?/i);
  return tableMatch?.[1] ?? null;
}

function extractMissingColumn(message: string) {
  const columnMatch = message.match(/column ["']?([a-z0-9_]+)["']?/i);
  return columnMatch?.[1] ?? null;
}

export function payrollErrorPayload(error: unknown) {
  const payload = typeof error === "object" && error !== null ? error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } : null;
  const message = errorTextValue(payload?.message) || String(error ?? "Unknown Supabase error");
  const details = errorTextValue(payload?.details);
  const hint = errorTextValue(payload?.hint);
  const combined = [message, details, hint].filter(Boolean).join(" ");
  const lowerCombined = combined.toLowerCase();

  return {
    code: typeof payload?.code === "string" ? payload.code : null,
    message,
    details: details || null,
    hint: hint || null,
    missing_relation: extractMissingRelation(combined),
    missing_column: extractMissingColumn(combined),
    possible_rls_blocked:
      payload?.code === "42501"
      || lowerCombined.includes("permission denied")
      || lowerCombined.includes("row-level security"),
  };
}

export function logPayrollQueryIssue({
  module,
  profile,
  table,
  step,
  error,
  resultEmpty = null,
}: {
  module: string;
  profile: ProfileLike | null | undefined;
  table: string;
  step: string;
  error: unknown;
  resultEmpty?: boolean | null;
}) {
  console.error(`[${module}] Payroll query failed`, {
    table,
    query_step: step,
    current_user_id: profile?.id ?? null,
    current_user_role: profile?.role ?? null,
    current_user_roles: profile?.roles ?? [],
    current_team_member_id: profile?.team_member_id ?? null,
    result_empty: resultEmpty,
    supabase_error: payrollErrorPayload(error),
  });
}

export function buildPayrollLoadFailureBody({
  noun,
  issues,
  defaultBody,
}: {
  noun: string;
  issues: PayrollQueryIssue[];
  defaultBody: string;
}) {
  const missingRelations = Array.from(new Set(issues.map((issue) => payrollErrorPayload(issue.error).missing_relation).filter(Boolean))) as string[];
  if (missingRelations.length) {
    const label = missingRelations.map((table) => `public.${table}`).join(", ");
    const verb = missingRelations.length === 1 ? "is" : "are";
    return `Snacky OS could not load ${noun} because required database table${missingRelations.length === 1 ? "" : "s"} ${label} ${verb} missing. Run migration 202606170002_emergency_stabilization_location_leads_payroll.sql.`;
  }

  const missingColumns = Array.from(new Set(issues.map((issue) => payrollErrorPayload(issue.error).missing_column).filter(Boolean))) as string[];
  if (missingColumns.length) {
    return `Snacky OS could not load ${noun} because required database column${missingColumns.length === 1 ? "" : "s"} ${missingColumns.join(", ")} ${missingColumns.length === 1 ? "is" : "are"} missing. Run migration 202606170002_emergency_stabilization_location_leads_payroll.sql.`;
  }

  const rlsBlocked = issues.some((issue) => payrollErrorPayload(issue.error).possible_rls_blocked);
  if (rlsBlocked) {
    return `Snacky OS could not load ${noun} because database permissions blocked one of the required queries.`;
  }

  return defaultBody;
}

function parseDateOnly(value: string | null | undefined) {
  const text = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function previousDate(dateLike: string) {
  const [year, month, day] = dateLike.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export async function getPayrollV2ServerClient() {
  const accessToken = await getAuthAccessToken();
  return getSupabaseAdminClient() ?? getSupabaseServerClient(accessToken);
}

async function loadLegacyPayProfileCompanion(supabase: PayrollServerClient, operatorId: string) {
  const { data } = await supabase.from("operator_pay_profiles").select("*").eq("team_member_id", operatorId).maybeSingle();
  return (data ?? null) as LegacyPayProfileCompanionRow | null;
}

async function loadOperatorTeamMemberSummary(supabase: PayrollServerClient, operatorId: string) {
  const { data } = await supabase
    .from("team_members")
    .select("id, full_name, role, roles, active, active_status")
    .eq("id", operatorId)
    .maybeSingle();
  return (data ?? null) as TeamMemberSummaryRow | null;
}

function mapVersionToLegacyShape(
  version: OperatorPayProfileVersionRow,
  member: TeamMemberSummaryRow | null,
  legacy: LegacyPayProfileCompanionRow | null,
): OperatorPayProfileRow {
  const inferredRoleLevel = member ? inferredRoleLevelFromTeamMember(member) : "junior_operator";
  return {
    id: version.id,
    team_member_id: version.operator_id,
    role_level: legacy?.role_level ?? inferredRoleLevel,
    base_salary_lyd: toMoney(version.base_monthly_salary_lyd),
    base_monthly_salary_lyd: toMoney(version.base_monthly_salary_lyd),
    car_allowance_lyd: 0,
    phone_allowance_lyd: 0,
    default_route_base_lyd: toMoney(version.pay_per_route_lyd),
    pay_per_route_lyd: toMoney(version.pay_per_route_lyd),
    default_stop_rate_lyd: toMoney(version.pay_per_stop_lyd),
    pay_per_stop_lyd: toMoney(version.pay_per_stop_lyd),
    default_km_rate_lyd: toMoney(version.pay_per_km_lyd),
    pay_per_km_lyd: toMoney(version.pay_per_km_lyd),
    fuel_allowance_per_km_lyd: toMoney(version.fuel_allowance_per_km_lyd),
    bonus_lyd: 0,
    deduction_lyd: 0,
    can_collect_cash: legacy?.can_collect_cash ?? true,
    can_buy_stock: legacy?.can_buy_stock ?? false,
    active: Boolean(version.is_active ?? true),
    active_from: version.active_from ?? null,
    active_to: version.active_to ?? null,
    is_active: Boolean(version.is_active ?? true),
    notes: version.notes ?? null,
  };
}

export async function loadEffectiveOperatorPayProfileVersion(
  supabase: PayrollServerClient,
  operatorId: string,
  workDate?: string | null,
) {
  const effectiveDate = parseDateOnly(workDate) ?? new Date().toISOString().slice(0, 10);
  const versionQuery = await supabase
    .from("operator_pay_profile_versions")
    .select("*")
    .eq("operator_id", operatorId)
    .lte("active_from", effectiveDate)
    .or(`active_to.is.null,active_to.gte.${effectiveDate}`)
    .order("is_active", { ascending: false })
    .order("active_from", { ascending: false })
    .order("updated_at", { ascending: false });
  if (versionQuery.error) {
    console.error("[payroll-v2] Failed to load effective operator pay profile version", {
      table: "operator_pay_profile_versions",
      query_step: "load_effective_operator_pay_profile_version",
      operator_id: operatorId,
      effective_date: effectiveDate,
      result_empty: false,
      supabase_error: payrollErrorPayload(versionQuery.error),
    });
    return null;
  }
  const version = ((versionQuery.data ?? []) as OperatorPayProfileVersionRow[])[0] ?? null;
  if (!version) return null;

  const [member, legacy] = await Promise.all([
    loadOperatorTeamMemberSummary(supabase, operatorId),
    loadLegacyPayProfileCompanion(supabase, operatorId),
  ]);

  return {
    version,
    legacy: mapVersionToLegacyShape(version, member, legacy),
    member,
  };
}

export async function loadCurrentOperatorPayProfileLegacyShape(
  supabase: PayrollServerClient,
  operatorId: string,
  workDate?: string | null,
) {
  const resolved = await loadEffectiveOperatorPayProfileVersion(supabase, operatorId, workDate);
  return resolved?.legacy ?? null;
}

export async function listOperatorPayProfileVersionsResult(supabase: PayrollServerClient, operatorIds?: string[]) {
  let query = supabase
    .from("operator_pay_profile_versions")
    .select("*")
    .order("is_active", { ascending: false })
    .order("active_from", { ascending: false })
    .order("updated_at", { ascending: false });
  if (operatorIds?.length) query = query.in("operator_id", operatorIds);
  const { data, error } = await query;
  return {
    data: (data ?? []) as OperatorPayProfileVersionRow[],
    error: error ?? null,
  };
}

export async function listOperatorPayProfileVersions(supabase: PayrollServerClient, operatorIds?: string[]) {
  const result = await listOperatorPayProfileVersionsResult(supabase, operatorIds);
  if (result.error) {
    console.error("[payroll-v2] Failed to list operator pay profile versions", {
      table: "operator_pay_profile_versions",
      query_step: "list_operator_pay_profile_versions",
      operator_ids: operatorIds ?? [],
      result_empty: false,
      supabase_error: payrollErrorPayload(result.error),
    });
    return [] as OperatorPayProfileVersionRow[];
  }
  return result.data;
}

export async function buildPayrollRunPreview({
  supabase,
  operatorId,
  periodStart,
  periodEnd,
  existingRunId = null,
}: {
  supabase: PayrollServerClient;
  operatorId: string;
  periodStart: string;
  periodEnd: string;
  existingRunId?: string | null;
}): Promise<PayrollRunPreview | null> {
  const payProfileData = await loadEffectiveOperatorPayProfileVersion(supabase, operatorId, periodEnd);
  if (!payProfileData) return null;

  const [{ data: routeRows }, { data: incidentRows }, { data: operator }] = await Promise.all([
    supabase.from("routes").select("id, route_date, status, completed_at, paid_at").eq("operator_id", operatorId),
    supabase
      .from("operator_incidents")
      .select("*")
      .eq("operator_id", operatorId)
      .gte("incident_date", periodStart)
      .lte("incident_date", periodEnd)
      .order("incident_date", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase.from("team_members").select("id, full_name").eq("id", operatorId).maybeSingle(),
  ]);

  const typedRouteRows = (routeRows ?? []) as PayrollRouteRow[];
  const completedRoutes = typedRouteRows
    .filter((route) => {
      if (!isCompletedRouteStatus(route.status)) return false;
      return isWithinPeriod(route.completed_at ?? route.route_date, periodStart, periodEnd);
    })
    .sort((a, b) => String(a.completed_at ?? a.route_date ?? "").localeCompare(String(b.completed_at ?? b.route_date ?? "")));
  const routeById = new Map(completedRoutes.map((route) => [route.id, route]));
  const routeIds = completedRoutes.map((route) => route.id);

  const { data: stopRows } = routeIds.length
    ? await supabase
        .from("route_stops")
        .select("id, route_id, stop_order, status, machine_id, completed_at")
        .in("route_id", routeIds)
        .order("stop_order", { ascending: true })
    : { data: [] };

  const completedStops = ((stopRows ?? []) as PayrollStopRow[])
    .filter((stop) => {
      if (String(stop.status ?? "") !== "completed") return false;
      const route = routeById.get(stop.route_id);
      return Boolean(route) && isWithinPeriod(stop.completed_at ?? route?.completed_at ?? route?.route_date, periodStart, periodEnd);
    })
    .sort((a, b) => {
      const routeDateA = String(routeById.get(a.route_id)?.completed_at ?? routeById.get(a.route_id)?.route_date ?? "");
      const routeDateB = String(routeById.get(b.route_id)?.completed_at ?? routeById.get(b.route_id)?.route_date ?? "");
      if (routeDateA !== routeDateB) return routeDateA.localeCompare(routeDateB);
      return Number(a.stop_order ?? 0) - Number(b.stop_order ?? 0);
    });

  const machineIds = Array.from(new Set(completedStops.map((stop) => stop.machine_id).filter(Boolean)));
  const { data: machineRows } = machineIds.length
    ? await supabase.from("machines").select("id, name, machine_code, location_id").in("id", machineIds)
    : { data: [] };
  const machines = (machineRows ?? []) as PayrollMachineRow[];
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));

  const locationIds = Array.from(new Set(machines.map((machine) => machine.location_id).filter(Boolean)));
  const { data: locationRows } = locationIds.length
    ? await supabase
        .from("locations")
        .select("id, name, payroll_storage_location_id, distance_from_storage_km, use_round_trip_distance, payroll_distance_notes")
        .in("id", locationIds)
    : { data: [] };
  const locationById = new Map(((locationRows ?? []) as PayrollLocationRow[]).map((location) => [location.id, location]));

  const includedStops: PayrollRunIncludedStop[] = [];
  const includedRoutes: PayrollRunIncludedRoute[] = [];
  const missingDistanceWarnings: PayrollDistanceWarning[] = [];
  const routeDistanceTotals = new Map<string, { completedStopsCount: number; totalPayrollDistanceKm: number; missingDistanceStopCount: number }>();

  for (const stop of completedStops) {
    const route = routeById.get(stop.route_id);
    const machine = stop.machine_id ? machineById.get(stop.machine_id) : null;
    const location = machine?.location_id ? locationById.get(machine.location_id) : null;
    const payrollDistanceKm = location ? locationPayrollDistanceKm(location) : null;
    const distanceMissing = payrollDistanceKm === null;
    const normalizedDistanceKm = toMoney(payrollDistanceKm ?? 0);

    includedStops.push({
      stopId: stop.id,
      routeId: stop.route_id,
      routeDate: route?.route_date ?? null,
      routeStatus: route?.status ?? null,
      stopOrder: Number(stop.stop_order ?? 0),
      completedAt: stop.completed_at ?? route?.completed_at ?? null,
      machineId: stop.machine_id ?? null,
      machineName: machine?.name ?? "Unknown machine",
      machineCode: machine?.machine_code ?? null,
      locationId: machine?.location_id ?? null,
      locationName: location?.name ?? null,
      payrollDistanceKm: normalizedDistanceKm,
      distanceMissing,
    });

    const routeTotals = routeDistanceTotals.get(stop.route_id) ?? {
      completedStopsCount: 0,
      totalPayrollDistanceKm: 0,
      missingDistanceStopCount: 0,
    };
    routeTotals.completedStopsCount += 1;
    routeTotals.totalPayrollDistanceKm = toMoney(routeTotals.totalPayrollDistanceKm + normalizedDistanceKm);
    routeTotals.missingDistanceStopCount += distanceMissing ? 1 : 0;
    routeDistanceTotals.set(stop.route_id, routeTotals);

    if (distanceMissing) {
      missingDistanceWarnings.push({
        routeId: stop.route_id,
        stopId: stop.id,
        machineName: machine?.name ?? "Unknown machine",
        locationName: location?.name ?? null,
        reason: location
          ? "This location does not have a payroll distance yet."
          : "This machine is not mapped to a location with payroll distance settings.",
      });
    }
  }

  for (const route of completedRoutes) {
    const totals = routeDistanceTotals.get(route.id) ?? {
      completedStopsCount: 0,
      totalPayrollDistanceKm: 0,
      missingDistanceStopCount: 0,
    };
    includedRoutes.push({
      routeId: route.id,
      routeDate: route.route_date ?? null,
      routeStatus: route.status ?? null,
      completedAt: route.completed_at ?? null,
      completedStopsCount: totals.completedStopsCount,
      totalPayrollDistanceKm: toMoney(totals.totalPayrollDistanceKm),
      missingDistanceStopCount: totals.missingDistanceStopCount,
    });
  }

  const incidents = ((incidentRows ?? []) as OperatorIncidentRow[]).filter((incident) => {
    const status = String(incident.status ?? "");
    if (incident.applied_payroll_run_id) return incident.applied_payroll_run_id === existingRunId;
    return status === "approved";
  });
  const incidentMachineIds = Array.from(new Set(incidents.map((incident) => incident.machine_id).filter(Boolean)));
  const incidentLocationIds = Array.from(new Set(incidents.map((incident) => incident.location_id).filter(Boolean)));
  const [incidentMachinesResult, incidentLocationsResult] = await Promise.all([
    incidentMachineIds.length
      ? supabase.from("machines").select("id, name, machine_code, location_id").in("id", incidentMachineIds)
      : Promise.resolve({ data: [] }),
    incidentLocationIds.length
      ? supabase.from("locations").select("id, name").in("id", incidentLocationIds)
      : Promise.resolve({ data: [] }),
  ]);
  const incidentMachineById = new Map(((incidentMachinesResult.data ?? []) as PayrollMachineRow[]).map((machine) => [machine.id, machine]));
  const incidentLocationById = new Map(((incidentLocationsResult.data ?? []) as Array<{ id: string; name?: string | null }>).map((location) => [location.id, location]));

  const includedIncidents: PayrollRunIncludedIncident[] = incidents.map((incident) => ({
    incidentId: incident.id,
    incidentDate: incident.incident_date ?? null,
    routeId: incident.route_id ?? null,
    machineId: incident.machine_id ?? null,
    machineName: incident.machine_id ? incidentMachineById.get(incident.machine_id)?.name ?? "Unknown machine" : "Not linked",
    locationName: incident.location_id ? incidentLocationById.get(incident.location_id)?.name ?? null : null,
    mistakeType: String(incident.mistake_type ?? "other"),
    severity: String(incident.severity ?? "level_1_small"),
    description: String(incident.description ?? "").trim(),
    deductionAmountLyd: toMoney(incident.deduction_amount_lyd),
    status: String(incident.status ?? "pending"),
  }));

  const completedRoutesCount = includedRoutes.length;
  const completedStopsCount = includedStops.length;
  const totalPayrollDistanceKm = toMoney(includedStops.reduce((sum, stop) => sum + stop.payrollDistanceKm, 0));
  const baseSalaryAmount = toMoney(payProfileData.version.base_monthly_salary_lyd);
  const routePayAmount = toMoney(completedRoutesCount * toMoney(payProfileData.version.pay_per_route_lyd));
  const stopPayAmount = toMoney(completedStopsCount * toMoney(payProfileData.version.pay_per_stop_lyd));
  const distancePayAmount = toMoney(totalPayrollDistanceKm * toMoney(payProfileData.version.pay_per_km_lyd));
  const fuelAllowanceAmount = toMoney(totalPayrollDistanceKm * toMoney(payProfileData.version.fuel_allowance_per_km_lyd));
  const bonusAmount = 0;
  const deductionAmount = toMoney(includedIncidents.reduce((sum, incident) => sum + incident.deductionAmountLyd, 0));
  const grossPay = toMoney(baseSalaryAmount + routePayAmount + stopPayAmount + distancePayAmount + fuelAllowanceAmount + bonusAmount);
  const netPay = toMoney(grossPay - deductionAmount);

  const calculationSnapshot = {
    period_start: periodStart,
    period_end: periodEnd,
    operator_id: operatorId,
    pay_profile: {
      id: payProfileData.version.id,
      active_from: payProfileData.version.active_from ?? null,
      active_to: payProfileData.version.active_to ?? null,
      base_monthly_salary_lyd: baseSalaryAmount,
      pay_per_route_lyd: toMoney(payProfileData.version.pay_per_route_lyd),
      pay_per_stop_lyd: toMoney(payProfileData.version.pay_per_stop_lyd),
      pay_per_km_lyd: toMoney(payProfileData.version.pay_per_km_lyd),
      fuel_allowance_per_km_lyd: toMoney(payProfileData.version.fuel_allowance_per_km_lyd),
      notes: payProfileData.version.notes ?? null,
    },
    totals: {
      completed_routes_count: completedRoutesCount,
      completed_stops_count: completedStopsCount,
      total_payroll_distance_km: totalPayrollDistanceKm,
      base_salary_amount_lyd: baseSalaryAmount,
      route_pay_amount_lyd: routePayAmount,
      stop_pay_amount_lyd: stopPayAmount,
      distance_pay_amount_lyd: distancePayAmount,
      fuel_allowance_amount_lyd: fuelAllowanceAmount,
      bonus_amount_lyd: bonusAmount,
      deduction_amount_lyd: deductionAmount,
      gross_pay_lyd: grossPay,
      net_pay_lyd: netPay,
      missing_distance_stop_count: missingDistanceWarnings.length,
    },
    included_routes: includedRoutes,
    included_stops: includedStops,
    included_incidents: includedIncidents,
    missing_distance_warnings: missingDistanceWarnings,
  } satisfies Record<string, unknown>;

  return {
    operator: firstRelation(operator) ?? null,
    payProfile: payProfileData.version,
    legacyPayProfile: payProfileData.legacy,
    periodStart,
    periodEnd,
    includedRouteIds: includedRoutes.map((route) => route.routeId),
    includedRoutes,
    includedStops,
    includedIncidents,
    missingDistanceWarnings,
    completedRoutesCount,
    completedStopsCount,
    totalPayrollDistanceKm,
    baseSalaryAmount,
    routePayAmount,
    stopPayAmount,
    distancePayAmount,
    fuelAllowanceAmount,
    bonusAmount,
    deductionAmount,
    grossPay,
    netPay,
    summaryLabel: `${firstRelation(operator)?.full_name ?? "Operator"} - ${periodStart} to ${periodEnd} - ${moneyLabel(netPay)}`,
    calculationSnapshot,
  };
}

export function payrollFinancePayload({
  run,
  operatorName,
  createdByTeamMemberId,
  paidAt,
}: {
  run: PayrollRunRow;
  operatorName: string;
  createdByTeamMemberId: string | null;
  paidAt: string;
}) {
  const amount = toMoney(run.net_pay_lyd);
  const date = paidAt.slice(0, 10);
  const routeCount = Number(run.completed_routes_count ?? 0);
  const stopCount = Number(run.completed_stops_count ?? 0);
  const notes = `Payroll ${run.period_start} to ${run.period_end} - ${routeCount} routes, ${stopCount} stops`;
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
    signed_amount: -Math.abs(amount),
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
    source_id: run.id,
    created_by: createdByTeamMemberId,
    metadata: {
      payroll_run_id: run.id,
      route_count: routeCount,
      stop_count: stopCount,
      period_start: run.period_start,
      period_end: run.period_end,
    },
    updated_at: new Date().toISOString(),
  };
}

export { previousDate };
