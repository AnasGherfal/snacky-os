import "server-only";

import { getAuthAccessToken } from "@/lib/auth";
import {
  calculateRoutePay,
  dateOnly,
  ensureOperatorPayProfile,
  ensureRoutePayRules,
  isWithinPeriod,
  monthEnd,
  moneyLabel,
  routePayEligibleStatus,
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
  paid_at?: string | null;
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

type RouteExtraAggregateRow = {
  route_id?: string | null;
  extra_type?: string | null;
  amount_lyd?: number | string | null;
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
  existingPeriodId = null,
}: {
  supabase: PayrollServerClient;
  operatorId: string;
  periodStart: string;
  existingPeriodId?: string | null;
}) {
  const payProfile = await ensureOperatorPayProfile(supabase as any, operatorId);
  if (!payProfile) return null;

  const periodEnd = dateOnly(monthEnd(periodStart));
  const [{ data: routeRows }, { data: breakdownRows }, { data: adjustments }, { data: operator }] = await Promise.all([
    supabase.from("routes").select("id, route_date, status, paid_at").eq("operator_id", operatorId),
    supabase.from("route_pay_breakdowns").select("*").eq("operator_id", operatorId),
    existingPeriodId
      ? supabase.from("payroll_adjustments").select("*").eq("payroll_period_id", existingPeriodId).order("created_at", { ascending: true })
      : Promise.resolve({ data: [] }),
    supabase.from("team_members").select("id, full_name").eq("id", operatorId).maybeSingle(),
  ]);

  const typedRouteRows = (routeRows ?? []) as PayrollPeriodRouteRow[];
  const routeById = new Map<string, PayrollPeriodRouteRow>(typedRouteRows.map((route) => [route.id, route]));
  const eligibleBreakdowns = ((breakdownRows ?? []) as RoutePayBreakdownRow[])
    .filter((row) => {
      const route = routeById.get(row.route_id);
      if (!route || !isWithinPeriod(route.route_date, periodStart, periodEnd)) return false;
      const status = String(route.status ?? "");
      return routePayEligibleStatus(status) || (existingPeriodId && row.payroll_period_id === existingPeriodId);
    })
    .sort((a, b) => String(routeById.get(a.route_id)?.route_date ?? "").localeCompare(String(routeById.get(b.route_id)?.route_date ?? "")));

  const routeIds = eligibleBreakdowns.map((row) => row.route_id);
  const { data: extraRows } = routeIds.length
    ? await supabase
        .from("route_pay_extra_items")
        .select("route_id, extra_type, amount_lyd")
        .in("route_id", routeIds)
    : { data: [] };

  const breakdownExtraTotals = (extraRows ?? []).reduce(
    (totals: Record<string, number>, row: RouteExtraAggregateRow) => {
      const key = String(row.extra_type ?? "");
      totals[key] = toMoney((totals[key] ?? 0) + toMoney(row.amount_lyd));
      return totals;
    },
    {},
  );

  const bonusTotal = ((adjustments ?? []) as PayrollAdjustmentRow[])
    .filter((row) => row.adjustment_type === "bonus")
    .reduce((sum, row) => sum + toMoney(row.amount_lyd), 0);
  const deductionTotal = ((adjustments ?? []) as PayrollAdjustmentRow[])
    .filter((row) => row.adjustment_type === "deduction")
    .reduce((sum, row) => sum + toMoney(row.amount_lyd), 0);
  const routePayTotal = eligibleBreakdowns.reduce((sum, row) => sum + toMoney(row.total_pay_lyd), 0);
  const baseSalary = toMoney(payProfile.base_salary_lyd);
  const carAllowance = toMoney(payProfile.car_allowance_lyd);
  const phoneAllowance = toMoney(payProfile.phone_allowance_lyd);
  const grossTotal = toMoney(baseSalary + carAllowance + phoneAllowance + routePayTotal + bonusTotal);
  const netTotal = toMoney(grossTotal - deductionTotal);

  return {
    operator: operator ?? null,
    payProfile,
    periodStart,
    periodEnd,
    includedRouteIds: routeIds,
    eligibleBreakdowns,
    routePayTotal,
    buyingTripTotal: toMoney(breakdownExtraTotals.buying_trip_extra ?? 0),
    emergencyTotal: toMoney(breakdownExtraTotals.emergency_extra ?? 0),
    bonusTotal: toMoney(bonusTotal),
    deductionTotal: toMoney(deductionTotal),
    baseSalary,
    carAllowance,
    phoneAllowance,
    grossTotal,
    netTotal,
    routeCount: eligibleBreakdowns.length,
    summaryLabel: `${operator?.full_name ?? "Operator"} - ${periodStart} to ${periodEnd} - ${moneyLabel(netTotal)}`,
  };
}
