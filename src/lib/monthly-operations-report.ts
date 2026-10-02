export type MonthlyRouteRow = {
  id: string;
  route_date: string;
  operator_id: string | null;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancellation_reason: string | null;
};

export type MonthlyStopRow = {
  id: string;
  route_id: string;
  machine_id: string | null;
  status: string | null;
  completed_at: string | null;
};

export type MonthlyMovementRow = {
  related_route_id: string | null;
  related_route_stop_id: string | null;
  related_machine_id: string | null;
  quantity: number | null;
  reason: string | null;
  source_type: string | null;
  from_entity_type: string | null;
  to_entity_type: string | null;
};

export type MonthlyRefillRow = {
  route_id: string | null;
  route_stop_id: string | null;
  machine_id: string | null;
  fill_status: string | null;
  issues_found: boolean | null;
};

export type MonthlyManualSaleRow = {
  route_id: string;
  operator_id: string | null;
  quantity: number | null;
  total_amount_lyd: number | string | null;
  status: string | null;
};

export type MonthlyFillLineRow = {
  route_id: string;
  route_stop_id: string;
  machine_id: string | null;
  action_type: string | null;
  assigned_qty: number | null;
  actual_qty: number | null;
  difference_qty: number | null;
  needs_review: boolean | null;
};

type FillAuditTotals = {
  assignedUnits: number;
  recordedFillUnits: number;
  shortageUnits: number;
  overPlanUnits: number;
  zeroFillLines: number;
  reviewLines: number;
};

type UnitTotals = {
  loaded: number;
  filled: number;
  returned: number;
  damaged: number;
  machineStorage: number;
};

export type MonthlyOperatorSummary = UnitTotals & FillAuditTotals & {
  operatorId: string;
  assignedRoutes: number;
  completedRoutes: number;
  completedVisits: number;
  fillVisits: number;
  totalStops: number;
  uniqueMachines: number;
  fullFills: number;
  partialFills: number;
  manualSaleUnits: number;
  manualSalesLyd: number;
};

export type MonthlyMachineSummary = {
  machineId: string;
  completedVisits: number;
  fillVisits: number;
  filledUnits: number;
  fullFills: number;
  partialFills: number;
  issueVisits: number;
  shortageUnits: number;
  zeroFillLines: number;
  routes: number;
  operators: string[];
  lastServiceDate: string | null;
};

export type MonthlyDailySummary = UnitTotals & {
  date: string;
  routesScheduled: number;
  routesCompleted: number;
  fillVisits: number;
  uniqueMachines: number;
};

export type MonthlyRouteSummary = UnitTotals & FillAuditTotals & {
  routeId: string;
  routeDate: string;
  operatorId: string | null;
  status: string;
  totalStops: number;
  completedStops: number;
  skippedStops: number;
  openStops: number;
  partialFills: number;
  issueVisits: number;
  manualSaleUnits: number;
  cancellationReason: string | null;
};

export type MonthlyOperationsReport = {
  summary: UnitTotals & FillAuditTotals & {
    routesScheduled: number;
    routesCompleted: number;
    routesCancelled: number;
    routesOpen: number;
    routeCompletionRate: number;
    totalStops: number;
    completedVisits: number;
    fillVisits: number;
    skippedStops: number;
    openStops: number;
    stopCompletionRate: number;
    uniqueMachines: number;
    uniqueMachinesFilled: number;
    activeOperators: number;
    fullFills: number;
    partialFills: number;
    issueVisits: number;
    manualSaleUnits: number;
    manualSalesLyd: number;
    fillPlanRate: number | null;
    averageRouteMinutes: number | null;
  };
  operators: MonthlyOperatorSummary[];
  machines: MonthlyMachineSummary[];
  days: MonthlyDailySummary[];
  routes: MonthlyRouteSummary[];
  attentionRoutes: MonthlyRouteSummary[];
};

type MutableOperator = UnitTotals & FillAuditTotals & {
  operatorId: string;
  assignedRoutes: Set<string>;
  completedRoutes: Set<string>;
  completedVisits: number;
  fillVisits: number;
  totalStops: number;
  machines: Set<string>;
  fullFills: number;
  partialFills: number;
  manualSaleUnits: number;
  manualSalesLyd: number;
};

type MutableMachine = {
  machineId: string;
  completedVisits: number;
  fillVisits: number;
  filledUnits: number;
  fullFills: number;
  partialFills: number;
  issueVisits: number;
  shortageUnits: number;
  zeroFillLines: number;
  routes: Set<string>;
  operators: Set<string>;
  lastServiceDate: string | null;
};

type MutableDay = UnitTotals & {
  date: string;
  routesScheduled: number;
  routesCompleted: number;
  fillVisits: number;
  machines: Set<string>;
};

const emptyUnits = (): UnitTotals => ({ loaded: 0, filled: 0, returned: 0, damaged: 0, machineStorage: 0 });
const emptyFillAudit = (): FillAuditTotals => ({ assignedUnits: 0, recordedFillUnits: 0, shortageUnits: 0, overPlanUnits: 0, zeroFillLines: 0, reviewLines: 0 });
const normalized = (value: unknown) => String(value ?? "").trim().toLowerCase();
const quantity = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
};
const money = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const completedRoute = (status: unknown) => ["completed", "verified", "payroll_pending", "paid", "disputed", "reviewed"].includes(normalized(status));
const cancelledRoute = (status: unknown) => ["cancelled", "canceled", "archived", "deleted"].includes(normalized(status));
const completedStop = (status: unknown) => ["completed", "done"].includes(normalized(status));
const skippedStop = (status: unknown) => ["skipped", "cancelled", "canceled"].includes(normalized(status));

function addUnits(target: UnitTotals, delta: UnitTotals) {
  target.loaded += delta.loaded;
  target.filled += delta.filled;
  target.returned += delta.returned;
  target.damaged += delta.damaged;
  target.machineStorage += delta.machineStorage;
}

export function movementUnitDelta(movement: MonthlyMovementRow): UnitTotals {
  const delta = emptyUnits();
  const qty = quantity(movement.quantity);
  const from = normalized(movement.from_entity_type);
  const to = normalized(movement.to_entity_type);
  const reason = normalized(movement.reason);
  const source = normalized(movement.source_type);

  if (from === "storage" && to === "operator_bag" && reason === "storage_to_operator_bag") delta.loaded += qty;
  if (from === "operator_bag" && to === "machine") delta.filled += qty;
  if (from === "machine" && to === "operator_bag" && reason === "manual_correction") delta.filled -= qty;
  if (from === "operator_bag" && to === "storage") delta.returned += qty;
  if (from === "storage" && to === "operator_bag" && source === "route_stop_zero_fill_return_reversal") delta.returned -= qty;
  if (to === "waste") delta.damaged += qty;
  if (to === "machine_storage") delta.machineStorage += qty;
  if (from === "machine_storage") delta.machineStorage -= qty;
  return delta;
}

function clampUnits<T extends UnitTotals>(value: T): T {
  value.loaded = Math.max(0, value.loaded);
  value.filled = Math.max(0, value.filled);
  value.returned = Math.max(0, value.returned);
  value.damaged = Math.max(0, value.damaged);
  value.machineStorage = Math.max(0, value.machineStorage);
  return value;
}

export function buildMonthlyOperationsReport({
  routes,
  stops,
  movements,
  refills,
  manualSales,
  fillLines,
}: {
  routes: MonthlyRouteRow[];
  stops: MonthlyStopRow[];
  movements: MonthlyMovementRow[];
  refills: MonthlyRefillRow[];
  manualSales: MonthlyManualSaleRow[];
  fillLines: MonthlyFillLineRow[];
}): MonthlyOperationsReport {
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const routeSummaries = new Map<string, MonthlyRouteSummary>();
  const operators = new Map<string, MutableOperator>();
  const machines = new Map<string, MutableMachine>();
  const days = new Map<string, MutableDay>();
  const totals = emptyUnits();
  let fullFillTotal = 0;
  let partialFillTotal = 0;
  let issueVisitTotal = 0;
  let manualSalesLydTotal = 0;

  const operatorFor = (operatorId: string) => {
    const existing = operators.get(operatorId);
    if (existing) return existing;
    const created: MutableOperator = {
      operatorId,
      assignedRoutes: new Set(),
      completedRoutes: new Set(),
      completedVisits: 0,
      fillVisits: 0,
      totalStops: 0,
      machines: new Set(),
      fullFills: 0,
      partialFills: 0,
      manualSaleUnits: 0,
      manualSalesLyd: 0,
      ...emptyUnits(),
      ...emptyFillAudit(),
    };
    operators.set(operatorId, created);
    return created;
  };

  const machineFor = (machineId: string) => {
    const existing = machines.get(machineId);
    if (existing) return existing;
    const created: MutableMachine = {
      machineId,
      completedVisits: 0,
      fillVisits: 0,
      filledUnits: 0,
      fullFills: 0,
      partialFills: 0,
      issueVisits: 0,
      shortageUnits: 0,
      zeroFillLines: 0,
      routes: new Set(),
      operators: new Set(),
      lastServiceDate: null,
    };
    machines.set(machineId, created);
    return created;
  };

  const dayFor = (date: string) => {
    const existing = days.get(date);
    if (existing) return existing;
    const created: MutableDay = {
      date,
      routesScheduled: 0,
      routesCompleted: 0,
      fillVisits: 0,
      machines: new Set(),
      ...emptyUnits(),
    };
    days.set(date, created);
    return created;
  };

  routes.forEach((route) => {
    const status = normalized(route.status) || "unknown";
    routeSummaries.set(route.id, {
      routeId: route.id,
      routeDate: route.route_date,
      operatorId: route.operator_id,
      status,
      totalStops: 0,
      completedStops: 0,
      skippedStops: 0,
      openStops: 0,
      partialFills: 0,
      issueVisits: 0,
      manualSaleUnits: 0,
      cancellationReason: route.cancellation_reason,
      ...emptyUnits(),
      ...emptyFillAudit(),
    });
    const day = dayFor(route.route_date);
    day.routesScheduled += 1;
    if (completedRoute(route.status)) day.routesCompleted += 1;
    if (route.operator_id) {
      const operator = operatorFor(route.operator_id);
      operator.assignedRoutes.add(route.id);
      if (completedRoute(route.status)) operator.completedRoutes.add(route.id);
    }
  });

  stops.forEach((stop) => {
    const route = routeById.get(stop.route_id);
    const routeSummary = routeSummaries.get(stop.route_id);
    if (!route || !routeSummary) return;
    routeSummary.totalStops += 1;
    if (completedStop(stop.status)) routeSummary.completedStops += 1;
    else if (skippedStop(stop.status)) routeSummary.skippedStops += 1;
    else routeSummary.openStops += 1;

    if (route.operator_id) operatorFor(route.operator_id).totalStops += 1;
    if (!completedStop(stop.status)) return;

    const day = dayFor(route.route_date);
    if (stop.machine_id) day.machines.add(stop.machine_id);
    if (route.operator_id) {
      const operator = operatorFor(route.operator_id);
      operator.completedVisits += 1;
      if (stop.machine_id) operator.machines.add(stop.machine_id);
    }
    if (stop.machine_id) {
      const machine = machineFor(stop.machine_id);
      machine.completedVisits += 1;
      machine.routes.add(stop.route_id);
      if (route.operator_id) machine.operators.add(route.operator_id);
      if (!machine.lastServiceDate || route.route_date > machine.lastServiceDate) machine.lastServiceDate = route.route_date;
    }
  });

  const filledUnitsByStop = new Map<string, number>();
  movements.forEach((movement) => {
    const routeId = String(movement.related_route_id ?? "");
    const route = routeById.get(routeId);
    const routeSummary = routeSummaries.get(routeId);
    if (!route || !routeSummary) return;
    const delta = movementUnitDelta(movement);
    addUnits(totals, delta);
    addUnits(routeSummary, delta);
    addUnits(dayFor(route.route_date), delta);
    if (route.operator_id) addUnits(operatorFor(route.operator_id), delta);
    const machineId = String(movement.related_machine_id ?? "");
    if (machineId && delta.filled) machineFor(machineId).filledUnits += delta.filled;
    const stopId = String(movement.related_route_stop_id ?? "");
    if (stopId && delta.filled) filledUnitsByStop.set(stopId, (filledUnitsByStop.get(stopId) ?? 0) + delta.filled);
  });

  const filledStopIds = new Set<string>();
  stops.forEach((stop) => {
    if (!completedStop(stop.status) || (filledUnitsByStop.get(stop.id) ?? 0) <= 0) return;
    const route = routeById.get(stop.route_id);
    if (!route) return;
    filledStopIds.add(stop.id);
    dayFor(route.route_date).fillVisits += 1;
    if (route.operator_id) operatorFor(route.operator_id).fillVisits += 1;
    if (stop.machine_id) machineFor(stop.machine_id).fillVisits += 1;
  });

  refills.forEach((refill) => {
    const routeId = String(refill.route_id ?? "");
    const route = routeById.get(routeId);
    const routeSummary = routeSummaries.get(routeId);
    if (!route || !routeSummary) return;
    const status = normalized(refill.fill_status);
    const machineId = String(refill.machine_id ?? "");
    if (status === "full") fullFillTotal += 1;
    if (status === "partial") partialFillTotal += 1;
    if (refill.issues_found) issueVisitTotal += 1;
    if (status === "partial") routeSummary.partialFills += 1;
    if (refill.issues_found) routeSummary.issueVisits += 1;
    if (route.operator_id) {
      const operator = operatorFor(route.operator_id);
      if (status === "full") operator.fullFills += 1;
      if (status === "partial") operator.partialFills += 1;
    }
    if (machineId) {
      const machine = machineFor(machineId);
      if (status === "full") machine.fullFills += 1;
      if (status === "partial") machine.partialFills += 1;
      if (refill.issues_found) machine.issueVisits += 1;
    }
  });

  const fillAuditTotals = emptyFillAudit();
  fillLines.forEach((line) => {
    const route = routeById.get(line.route_id);
    const routeSummary = routeSummaries.get(line.route_id);
    if (!route || !routeSummary) return;
    const actionType = normalized(line.action_type);
    const assigned = quantity(line.assigned_qty);
    const actual = quantity(line.actual_qty);
    const shortage = actionType === "assigned_fill" ? Math.max(0, assigned - actual) : 0;
    const overPlan = actionType === "assigned_fill" ? Math.max(0, actual - assigned) : 0;
    const zeroFill = actionType === "assigned_fill" && assigned > 0 && actual === 0 ? 1 : 0;
    const review = line.needs_review ? 1 : 0;

    if (actionType === "assigned_fill") {
      fillAuditTotals.assignedUnits += assigned;
      fillAuditTotals.recordedFillUnits += actual;
      routeSummary.assignedUnits += assigned;
      routeSummary.recordedFillUnits += actual;
    }
    fillAuditTotals.shortageUnits += shortage;
    fillAuditTotals.overPlanUnits += overPlan;
    fillAuditTotals.zeroFillLines += zeroFill;
    fillAuditTotals.reviewLines += review;
    routeSummary.shortageUnits += shortage;
    routeSummary.overPlanUnits += overPlan;
    routeSummary.zeroFillLines += zeroFill;
    routeSummary.reviewLines += review;

    if (route.operator_id) {
      const operator = operatorFor(route.operator_id);
      if (actionType === "assigned_fill") {
        operator.assignedUnits += assigned;
        operator.recordedFillUnits += actual;
      }
      operator.shortageUnits += shortage;
      operator.overPlanUnits += overPlan;
      operator.zeroFillLines += zeroFill;
      operator.reviewLines += review;
    }
    const machineId = String(line.machine_id ?? "");
    if (machineId) {
      const machine = machineFor(machineId);
      machine.shortageUnits += shortage;
      machine.zeroFillLines += zeroFill;
    }
  });

  manualSales.forEach((sale) => {
    if (normalized(sale.status) !== "confirmed") return;
    const route = routeById.get(sale.route_id);
    const routeSummary = routeSummaries.get(sale.route_id);
    if (!route || !routeSummary) return;
    const units = quantity(sale.quantity);
    const amount = money(sale.total_amount_lyd);
    routeSummary.manualSaleUnits += units;
    manualSalesLydTotal += amount;
    const operatorId = sale.operator_id ?? route.operator_id;
    if (operatorId) {
      const operator = operatorFor(operatorId);
      operator.manualSaleUnits += units;
      operator.manualSalesLyd += amount;
    }
  });

  const routeRows = Array.from(routeSummaries.values()).map(clampUnits).sort((left, right) => {
    const dateCompare = right.routeDate.localeCompare(left.routeDate);
    return dateCompare || right.routeId.localeCompare(left.routeId);
  });
  const completedStops = routeRows.reduce((sum, route) => sum + route.completedStops, 0);
  const totalStops = routeRows.reduce((sum, route) => sum + route.totalStops, 0);
  const skippedStops = routeRows.reduce((sum, route) => sum + route.skippedStops, 0);
  const openStops = routeRows.reduce((sum, route) => sum + route.openStops, 0);
  const manualSaleUnits = routeRows.reduce((sum, route) => sum + route.manualSaleUnits, 0);
  const routesCompleted = routes.filter((route) => completedRoute(route.status)).length;
  const routesCancelled = routes.filter((route) => cancelledRoute(route.status)).length;
  const routesOpen = routes.length - routesCompleted - routesCancelled;
  const uniqueMachines = new Set(stops.filter((stop) => completedStop(stop.status)).map((stop) => stop.machine_id).filter(Boolean)).size;
  const activeOperators = new Set(stops.filter((stop) => completedStop(stop.status)).map((stop) => routeById.get(stop.route_id)?.operator_id).filter(Boolean)).size;
  const routeDurations = routes.flatMap((route) => {
    if (!route.started_at || !route.completed_at) return [];
    const minutes = (Date.parse(route.completed_at) - Date.parse(route.started_at)) / 60_000;
    return Number.isFinite(minutes) && minutes >= 0 ? [minutes] : [];
  });

  return {
    summary: {
      ...clampUnits(totals),
      ...fillAuditTotals,
      routesScheduled: routes.length,
      routesCompleted,
      routesCancelled,
      routesOpen,
      routeCompletionRate: routes.length ? (routesCompleted / routes.length) * 100 : 0,
      totalStops,
      completedVisits: completedStops,
      fillVisits: filledStopIds.size,
      skippedStops,
      openStops,
      stopCompletionRate: totalStops ? (completedStops / totalStops) * 100 : 0,
      uniqueMachines,
      uniqueMachinesFilled: new Set(stops.filter((stop) => filledStopIds.has(stop.id)).map((stop) => stop.machine_id).filter(Boolean)).size,
      activeOperators,
      fullFills: fullFillTotal,
      partialFills: partialFillTotal,
      issueVisits: issueVisitTotal,
      manualSaleUnits,
      manualSalesLyd: manualSalesLydTotal,
      fillPlanRate: fillAuditTotals.assignedUnits ? (fillAuditTotals.recordedFillUnits / fillAuditTotals.assignedUnits) * 100 : null,
      averageRouteMinutes: routeDurations.length ? routeDurations.reduce((sum, value) => sum + value, 0) / routeDurations.length : null,
    },
    operators: Array.from(operators.values()).map((operator) => ({
      ...clampUnits(operator),
      operatorId: operator.operatorId,
      assignedRoutes: operator.assignedRoutes.size,
      completedRoutes: operator.completedRoutes.size,
      completedVisits: operator.completedVisits,
      fillVisits: operator.fillVisits,
      totalStops: operator.totalStops,
      uniqueMachines: operator.machines.size,
      fullFills: operator.fullFills,
      partialFills: operator.partialFills,
      assignedUnits: operator.assignedUnits,
      recordedFillUnits: operator.recordedFillUnits,
      shortageUnits: operator.shortageUnits,
      overPlanUnits: operator.overPlanUnits,
      zeroFillLines: operator.zeroFillLines,
      reviewLines: operator.reviewLines,
      manualSaleUnits: operator.manualSaleUnits,
      manualSalesLyd: operator.manualSalesLyd,
    })).sort((left, right) => right.fillVisits - left.fillVisits || right.filled - left.filled),
    machines: Array.from(machines.values()).map((machine) => ({
      machineId: machine.machineId,
      completedVisits: machine.completedVisits,
      fillVisits: machine.fillVisits,
      filledUnits: Math.max(0, machine.filledUnits),
      fullFills: machine.fullFills,
      partialFills: machine.partialFills,
      issueVisits: machine.issueVisits,
      shortageUnits: machine.shortageUnits,
      zeroFillLines: machine.zeroFillLines,
      routes: machine.routes.size,
      operators: Array.from(machine.operators),
      lastServiceDate: machine.lastServiceDate,
    })).sort((left, right) => right.fillVisits - left.fillVisits || right.filledUnits - left.filledUnits),
    days: Array.from(days.values()).map((day) => ({
      ...clampUnits(day),
      date: day.date,
      routesScheduled: day.routesScheduled,
      routesCompleted: day.routesCompleted,
      fillVisits: day.fillVisits,
      uniqueMachines: day.machines.size,
    })).sort((left, right) => left.date.localeCompare(right.date)),
    routes: routeRows,
    attentionRoutes: routeRows.filter((route) => !completedRoute(route.status)
      || route.skippedStops > 0
      || route.openStops > 0
      || route.partialFills > 0
      || route.issueVisits > 0
      || route.shortageUnits > 0
      || route.zeroFillLines > 0
      || route.reviewLines > 0),
  };
}
