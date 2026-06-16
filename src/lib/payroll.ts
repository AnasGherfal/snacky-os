import { normalizeRoles } from "@/lib/authz";

export const operatorRoleLevels = ["junior_operator", "senior_operator", "backup_operator"] as const;
export type OperatorRoleLevel = (typeof operatorRoleLevels)[number];

export const routeDistanceZones = ["within_10_km", "km_11_20", "km_21_35", "km_36_50", "km_51_70", "km_70_plus"] as const;
export type RouteDistanceZone = (typeof routeDistanceZones)[number];

export const routeAccessDifficulties = ["easy", "normal", "hard", "very_hard"] as const;
export type RouteAccessDifficulty = (typeof routeAccessDifficulties)[number];

export const routePayExtraTypes = [
  "cash_collection_extra",
  "deep_cleaning_extra",
  "simple_fix_extra",
  "emergency_extra",
  "friday_holiday_extra",
  "buying_trip_extra",
  "heavy_load_extra",
] as const;
export type RoutePayExtraType = (typeof routePayExtraTypes)[number];

export const payrollPeriodStatuses = ["draft", "calculated", "paid", "disputed"] as const;
export type PayrollPeriodStatus = (typeof payrollPeriodStatuses)[number];

export type OperatorPayProfileRow = {
  id: string;
  team_member_id: string;
  role_level: OperatorRoleLevel;
  base_salary_lyd: number | string | null;
  base_monthly_salary_lyd?: number | string | null;
  car_allowance_lyd: number | string | null;
  phone_allowance_lyd: number | string | null;
  default_route_base_lyd: number | string | null;
  pay_per_route_lyd?: number | string | null;
  default_stop_rate_lyd: number | string | null;
  pay_per_stop_lyd?: number | string | null;
  default_km_rate_lyd: number | string | null;
  pay_per_km_lyd?: number | string | null;
  fuel_allowance_per_km_lyd?: number | string | null;
  bonus_lyd?: number | string | null;
  deduction_lyd?: number | string | null;
  can_collect_cash: boolean | null;
  can_buy_stock: boolean | null;
  active: boolean | null;
  active_from?: string | null;
  active_to?: string | null;
  is_active?: boolean | null;
  notes?: string | null;
};

export type RoutePayRulesRow = {
  id: string;
  distance_pay_mode: "zone" | "km_rate" | string | null;
  zone_0_10_lyd: number | string | null;
  zone_11_20_lyd: number | string | null;
  zone_21_35_lyd: number | string | null;
  zone_36_50_lyd: number | string | null;
  zone_51_70_lyd: number | string | null;
  zone_70_plus_lyd?: number | string | null;
  zone_over_70_requires_approval?: boolean | null;
  cash_collection_extra_lyd: number | string | null;
  deep_cleaning_extra_lyd: number | string | null;
  simple_fix_extra_lyd: number | string | null;
  emergency_extra_lyd: number | string | null;
  friday_holiday_extra_lyd: number | string | null;
  buying_trip_extra_lyd: number | string | null;
  heavy_load_extra_lyd: number | string | null;
  notes?: string | null;
};

export type RoutePayExtraItemRow = {
  id?: string;
  route_id?: string | null;
  route_stop_id?: string | null;
  extra_type: RoutePayExtraType | string;
  amount_lyd: number | string | null;
  notes?: string | null;
  created_at?: string | null;
};

export type RoutePayBreakdownRow = {
  id?: string;
  route_id: string;
  operator_id?: string | null;
  operator_pay_profile_id?: string | null;
  pay_rule_id?: string | null;
  storage_location_id?: string | null;
  payroll_period_id?: string | null;
  route_status?: string | null;
  distance_km?: number | string | null;
  distance_zone?: RouteDistanceZone | string | null;
  distance_source?: string | null;
  stop_count?: number | null;
  total_stop_multiplier?: number | string | null;
  route_base_lyd?: number | string | null;
  stop_pay_lyd?: number | string | null;
  distance_pay_lyd?: number | string | null;
  load_difficulty_pay_lyd?: number | string | null;
  extras_pay_lyd?: number | string | null;
  manual_adjustment_lyd?: number | string | null;
  manual_adjustment_reason?: string | null;
  total_pay_lyd?: number | string | null;
  approval_required?: boolean | null;
  approved_by?: string | null;
  approved_at?: string | null;
  locked_by?: string | null;
  locked_at?: string | null;
  breakdown?: Record<string, unknown> | null;
  recalculated_at?: string | null;
  updated_at?: string | null;
};

export type PayrollPeriodRow = {
  id: string;
  operator_id: string;
  operator_pay_profile_id?: string | null;
  period_start: string;
  period_end: string;
  status: PayrollPeriodStatus | string;
  base_salary_lyd: number | string | null;
  base_salary_amount_lyd?: number | string | null;
  car_allowance_lyd: number | string | null;
  phone_allowance_lyd: number | string | null;
  route_pay_total_lyd: number | string | null;
  route_pay_amount_lyd?: number | string | null;
  stop_pay_amount_lyd?: number | string | null;
  distance_pay_amount_lyd?: number | string | null;
  fuel_allowance_amount_lyd?: number | string | null;
  buying_trip_total_lyd: number | string | null;
  emergency_total_lyd: number | string | null;
  bonus_total_lyd: number | string | null;
  deduction_total_lyd: number | string | null;
  gross_total_lyd: number | string | null;
  net_total_lyd: number | string | null;
  route_count: number | null;
  completed_routes_count?: number | null;
  completed_stops_count?: number | null;
  total_payroll_distance_km?: number | string | null;
  missing_distance_stop_count?: number | null;
  calculation_snapshot?: Record<string, unknown> | null;
  notes?: string | null;
  paid_at?: string | null;
  finance_transaction_id?: string | null;
};

export type PayrollAdjustmentRow = {
  id?: string;
  payroll_period_id: string;
  adjustment_type: "bonus" | "deduction" | string;
  label: string;
  amount_lyd: number | string | null;
  reason: string;
};

export type StorageLocationSummary = {
  id: string;
  name: string;
  address?: string | null;
  active?: boolean | null;
  location_type?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
};

export type RouteStopPayInput = {
  route_stop_id: string;
  stop_order: number;
  status?: string | null;
  machine_id?: string | null;
  machine_name: string;
  machine_code?: string | null;
  location_id?: string | null;
  location_name?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  distance_zone?: RouteDistanceZone | string | null;
  access_difficulty?: RouteAccessDifficulty | string | null;
  stop_multiplier?: number | string | null;
};

export type RoutePayCalculationInput = {
  route: {
    id: string;
    route_date?: string | null;
    operator_id?: string | null;
    status?: string | null;
    storage_location_id?: string | null;
    distance_km?: number | string | null;
    distance_zone?: RouteDistanceZone | string | null;
    distance_source?: string | null;
    load_difficulty_pay_lyd?: number | string | null;
  };
  operatorProfile: OperatorPayProfileRow;
  payRules: RoutePayRulesRow;
  stops: RouteStopPayInput[];
  extras?: RoutePayExtraItemRow[];
  breakdown?: Partial<RoutePayBreakdownRow> | null;
  storageLocation?: StorageLocationSummary | null;
  cashCollectionCount?: number;
  overrides?: {
    storage_location_id?: string | null;
    distance_km?: number | string | null;
    distance_zone?: RouteDistanceZone | string | null;
    distance_source?: string | null;
    load_difficulty_pay_lyd?: number | string | null;
    manual_adjustment_lyd?: number | string | null;
    manual_adjustment_reason?: string | null;
  };
};

export type RoutePayCalculationResult = {
  routeId: string;
  routeDate: string | null;
  routeStatus: string | null;
  operatorId: string | null;
  operatorPayProfileId: string;
  payRuleId: string;
  storageLocationId: string | null;
  storageLocationName: string | null;
  distanceKm: number | null;
  distanceZone: RouteDistanceZone;
  distanceSource: string;
  stopCount: number;
  totalStopMultiplier: number;
  routeBasePay: number;
  stopPay: number;
  distancePay: number;
  distancePayByZone: number;
  distancePayByKm: number;
  loadDifficultyPay: number;
  extrasPay: number;
  manualAdjustment: number;
  manualAdjustmentReason: string | null;
  totalPay: number;
  approvalRequired: boolean;
  stopLines: Array<RouteStopPayInput & { normalizedMultiplier: number; stopPay: number }>;
  extraLines: Array<{ source: "manual" | "automatic"; extraType: string; amount: number; notes: string | null; routeStopId: string | null }>;
  breakdown: Record<string, unknown>;
};

export type RoutePayRulesStore = {
  from(table: "route_pay_rules"): {
    select(columns: string): {
      eq(column: "id", value: string): {
        maybeSingle(): PromiseLike<{ data: RoutePayRulesRow | null }>;
      };
    };
    upsert(payload: RoutePayRulesRow, options: { onConflict: string }): {
      select(columns: string): {
        single(): PromiseLike<{ data: RoutePayRulesRow | null }>;
      };
    };
  };
};

type TeamMemberProfileSeedRow = {
  id: string;
  role?: string | null;
  roles?: string[] | null;
  active?: boolean | null;
  active_status?: string | null;
};

export type OperatorPayProfileStore = {
  from(table: "operator_pay_profiles"): {
    select(columns: string): {
      eq(column: "team_member_id", value: string): {
        maybeSingle(): PromiseLike<{ data: OperatorPayProfileRow | null }>;
      };
    };
    insert(payload: Record<string, unknown>): {
      select(columns: string): {
        single(): PromiseLike<{ data: OperatorPayProfileRow | null }>;
      };
    };
  };
  from(table: "team_members"): {
    select(columns: string): {
      eq(column: "id", value: string): {
        maybeSingle(): PromiseLike<{ data: TeamMemberProfileSeedRow | null }>;
      };
    };
  };
};

const distanceZoneRank: Record<RouteDistanceZone, number> = {
  within_10_km: 0,
  km_11_20: 1,
  km_21_35: 2,
  km_36_50: 3,
  km_51_70: 4,
  km_70_plus: 5,
};

const distanceZoneLabels: Record<RouteDistanceZone, string> = {
  within_10_km: "0-10 km",
  km_11_20: "11-20 km",
  km_21_35: "21-35 km",
  km_36_50: "36-50 km",
  km_51_70: "51-70 km",
  km_70_plus: "70+ km",
};

const accessDifficultyLabels: Record<RouteAccessDifficulty, string> = {
  easy: "Easy",
  normal: "Normal",
  hard: "Hard",
  very_hard: "Very hard",
};

const routeExtraLabels: Record<RoutePayExtraType, string> = {
  cash_collection_extra: "Cash collection",
  deep_cleaning_extra: "Deep cleaning",
  simple_fix_extra: "Simple fix",
  emergency_extra: "Emergency visit",
  friday_holiday_extra: "Friday / holiday",
  buying_trip_extra: "Buying trip",
  heavy_load_extra: "Heavy load",
};

const roleLevelDefaults: Record<OperatorRoleLevel, Omit<OperatorPayProfileRow, "id" | "team_member_id">> = {
  senior_operator: {
    role_level: "senior_operator",
    base_salary_lyd: 1300,
    base_monthly_salary_lyd: 1300,
    car_allowance_lyd: 400,
    phone_allowance_lyd: 50,
    default_route_base_lyd: 30,
    pay_per_route_lyd: 30,
    default_stop_rate_lyd: 30,
    pay_per_stop_lyd: 30,
    default_km_rate_lyd: 0.5,
    pay_per_km_lyd: 0.5,
    fuel_allowance_per_km_lyd: 0,
    bonus_lyd: 0,
    deduction_lyd: 0,
    can_collect_cash: true,
    can_buy_stock: true,
    active: true,
    active_from: new Date().toISOString().slice(0, 10),
    active_to: null,
    is_active: true,
    notes: "Snacky senior / trusted operator default profile.",
  },
  junior_operator: {
    role_level: "junior_operator",
    base_salary_lyd: 900,
    base_monthly_salary_lyd: 900,
    car_allowance_lyd: 250,
    phone_allowance_lyd: 0,
    default_route_base_lyd: 20,
    pay_per_route_lyd: 20,
    default_stop_rate_lyd: 25,
    pay_per_stop_lyd: 25,
    default_km_rate_lyd: 0.4,
    pay_per_km_lyd: 0.4,
    fuel_allowance_per_km_lyd: 0,
    bonus_lyd: 0,
    deduction_lyd: 0,
    can_collect_cash: false,
    can_buy_stock: false,
    active: true,
    active_from: new Date().toISOString().slice(0, 10),
    active_to: null,
    is_active: true,
    notes: "Snacky junior operator default profile.",
  },
  backup_operator: {
    role_level: "backup_operator",
    base_salary_lyd: 0,
    base_monthly_salary_lyd: 0,
    car_allowance_lyd: 0,
    phone_allowance_lyd: 0,
    default_route_base_lyd: 20,
    pay_per_route_lyd: 20,
    default_stop_rate_lyd: 25,
    pay_per_stop_lyd: 25,
    default_km_rate_lyd: 0.4,
    pay_per_km_lyd: 0.4,
    fuel_allowance_per_km_lyd: 0,
    bonus_lyd: 0,
    deduction_lyd: 0,
    can_collect_cash: false,
    can_buy_stock: false,
    active: true,
    active_from: new Date().toISOString().slice(0, 10),
    active_to: null,
    is_active: true,
    notes: "Snacky backup operator default profile.",
  },
};

const routePayRuleDefaults: Omit<RoutePayRulesRow, "id"> = {
  distance_pay_mode: "zone",
  zone_0_10_lyd: 0,
  zone_11_20_lyd: 10,
  zone_21_35_lyd: 20,
  zone_36_50_lyd: 35,
  zone_51_70_lyd: 50,
  zone_70_plus_lyd: null,
  zone_over_70_requires_approval: true,
  cash_collection_extra_lyd: 20,
  deep_cleaning_extra_lyd: 0,
  simple_fix_extra_lyd: 0,
  emergency_extra_lyd: 40,
  friday_holiday_extra_lyd: 0,
  buying_trip_extra_lyd: 90,
  heavy_load_extra_lyd: 0,
  notes: "Snacky OS default route pay rules.",
};

export function toMoney(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
}

export function moneyLabel(value: unknown) {
  return `${toMoney(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} LYD`;
}

export function operatorPayProfileBaseMonthlySalary(profile: Pick<OperatorPayProfileRow, "base_monthly_salary_lyd" | "base_salary_lyd">) {
  return toMoney(profile.base_monthly_salary_lyd ?? profile.base_salary_lyd);
}

export function operatorPayProfilePayPerRoute(profile: Pick<OperatorPayProfileRow, "pay_per_route_lyd" | "default_route_base_lyd">) {
  return toMoney(profile.pay_per_route_lyd ?? profile.default_route_base_lyd);
}

export function operatorPayProfilePayPerStop(profile: Pick<OperatorPayProfileRow, "pay_per_stop_lyd" | "default_stop_rate_lyd">) {
  return toMoney(profile.pay_per_stop_lyd ?? profile.default_stop_rate_lyd);
}

export function operatorPayProfilePayPerKm(profile: Pick<OperatorPayProfileRow, "pay_per_km_lyd" | "default_km_rate_lyd">) {
  return toMoney(profile.pay_per_km_lyd ?? profile.default_km_rate_lyd);
}

export function operatorPayProfileFuelAllowancePerKm(profile: Pick<OperatorPayProfileRow, "fuel_allowance_per_km_lyd">) {
  return toMoney(profile.fuel_allowance_per_km_lyd);
}

export function operatorPayProfileBonus(profile: Pick<OperatorPayProfileRow, "bonus_lyd">) {
  return toMoney(profile.bonus_lyd);
}

export function operatorPayProfileDeduction(profile: Pick<OperatorPayProfileRow, "deduction_lyd">) {
  return toMoney(profile.deduction_lyd);
}

export function operatorPayProfileIsActive(profile: Pick<OperatorPayProfileRow, "is_active" | "active">) {
  return Boolean(profile.is_active ?? profile.active ?? true);
}

export function locationPayrollDistanceKm(location: {
  distance_from_storage_km?: number | string | null;
  use_round_trip_distance?: boolean | null;
}) {
  const baseDistance = location.distance_from_storage_km;
  if (baseDistance === null || baseDistance === undefined || baseDistance === "") return null;
  const normalizedDistance = toMoney(baseDistance);
  return toMoney(normalizedDistance * (location.use_round_trip_distance ? 2 : 1));
}

export function routeDistanceZoneLabel(zone: RouteDistanceZone | string | null | undefined) {
  const normalized = normalizeDistanceZone(zone);
  return distanceZoneLabels[normalized];
}

export function routeAccessDifficultyLabel(value: RouteAccessDifficulty | string | null | undefined) {
  const normalized = normalizeRouteAccessDifficulty(value);
  return accessDifficultyLabels[normalized];
}

export function routeExtraTypeLabel(value: RoutePayExtraType | string | null | undefined) {
  const normalized = normalizeRoutePayExtraType(value);
  return routeExtraLabels[normalized];
}

export function normalizeOperatorRoleLevel(value: string | null | undefined): OperatorRoleLevel {
  return operatorRoleLevels.includes(String(value ?? "") as OperatorRoleLevel)
    ? (value as OperatorRoleLevel)
    : "junior_operator";
}

export function normalizeDistanceZone(value: string | null | undefined): RouteDistanceZone {
  return routeDistanceZones.includes(String(value ?? "") as RouteDistanceZone)
    ? (value as RouteDistanceZone)
    : "within_10_km";
}

export function normalizeRouteAccessDifficulty(value: string | null | undefined): RouteAccessDifficulty {
  return routeAccessDifficulties.includes(String(value ?? "") as RouteAccessDifficulty)
    ? (value as RouteAccessDifficulty)
    : "normal";
}

export function normalizeRoutePayExtraType(value: string | null | undefined): RoutePayExtraType {
  return routePayExtraTypes.includes(String(value ?? "") as RoutePayExtraType)
    ? (value as RoutePayExtraType)
    : "simple_fix_extra";
}

export function defaultOperatorPayProfileValues(roleLevel: OperatorRoleLevel) {
  return { ...roleLevelDefaults[roleLevel] };
}

export function defaultRoutePayRulesValues(): RoutePayRulesRow {
  return { id: "default", ...routePayRuleDefaults };
}

export function inferredRoleLevelFromTeamMember(member: { role?: string | null; roles?: string[] | null }) {
  const roles = normalizeRoles(member.roles, member.role);
  if (roles.some((role) => ["owner", "admin", "supervisor"].includes(role))) return "senior_operator" satisfies OperatorRoleLevel;
  if (roles.includes("operator")) return "junior_operator" satisfies OperatorRoleLevel;
  return "backup_operator" satisfies OperatorRoleLevel;
}

export function distanceZoneFromKm(value: unknown): RouteDistanceZone {
  const km = toMoney(value);
  if (km <= 10) return "within_10_km";
  if (km <= 20) return "km_11_20";
  if (km <= 35) return "km_21_35";
  if (km <= 50) return "km_36_50";
  if (km <= 70) return "km_51_70";
  return "km_70_plus";
}

export function highestDistanceZone(values: Array<RouteDistanceZone | string | null | undefined>) {
  return values
    .map((value) => normalizeDistanceZone(value))
    .sort((a, b) => distanceZoneRank[b] - distanceZoneRank[a])[0] ?? "within_10_km";
}

export function distancePayForZone(zone: RouteDistanceZone | string | null | undefined, rules: RoutePayRulesRow) {
  switch (normalizeDistanceZone(zone)) {
    case "within_10_km":
      return toMoney(rules.zone_0_10_lyd);
    case "km_11_20":
      return toMoney(rules.zone_11_20_lyd);
    case "km_21_35":
      return toMoney(rules.zone_21_35_lyd);
    case "km_36_50":
      return toMoney(rules.zone_36_50_lyd);
    case "km_51_70":
      return toMoney(rules.zone_51_70_lyd);
    case "km_70_plus":
      return toMoney(rules.zone_70_plus_lyd);
    default:
      return 0;
  }
}

export function resolveRouteDistance({
  distanceKm,
  distanceZone,
  stopZones,
}: {
  distanceKm?: unknown;
  distanceZone?: string | null;
  stopZones?: Array<string | null | undefined>;
}) {
  const normalizedKm = distanceKm === null || distanceKm === undefined || distanceKm === "" ? null : toMoney(distanceKm);
  if (normalizedKm !== null && normalizedKm > 0) {
    return {
      distanceKm: normalizedKm,
      distanceZone: distanceZoneFromKm(normalizedKm),
      distanceSource: "km_manual",
    };
  }
  if (distanceZone) {
    return {
      distanceKm: null,
      distanceZone: normalizeDistanceZone(distanceZone),
      distanceSource: "route_zone",
    };
  }
  return {
    distanceKm: null,
    distanceZone: highestDistanceZone(stopZones ?? []),
    distanceSource: "location_zone",
  };
}

export function resolveRoutePayExtraAmount(extraType: RoutePayExtraType | string, rules: RoutePayRulesRow) {
  switch (normalizeRoutePayExtraType(extraType)) {
    case "cash_collection_extra":
      return toMoney(rules.cash_collection_extra_lyd);
    case "deep_cleaning_extra":
      return toMoney(rules.deep_cleaning_extra_lyd);
    case "simple_fix_extra":
      return toMoney(rules.simple_fix_extra_lyd);
    case "emergency_extra":
      return toMoney(rules.emergency_extra_lyd);
    case "friday_holiday_extra":
      return toMoney(rules.friday_holiday_extra_lyd);
    case "buying_trip_extra":
      return toMoney(rules.buying_trip_extra_lyd);
    case "heavy_load_extra":
      return toMoney(rules.heavy_load_extra_lyd);
    default:
      return 0;
  }
}

export function routePayEligibleStatus(status: string | null | undefined) {
  return ["verified", "payroll_pending", "paid"].includes(String(status ?? ""));
}

export function monthStart(dateLike: string | Date) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function monthEnd(dateLike: string | Date) {
  const start = monthStart(dateLike);
  return new Date(start.getFullYear(), start.getMonth() + 1, 0);
}

export function dateOnly(dateLike: string | Date) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function isWithinPeriod(dateLike: string | null | undefined, periodStart: string, periodEnd: string) {
  if (!dateLike) return false;
  const date = String(dateLike).slice(0, 10);
  return date >= periodStart && date <= periodEnd;
}

export async function ensureRoutePayRules(supabase: RoutePayRulesStore): Promise<RoutePayRulesRow> {
  const { data } = await supabase.from("route_pay_rules").select("*").eq("id", "default").maybeSingle();
  if (data) return data as RoutePayRulesRow;

  const payload = {
    ...defaultRoutePayRulesValues(),
  };
  const inserted = await supabase.from("route_pay_rules").upsert(payload, { onConflict: "id" }).select("*").single();
  return (inserted.data ?? payload) as RoutePayRulesRow;
}

export async function ensureOperatorPayProfile(supabase: OperatorPayProfileStore, teamMemberId: string) {
  const existing = await supabase.from("operator_pay_profiles").select("*").eq("team_member_id", teamMemberId).maybeSingle();
  if (existing.data) return existing.data as OperatorPayProfileRow;

  const memberResult = await supabase
    .from("team_members")
    .select("id, role, roles, active, active_status")
    .eq("id", teamMemberId)
    .maybeSingle();
  if (!memberResult.data) return null;

  const roleLevel = inferredRoleLevelFromTeamMember(memberResult.data);
  const defaults = defaultOperatorPayProfileValues(roleLevel);
  const activeFrom = new Date().toISOString().slice(0, 10);
  const inserted = await supabase
    .from("operator_pay_profiles")
    .insert({
      team_member_id: teamMemberId,
      role_level: roleLevel,
      base_salary_lyd: defaults.base_salary_lyd,
      base_monthly_salary_lyd: defaults.base_monthly_salary_lyd ?? defaults.base_salary_lyd,
      car_allowance_lyd: defaults.car_allowance_lyd,
      phone_allowance_lyd: defaults.phone_allowance_lyd,
      default_route_base_lyd: defaults.default_route_base_lyd,
      pay_per_route_lyd: defaults.pay_per_route_lyd ?? defaults.default_route_base_lyd,
      default_stop_rate_lyd: defaults.default_stop_rate_lyd,
      pay_per_stop_lyd: defaults.pay_per_stop_lyd ?? defaults.default_stop_rate_lyd,
      default_km_rate_lyd: defaults.default_km_rate_lyd,
      pay_per_km_lyd: defaults.pay_per_km_lyd ?? defaults.default_km_rate_lyd,
      fuel_allowance_per_km_lyd: defaults.fuel_allowance_per_km_lyd ?? 0,
      bonus_lyd: defaults.bonus_lyd ?? 0,
      deduction_lyd: defaults.deduction_lyd ?? 0,
      can_collect_cash: defaults.can_collect_cash,
      can_buy_stock: defaults.can_buy_stock,
      active: memberResult.data.active_status ? memberResult.data.active_status === "active" : memberResult.data.active !== false,
      active_from: activeFrom,
      active_to: null,
      is_active: memberResult.data.active_status ? memberResult.data.active_status === "active" : memberResult.data.active !== false,
      notes: defaults.notes,
      updated_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  return (inserted.data ?? null) as OperatorPayProfileRow | null;
}

export function calculateRoutePay(input: RoutePayCalculationInput): RoutePayCalculationResult {
  const profile = input.operatorProfile;
  const rules = input.payRules;
  const breakdown = input.breakdown ?? {};
  const overrides = input.overrides ?? {};
  const resolvedDistance = resolveRouteDistance({
    distanceKm: overrides.distance_km ?? input.route.distance_km,
    distanceZone: String(overrides.distance_zone ?? input.route.distance_zone ?? ""),
    stopZones: input.stops.map((stop) => stop.distance_zone),
  });
  const distanceSource = String(
    overrides.distance_source
      ?? input.route.distance_source
      ?? resolvedDistance.distanceSource,
  ).trim() || resolvedDistance.distanceSource;
  const stopLines = input.stops
    .slice()
    .sort((a, b) => a.stop_order - b.stop_order)
    .map((stop) => {
      const normalizedMultiplier = Math.max(0.1, toMoney(stop.stop_multiplier || 1));
      return {
        ...stop,
        normalizedMultiplier,
        stopPay: operatorPayProfilePayPerStop(profile) * normalizedMultiplier,
      };
    });

  const routeBasePay = operatorPayProfilePayPerRoute(profile);
  const stopPay = toMoney(stopLines.reduce((sum, stop) => sum + stop.stopPay, 0));
  const distancePayByZone = distancePayForZone(resolvedDistance.distanceZone, rules);
  const distancePayByKm = resolvedDistance.distanceKm === null
    ? 0
    : toMoney(resolvedDistance.distanceKm * operatorPayProfilePayPerKm(profile));
  const distancePay = String(rules.distance_pay_mode ?? "zone") === "km_rate" && resolvedDistance.distanceKm !== null
    ? distancePayByKm
    : distancePayByZone;
  const loadDifficultyPay = toMoney(overrides.load_difficulty_pay_lyd ?? input.route.load_difficulty_pay_lyd);
  const manualAdjustment = toMoney(overrides.manual_adjustment_lyd ?? breakdown.manual_adjustment_lyd);
  const manualAdjustmentReason = String(
    overrides.manual_adjustment_reason
      ?? breakdown.manual_adjustment_reason
      ?? "",
  ).trim() || null;

  const manualExtras = (input.extras ?? []).map((extra) => ({
    source: "manual" as const,
    extraType: normalizeRoutePayExtraType(extra.extra_type),
    amount: toMoney(extra.amount_lyd),
    notes: String(extra.notes ?? "").trim() || null,
    routeStopId: extra.route_stop_id ? String(extra.route_stop_id) : null,
  }));

  const automaticExtras = [];
  if ((input.cashCollectionCount ?? 0) > 0 && profile.can_collect_cash) {
    automaticExtras.push({
      source: "automatic" as const,
      extraType: "cash_collection_extra",
      amount: resolveRoutePayExtraAmount("cash_collection_extra", rules),
      notes: "Auto-added because the route has counted cash collection records.",
      routeStopId: null,
    });
  }

  const extraLines = [...automaticExtras, ...manualExtras];
  const extrasPay = toMoney(extraLines.reduce((sum, extra) => sum + extra.amount, 0));
  const totalStopMultiplier = toMoney(stopLines.reduce((sum, stop) => sum + stop.normalizedMultiplier, 0));
  const totalPay = toMoney(routeBasePay + stopPay + distancePay + loadDifficultyPay + extrasPay + manualAdjustment);
  const approvalRequired = resolvedDistance.distanceZone === "km_70_plus" && Boolean(rules.zone_over_70_requires_approval ?? true);
  const storageLocationId = String(
    overrides.storage_location_id
      ?? input.route.storage_location_id
      ?? input.storageLocation?.id
      ?? "",
  ).trim() || null;
  const storageLocationName = input.storageLocation?.name ?? null;

  const breakdownJson = {
    route_date: input.route.route_date ?? null,
    route_status: input.route.status ?? null,
    storage_location: storageLocationId
      ? {
          id: storageLocationId,
          name: storageLocationName,
        }
      : null,
    profile_snapshot: {
      role_level: profile.role_level,
      base_salary_lyd: operatorPayProfileBaseMonthlySalary(profile),
      car_allowance_lyd: toMoney(profile.car_allowance_lyd),
      phone_allowance_lyd: toMoney(profile.phone_allowance_lyd),
      default_route_base_lyd: routeBasePay,
      default_stop_rate_lyd: operatorPayProfilePayPerStop(profile),
      default_km_rate_lyd: operatorPayProfilePayPerKm(profile),
      fuel_allowance_per_km_lyd: operatorPayProfileFuelAllowancePerKm(profile),
      bonus_lyd: operatorPayProfileBonus(profile),
      deduction_lyd: operatorPayProfileDeduction(profile),
      can_collect_cash: Boolean(profile.can_collect_cash),
      can_buy_stock: Boolean(profile.can_buy_stock),
    },
    rules_snapshot: {
      distance_pay_mode: String(rules.distance_pay_mode ?? "zone"),
      zone_0_10_lyd: toMoney(rules.zone_0_10_lyd),
      zone_11_20_lyd: toMoney(rules.zone_11_20_lyd),
      zone_21_35_lyd: toMoney(rules.zone_21_35_lyd),
      zone_36_50_lyd: toMoney(rules.zone_36_50_lyd),
      zone_51_70_lyd: toMoney(rules.zone_51_70_lyd),
      zone_70_plus_lyd: toMoney(rules.zone_70_plus_lyd),
      zone_over_70_requires_approval: Boolean(rules.zone_over_70_requires_approval ?? true),
    },
    distance: {
      distance_km: resolvedDistance.distanceKm,
      distance_zone: resolvedDistance.distanceZone,
      distance_zone_label: routeDistanceZoneLabel(resolvedDistance.distanceZone),
      distance_source: distanceSource,
      zone_pay_lyd: distancePayByZone,
      km_pay_lyd: distancePayByKm,
      applied_pay_lyd: distancePay,
    },
    stop_lines: stopLines.map((stop) => ({
      route_stop_id: stop.route_stop_id,
      stop_order: stop.stop_order,
      machine_id: stop.machine_id ?? null,
      machine_name: stop.machine_name,
      machine_code: stop.machine_code ?? null,
      location_id: stop.location_id ?? null,
      location_name: stop.location_name ?? null,
      distance_zone: normalizeDistanceZone(stop.distance_zone),
      access_difficulty: normalizeRouteAccessDifficulty(stop.access_difficulty),
      stop_multiplier: stop.normalizedMultiplier,
      stop_pay_lyd: toMoney(stop.stopPay),
    })),
    extras: extraLines.map((extra) => ({
      source: extra.source,
      extra_type: extra.extraType,
      extra_label: routeExtraTypeLabel(extra.extraType),
      amount_lyd: extra.amount,
      route_stop_id: extra.routeStopId,
      notes: extra.notes,
    })),
    totals: {
      route_base_lyd: routeBasePay,
      stop_pay_lyd: stopPay,
      distance_pay_lyd: distancePay,
      load_difficulty_pay_lyd: loadDifficultyPay,
      extras_pay_lyd: extrasPay,
      manual_adjustment_lyd: manualAdjustment,
      total_pay_lyd: totalPay,
      stop_count: stopLines.length,
      total_stop_multiplier: totalStopMultiplier,
      approval_required: approvalRequired,
    },
  } satisfies Record<string, unknown>;

  return {
    routeId: input.route.id,
    routeDate: input.route.route_date ?? null,
    routeStatus: input.route.status ?? null,
    operatorId: input.route.operator_id ?? null,
    operatorPayProfileId: profile.id,
    payRuleId: rules.id,
    storageLocationId,
    storageLocationName,
    distanceKm: resolvedDistance.distanceKm,
    distanceZone: resolvedDistance.distanceZone,
    distanceSource,
    stopCount: stopLines.length,
    totalStopMultiplier,
    routeBasePay,
    stopPay,
    distancePay,
    distancePayByZone,
    distancePayByKm,
    loadDifficultyPay,
    extrasPay,
    manualAdjustment,
    manualAdjustmentReason,
    totalPay,
    approvalRequired,
    stopLines,
    extraLines,
    breakdown: breakdownJson,
  };
}
