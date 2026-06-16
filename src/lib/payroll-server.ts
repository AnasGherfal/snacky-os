import "server-only";

import { getAuthAccessToken } from "@/lib/auth";
import {
  calculateRoutePay,
  ensureOperatorPayProfile,
  ensureRoutePayRules,
  isWithinPeriod,
  locationPayrollDistanceKm,
  moneyLabel,
  operatorPayProfileBaseMonthlySalary,
  operatorPayProfileBonus,
  operatorPayProfileDeduction,
  operatorPayProfileFuelAllowancePerKm,
  operatorPayProfilePayPerKm,
  operatorPayProfilePayPerRoute,
  operatorPayProfilePayPerStop,
  toMoney,
  type OperatorPayProfileRow,
  type PayrollAdjustmentRow,
  type RoutePayBreakdownRow,
  type RoutePayCalculationResult,
  type RoutePayCalculationInput,
  type RoutePayExtraItemRow,
  type RoutePayRulesRow,
  type RouteStopPayInput,
  type StorageLocationSummary,
} from "@/lib/payroll";
import { isCompletedRouteStatus } from "@/lib/route-workflow";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase-server";

type PayrollServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

type LoadedRouteRow = {
  id: string;
  route_date?: string | null;
  operator_id?: string | null;
  status?: string | null;
  storage_location_id?: string | null;
  distance_km?: number | string | null;
  distance_zone?: string | null;
  distance_source?: string | null;
  load_difficulty_pay_lyd?: number | string | null;
  verified_at?: string | null;
  verified_by?: string | null;
  paid_at?: string | null;
  notes?: string | null;
};

type LoadedOperatorRow = {
  id: string;
  full_name?: string | null;
  role?: string | null;
  roles?: string[] | null;
  active?: boolean | null;
  active_status?: string | null;
};

export type OperatorRoutePreviewStopRow = {
  id: string;
  stop_order?: number | null;
  status?: string | null;
  machine_id?: string | null;
};

export type LoadedRoutePayData = {
  supabase: PayrollServerClient;
  route: LoadedRouteRow;
  operator: LoadedOperatorRow | null;
  payProfile: OperatorPayProfileRow | null;
  payRules: RoutePayRulesRow;
  breakdown: RoutePayBreakdownRow | null;
  extras: RoutePayExtraItemRow[];
  cashCollectionCount: number;
  storageLocations: StorageLocationSummary[];
  selectedStorageLocation: StorageLocationSummary | null;
  stops: RouteStopPayInput[];
  calculation: RoutePayCalculationResult | null;
};

export type OperatorRoutePreviewRow = {
  id: string;
  route_date?: string | null;
  operator_id?: string | null;
  status?: string | null;
  storage_location_id?: string | null;
  distance_km?: number | string | null;
  distance_zone?: string | null;
  distance_source?: string | null;
  load_difficulty_pay_lyd?: number | string | null;
  route_stops?: OperatorRoutePreviewStopRow[] | null;
};

export type OperatorRoutePayPreview = {
  routeId: string;
  source: "saved" | "estimated" | "unavailable";
  totalPay: number | null;
  savedTotalPay: number | null;
  estimatedTotalPay: number | null;
  approvalRequired: boolean;
  payrollPeriodId: string | null;
};

type PayrollPeriodRouteRow = {
  id: string;
  route_date: string | null;
  status: string | null;
  completed_at?: string | null;
  paid_at?: string | null;
};

type PayrollPeriodStopRow = {
  id: string;
  route_id: string;
  stop_order?: number | null;
  status?: string | null;
  machine_id?: string | null;
  completed_at?: string | null;
};

type PayrollPeriodMachineRow = {
  id: string;
  name?: string | null;
  machine_code?: string | null;
  location_id?: string | null;
};

type PayrollPeriodLocationRow = {
  id: string;
  name?: string | null;
  payroll_storage_location_id?: string | null;
  distance_from_storage_km?: number | string | null;
  use_round_trip_distance?: boolean | null;
  payroll_distance_notes?: string | null;
};

export type PayrollPeriodIncludedStop = {
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

export type PayrollPeriodIncludedRoute = {
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

export type PayrollPeriodSummary = {
  operator: { id: string; full_name?: string | null } | null;
  payProfile: OperatorPayProfileRow;
  periodStart: string;
  periodEnd: string;
  includedRouteIds: string[];
  includedRoutes: PayrollPeriodIncludedRoute[];
  includedStops: PayrollPeriodIncludedStop[];
  missingDistanceWarnings: PayrollDistanceWarning[];
  completedRoutesCount: number;
  completedStopsCount: number;
  totalPayrollDistanceKm: number;
  baseSalaryAmount: number;
  routePayAmount: number;
  stopPayAmount: number;
  distancePayAmount: number;
  fuelAllowanceAmount: number;
  profileBonusAmount: number;
  profileDeductionAmount: number;
  adjustmentBonusAmount: number;
  adjustmentDeductionAmount: number;
  bonusAmount: number;
  deductionAmount: number;
  grossPay: number;
  netPay: number;
  summaryLabel: string;
  calculationSnapshot: Record<string, unknown>;
};

type RouteStopRow = {
  id: string;
  stop_order?: number | null;
  status?: string | null;
  machine_id?: string | null;
};

type MachineLocationRow = {
  id: string;
  name?: string | null;
  machine_code?: string | null;
  location_id?: string | null;
};

type LocationPayRow = {
  id: string;
  name?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  distance_zone?: string | null;
  access_difficulty?: string | null;
  stop_multiplier?: number | string | null;
};

type CashCollectionRouteRow = {
  route_id?: string | null;
};

type RouteBreakdownPreviewRow = {
  route_id: string;
  total_pay_lyd?: number | string | null;
  approval_required?: boolean | null;
  payroll_period_id?: string | null;
};

export async function getPayrollServerClient() {
  const accessToken = await getAuthAccessToken();
  return getSupabaseAdminClient() ?? getSupabaseServerClient(accessToken);
}

function storageLocationSortKey(location: StorageLocationSummary) {
  const type = String(location?.location_type ?? "");
  const typeRank = type === "main_storage" ? 0 : type === "vehicle" ? 1 : type === "temporary" ? 2 : 3;
  return `${typeRank}-${String(location?.name ?? "")}`;
}

function chooseStorageLocation(locations: StorageLocationSummary[], selectedId?: string | null) {
  if (selectedId) {
    const selected = locations.find((location) => location.id === selectedId);
    if (selected) return selected;
  }
  return [...locations].sort((a, b) => storageLocationSortKey(a).localeCompare(storageLocationSortKey(b)))[0] ?? null;
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export async function loadOperatorRoutePayPreviewMap({
  supabase,
  routes,
  viewerTeamMemberId,
}: {
  supabase: PayrollServerClient;
  routes: OperatorRoutePreviewRow[];
  viewerTeamMemberId?: string | null;
}) {
  const routeIds = routes.map((route) => route.id).filter(Boolean);
  const routeStops = routes.flatMap((route) =>
    (route.route_stops ?? []).map((stop) => ({
      route_id: route.id,
      id: stop.id,
      stop_order: Number(stop.stop_order ?? 0),
      status: stop.status ?? null,
      machine_id: stop.machine_id ?? null,
    })),
  );
  const machineIds = Array.from(new Set(routeStops.map((stop) => stop.machine_id).filter(Boolean)));

  const payRules = await ensureRoutePayRules(supabase as any);
  const payProfile = viewerTeamMemberId ? await ensureOperatorPayProfile(supabase as any, viewerTeamMemberId) : null;
  const [breakdownResult, cashCollectionResult, machinesResult] = await Promise.all([
    routeIds.length
      ? supabase
          .from("route_pay_breakdowns")
          .select("route_id, total_pay_lyd, approval_required, payroll_period_id")
          .in("route_id", routeIds)
      : Promise.resolve({ data: [] }),
    routeIds.length
      ? supabase.from("cash_collections").select("route_id").in("route_id", routeIds)
      : Promise.resolve({ data: [] }),
    machineIds.length
      ? supabase.from("machines").select("id, name, machine_code, location_id").in("id", machineIds)
      : Promise.resolve({ data: [] }),
  ]);

  const locationIds = Array.from(
    new Set(((machinesResult.data ?? []) as Array<{ location_id?: string | null }>).map((machine) => machine.location_id).filter(Boolean)),
  );
  const locationsResult = locationIds.length
    ? await supabase
        .from("locations")
        .select("id, name, latitude, longitude, distance_zone, access_difficulty, stop_multiplier")
        .in("id", locationIds)
    : { data: [] };

  const breakdownByRouteId = new Map(
    ((breakdownResult.data ?? []) as RouteBreakdownPreviewRow[]).map((row) => [row.route_id, row]),
  );
  const cashCollectionCountByRouteId = ((cashCollectionResult.data ?? []) as CashCollectionRouteRow[]).reduce(
    (map, row) => {
      const routeId = String(row.route_id ?? "");
      if (!routeId) return map;
      map.set(routeId, (map.get(routeId) ?? 0) + 1);
      return map;
    },
    new Map<string, number>(),
  );
  const machineById = new Map(
    ((machinesResult.data ?? []) as MachineLocationRow[]).map((machine) => [
      machine.id,
      machine,
    ]),
  );
  const locationById = new Map(
    ((locationsResult.data ?? []) as LocationPayRow[]).map((location) => [location.id, location]),
  );

  const previewByRouteId = new Map<string, OperatorRoutePayPreview>();
  for (const route of routes) {
    const savedBreakdown = breakdownByRouteId.get(route.id);
    if (savedBreakdown) {
      const savedTotal = toMoney(savedBreakdown.total_pay_lyd);
      previewByRouteId.set(route.id, {
        routeId: route.id,
        source: "saved",
        totalPay: savedTotal,
        savedTotalPay: savedTotal,
        estimatedTotalPay: savedTotal,
        approvalRequired: Boolean(savedBreakdown.approval_required),
        payrollPeriodId: savedBreakdown.payroll_period_id ?? null,
      });
      continue;
    }

    if (!payProfile) {
      previewByRouteId.set(route.id, {
        routeId: route.id,
        source: "unavailable",
        totalPay: null,
        savedTotalPay: null,
        estimatedTotalPay: null,
        approvalRequired: false,
        payrollPeriodId: null,
      });
      continue;
    }

    const stopInputs: RouteStopPayInput[] = routeStops
      .filter((stop) => stop.route_id === route.id)
      .sort((a, b) => a.stop_order - b.stop_order)
      .map((stop) => {
        const machine = stop.machine_id ? machineById.get(stop.machine_id) : null;
        const location = machine?.location_id ? locationById.get(machine.location_id) : null;
        return {
          route_stop_id: stop.id,
          stop_order: stop.stop_order,
          status: stop.status,
          machine_id: stop.machine_id,
          machine_name: machine?.name ?? "Unknown machine",
          machine_code: machine?.machine_code ?? null,
          location_id: machine?.location_id ?? null,
          location_name: location?.name ?? null,
          latitude: location?.latitude ?? null,
          longitude: location?.longitude ?? null,
          distance_zone: location?.distance_zone ?? null,
          access_difficulty: location?.access_difficulty ?? null,
          stop_multiplier: location?.stop_multiplier ?? 1,
        };
      });

    const calculation = calculateRoutePay({
      route,
      operatorProfile: payProfile,
      payRules,
      stops: stopInputs,
      cashCollectionCount: cashCollectionCountByRouteId.get(route.id) ?? 0,
    });

    previewByRouteId.set(route.id, {
      routeId: route.id,
      source: "estimated",
      totalPay: calculation.totalPay,
      savedTotalPay: null,
      estimatedTotalPay: calculation.totalPay,
      approvalRequired: calculation.approvalRequired,
      payrollPeriodId: null,
    });
  }

  return {
    payProfile,
    payRules,
    previewByRouteId,
  };
}

export async function loadRoutePayData(routeId: string, overrides?: RoutePayCalculationInput["overrides"]) {
  const supabase = await getPayrollServerClient();
  if (!supabase) return null;

  const { data: route } = await supabase
    .from("routes")
    .select("id, route_date, operator_id, status, storage_location_id, distance_km, distance_zone, distance_source, load_difficulty_pay_lyd, verified_at, verified_by, paid_at, notes")
    .eq("id", routeId)
    .maybeSingle();
  if (!route) return null;

  const [{ data: operator }, { data: stops }, { data: extras }, { data: breakdown }, { count: cashCollectionCount }, { data: storageLocations }] = await Promise.all([
    route.operator_id
      ? supabase.from("team_members").select("id, full_name, role, roles, active, active_status").eq("id", route.operator_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("route_stops").select("id, stop_order, status, machine_id").eq("route_id", routeId).order("stop_order", { ascending: true }),
    supabase.from("route_pay_extra_items").select("id, route_id, route_stop_id, extra_type, amount_lyd, notes, created_at").eq("route_id", routeId).order("created_at", { ascending: true }),
    supabase.from("route_pay_breakdowns").select("*").eq("route_id", routeId).maybeSingle(),
    supabase.from("cash_collections").select("id", { count: "exact", head: true }).eq("route_id", routeId),
    supabase
      .from("storage_locations")
      .select("id, name, address, active, location_type, latitude, longitude")
      .eq("active", true)
      .in("location_type", ["main_storage", "vehicle", "temporary", "other"])
      .order("name"),
  ]);

  const stopRows = (stops ?? []) as RouteStopRow[];
  const machineIds = Array.from(new Set(stopRows.map((stop) => stop.machine_id).filter(Boolean)));
  const { data: machines } = machineIds.length
    ? await supabase.from("machines").select("id, name, machine_code, location_id").in("id", machineIds)
    : { data: [] };
  const machineRows = (machines ?? []) as MachineLocationRow[];
  const locationIds = Array.from(new Set(machineRows.map((machine) => machine.location_id).filter(Boolean)));
  const { data: locations } = locationIds.length
    ? await supabase.from("locations").select("id, name, latitude, longitude, distance_zone, access_difficulty, stop_multiplier").in("id", locationIds)
    : { data: [] };

  const machineById = new Map(machineRows.map((machine) => [machine.id, machine]));
  const locationById = new Map(((locations ?? []) as LocationPayRow[]).map((location) => [location.id, location]));
  const stopInputs: RouteStopPayInput[] = stopRows.map((stop) => {
    const machine = stop.machine_id ? machineById.get(stop.machine_id) : null;
    const location = machine?.location_id ? locationById.get(machine.location_id) : null;
    return {
      route_stop_id: stop.id,
      stop_order: Number(stop.stop_order ?? 0),
      status: stop.status ?? null,
      machine_id: stop.machine_id ?? null,
      machine_name: machine?.name ?? "Unknown machine",
      machine_code: machine?.machine_code ?? null,
      location_id: machine?.location_id ?? null,
      location_name: location?.name ?? null,
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      distance_zone: location?.distance_zone ?? null,
      access_difficulty: location?.access_difficulty ?? null,
      stop_multiplier: location?.stop_multiplier ?? 1,
    };
  });

  const payRules = await ensureRoutePayRules(supabase as any);
  const payProfile = route.operator_id ? await ensureOperatorPayProfile(supabase as any, String(route.operator_id)) : null;
  const selectedStorageLocation = chooseStorageLocation((storageLocations ?? []) as StorageLocationSummary[], route.storage_location_id ?? null);
  const calculation = payProfile
    ? calculateRoutePay({
        route,
        operatorProfile: payProfile,
        payRules,
        stops: stopInputs,
        extras: (extras ?? []) as RoutePayExtraItemRow[],
        breakdown: (breakdown ?? null) as RoutePayBreakdownRow | null,
        storageLocation: selectedStorageLocation,
        cashCollectionCount: cashCollectionCount ?? 0,
        overrides,
      })
    : null;

  return {
    supabase,
    route,
    operator: firstRelation(operator),
    payProfile,
    payRules,
    breakdown: (breakdown ?? null) as RoutePayBreakdownRow | null,
    extras: (extras ?? []) as RoutePayExtraItemRow[],
    cashCollectionCount: cashCollectionCount ?? 0,
    storageLocations: (storageLocations ?? []) as StorageLocationSummary[],
    selectedStorageLocation,
    stops: stopInputs,
    calculation,
  } satisfies LoadedRoutePayData;
}

export async function buildPayrollPeriodSummary({
  supabase,
  operatorId,
  periodStart,
  periodEnd,
  existingPeriodId = null,
}: {
  supabase: PayrollServerClient;
  operatorId: string;
  periodStart: string;
  periodEnd: string;
  existingPeriodId?: string | null;
}): Promise<PayrollPeriodSummary | null> {
  const payProfile = await ensureOperatorPayProfile(supabase as any, operatorId);
  if (!payProfile) return null;

  const [{ data: routeRows }, { data: adjustments }, { data: operator }] = await Promise.all([
    supabase.from("routes").select("id, route_date, status, completed_at, paid_at").eq("operator_id", operatorId),
    existingPeriodId
      ? supabase.from("payroll_adjustments").select("*").eq("payroll_period_id", existingPeriodId).order("created_at", { ascending: true })
      : Promise.resolve({ data: [] }),
    supabase.from("team_members").select("id, full_name").eq("id", operatorId).maybeSingle(),
  ]);

  const typedRouteRows = (routeRows ?? []) as PayrollPeriodRouteRow[];
  const completedRoutes = typedRouteRows
    .filter((route) => {
      if (!isCompletedRouteStatus(route.status)) return false;
      return isWithinPeriod(route.completed_at ?? route.route_date, periodStart, periodEnd);
    })
    .sort((a, b) => String(a.completed_at ?? a.route_date ?? "").localeCompare(String(b.completed_at ?? b.route_date ?? "")));

  const routeById = new Map<string, PayrollPeriodRouteRow>(completedRoutes.map((route) => [route.id, route]));
  const routeIds = completedRoutes.map((route) => route.id);
  const { data: stopRows } = routeIds.length
    ? await supabase.from("route_stops").select("id, route_id, stop_order, status, machine_id, completed_at").in("route_id", routeIds).order("stop_order", { ascending: true })
    : { data: [] };

  const completedStops = ((stopRows ?? []) as PayrollPeriodStopRow[])
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
  const machines = (machineRows ?? []) as PayrollPeriodMachineRow[];
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const locationIds = Array.from(new Set(machines.map((machine) => machine.location_id).filter(Boolean)));
  const { data: locationRows } = locationIds.length
    ? await supabase
        .from("locations")
        .select("id, name, payroll_storage_location_id, distance_from_storage_km, use_round_trip_distance, payroll_distance_notes")
        .in("id", locationIds)
    : { data: [] };
  const locationById = new Map(((locationRows ?? []) as PayrollPeriodLocationRow[]).map((location) => [location.id, location]));

  const bonusTotal = ((adjustments ?? []) as PayrollAdjustmentRow[])
    .filter((row) => row.adjustment_type === "bonus")
    .reduce((sum, row) => sum + toMoney(row.amount_lyd), 0);
  const deductionTotal = ((adjustments ?? []) as PayrollAdjustmentRow[])
    .filter((row) => row.adjustment_type === "deduction")
    .reduce((sum, row) => sum + toMoney(row.amount_lyd), 0);

  const includedStops: PayrollPeriodIncludedStop[] = [];
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

  const includedRoutes: PayrollPeriodIncludedRoute[] = completedRoutes.map((route) => {
    const totals = routeDistanceTotals.get(route.id) ?? {
      completedStopsCount: 0,
      totalPayrollDistanceKm: 0,
      missingDistanceStopCount: 0,
    };
    return {
      routeId: route.id,
      routeDate: route.route_date ?? null,
      routeStatus: route.status ?? null,
      completedAt: route.completed_at ?? null,
      completedStopsCount: totals.completedStopsCount,
      totalPayrollDistanceKm: toMoney(totals.totalPayrollDistanceKm),
      missingDistanceStopCount: totals.missingDistanceStopCount,
    };
  });

  const completedRoutesCount = includedRoutes.length;
  const completedStopsCount = includedStops.length;
  const totalPayrollDistanceKm = toMoney(includedStops.reduce((sum, stop) => sum + stop.payrollDistanceKm, 0));
  const baseSalaryAmount = operatorPayProfileBaseMonthlySalary(payProfile);
  const routePayAmount = toMoney(completedRoutesCount * operatorPayProfilePayPerRoute(payProfile));
  const stopPayAmount = toMoney(completedStopsCount * operatorPayProfilePayPerStop(payProfile));
  const distancePayAmount = toMoney(totalPayrollDistanceKm * operatorPayProfilePayPerKm(payProfile));
  const fuelAllowanceAmount = toMoney(totalPayrollDistanceKm * operatorPayProfileFuelAllowancePerKm(payProfile));
  const profileBonusAmount = operatorPayProfileBonus(payProfile);
  const profileDeductionAmount = operatorPayProfileDeduction(payProfile);
  const adjustmentBonusAmount = toMoney(bonusTotal);
  const adjustmentDeductionAmount = toMoney(deductionTotal);
  const bonusAmount = toMoney(profileBonusAmount + adjustmentBonusAmount);
  const deductionAmount = toMoney(profileDeductionAmount + adjustmentDeductionAmount);
  const grossPay = toMoney(baseSalaryAmount + routePayAmount + stopPayAmount + distancePayAmount + fuelAllowanceAmount + bonusAmount);
  const netPay = toMoney(grossPay - deductionAmount);

  const calculationSnapshot = {
    period_start: periodStart,
    period_end: periodEnd,
    operator_id: operatorId,
    rates: {
      base_monthly_salary_lyd: baseSalaryAmount,
      pay_per_route_lyd: operatorPayProfilePayPerRoute(payProfile),
      pay_per_stop_lyd: operatorPayProfilePayPerStop(payProfile),
      pay_per_km_lyd: operatorPayProfilePayPerKm(payProfile),
      fuel_allowance_per_km_lyd: operatorPayProfileFuelAllowancePerKm(payProfile),
      bonus_lyd: profileBonusAmount,
      deduction_lyd: profileDeductionAmount,
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
    missing_distance_warnings: missingDistanceWarnings,
  } satisfies Record<string, unknown>;

  return {
    operator: operator ?? null,
    payProfile,
    periodStart,
    periodEnd,
    includedRouteIds: includedRoutes.map((route) => route.routeId),
    includedRoutes,
    includedStops,
    missingDistanceWarnings,
    completedRoutesCount,
    completedStopsCount,
    totalPayrollDistanceKm,
    baseSalaryAmount,
    routePayAmount,
    stopPayAmount,
    distancePayAmount,
    fuelAllowanceAmount,
    profileBonusAmount,
    profileDeductionAmount,
    adjustmentBonusAmount,
    adjustmentDeductionAmount,
    bonusAmount,
    deductionAmount,
    grossPay,
    netPay,
    summaryLabel: `${operator?.full_name ?? "Operator"} - ${periodStart} to ${periodEnd} - ${moneyLabel(netPay)}`,
    calculationSnapshot,
  };
}
