import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const operatorActionsPath = path.join(root, "src/lib/operator-actions.ts");
const adminRoutePagePath = path.join(root, "src/app/routes/[id]/page.tsx");
const operatorRoutePagePath = path.join(root, "src/app/operator/routes/[id]/page.tsx");

function patchFile(filePath, patches) {
  let source = fs.readFileSync(filePath, "utf8");
  for (const patch of patches) {
    if (source.includes(patch.marker)) continue;
    const first = source.indexOf(patch.oldText);
    const second = first < 0 ? -1 : source.indexOf(patch.oldText, first + patch.oldText.length);
    if (first < 0 || second >= 0) {
      throw new Error(`Could not safely apply ${patch.label}: expected exactly one source match in ${path.relative(root, filePath)}.`);
    }
    source = source.slice(0, first) + patch.newText + source.slice(first + patch.oldText.length);
  }
  fs.writeFileSync(filePath, source);
}

patchFile(operatorActionsPath, [
  {
    label: "explicit-zero return helper import",
    marker: "buildExplicitZeroFillReturnAdjustments,",
    oldText: 'import { summarizeRouteInventoryMovements } from "@/lib/route-inventory-summary";',
    newText: `import { summarizeRouteInventoryMovements } from "@/lib/route-inventory-summary";
import {
  buildExplicitZeroFillReturnAdjustments,
  buildExplicitZeroFillReturnPlans,
} from "@/lib/route-stop-zero-return";`,
  },
  {
    label: "route stock ids for explicit-zero return reconciliation",
    marker: "// Explicit-zero stop returns need route stock row ids for immediate summary reconciliation.",
    oldText: `    const { data: routeStockLines, error: stockError } = await supabase
      .from("route_stock_lines")
      .select("product_id, picked_qty, returned_qty")
      .eq("route_id", routeId);`,
    newText: `    // Explicit-zero stop returns need route stock row ids for immediate summary reconciliation.
    const { data: routeStockLines, error: stockError } = await supabase
      .from("route_stock_lines")
      .select("id, product_id, picked_qty, returned_qty")
      .eq("route_id", routeId);`,
  },
  {
    label: "explicit-zero stop return inventory reconciliation",
    marker: "// Explicit-zero assigned fills are reconciled with storage immediately.",
    oldText: `    if (movements.length) {
      await upsertInventoryMovementsWithFallback({
        supabase,
        rows: movements,
        routeId,
        operationLabel: 'create machine fill inventory movements',
      });
    }

    const machineStorageMovementByProduct = new Map<string, { quantity: number; reasons: Set<string>; notes: string[] }>();`,
    newText: `    if (movements.length) {
      await upsertInventoryMovementsWithFallback({
        supabase,
        rows: movements,
        routeId,
        operationLabel: 'create machine fill inventory movements',
      });
    }

    // Explicit-zero assigned fills are reconciled with storage immediately.
    // Partial underfills remain in the route bag for the normal leftovers workflow.
    // Existing return/reversal movements are read first so retries and later stop edits stay balanced.
    const zeroFillReturnPlans = buildExplicitZeroFillReturnPlans(normalizedFilledItems);
    const { data: existingZeroFillMovements, error: existingZeroFillError } = await supabase
      .from("inventory_movements")
      .select("product_id, quantity, from_entity_type, to_entity_type, source_type")
      .eq("related_route_id", routeId)
      .eq("related_route_stop_id", stopId)
      .in("source_type", ["route_stop_zero_fill_return", "route_stop_zero_fill_return_reversal"])
      .limit(5000);
    if (existingZeroFillError) {
      throwActionError(existingZeroFillError, "Could not verify previous zero-fill returns.");
    }

    const existingZeroFillReturnByProduct = new Map<string, number>();
    (existingZeroFillMovements ?? []).forEach((movement: any) => {
      const productId = String(movement.product_id ?? "");
      const quantity = unitQuantity(movement.quantity);
      if (!productId || quantity <= 0) return;
      const isReturn = movement.from_entity_type === "operator_bag" && movement.to_entity_type === "storage";
      const isReversal = movement.from_entity_type === "storage" && movement.to_entity_type === "operator_bag";
      if (!isReturn && !isReversal) return;
      const delta = isReturn ? quantity : -quantity;
      existingZeroFillReturnByProduct.set(
        productId,
        (existingZeroFillReturnByProduct.get(productId) ?? 0) + delta,
      );
    });

    const zeroFillReturnAdjustments = buildExplicitZeroFillReturnAdjustments(
      zeroFillReturnPlans,
      existingZeroFillReturnByProduct,
    );
    const zeroFillTrackedProductIds = new Set([
      ...zeroFillReturnPlans.map((plan) => plan.productId),
      ...existingZeroFillReturnByProduct.keys(),
    ]);

    if (zeroFillTrackedProductIds.size) {
      let zeroFillStorageId: string | null = null;
      if (zeroFillReturnAdjustments.length) {
        const storageLookup = await supabase.rpc(
          "snacky_route_leftover_storage_location_id",
          { p_route_id: routeId },
        );
        if (storageLookup.error) {
          throwActionError(storageLookup.error, "Could not load storage for the zero-fill return.");
        }
        zeroFillStorageId = String(storageLookup.data ?? "").trim() || null;
        if (!zeroFillStorageId) throw new Error("No active storage location found for the zero-fill return.");

        const zeroFillReturnSourceId = routeSourceUuid(
          stopSubmissionId,
          "route-stop-zero-fill-return:" + routeId + ":" + stopId + ":" + stopSubmissionId,
        );
        const zeroFillReturnRows = zeroFillReturnAdjustments.map((adjustment) => {
          const returning = adjustment.direction === "return";
          return {
            product_id: adjustment.productId,
            quantity: adjustment.quantity,
            from_entity_type: returning ? "operator_bag" : "storage",
            from_entity_id: returning ? route.operator_id : zeroFillStorageId,
            to_entity_type: returning ? "storage" : "operator_bag",
            to_entity_id: returning ? zeroFillStorageId : route.operator_id,
            reason: returning ? "operator_bag_to_storage" : "manual_correction",
            related_route_id: routeId,
            related_route_stop_id: stopId,
            related_machine_id: machineId,
            related_pickup_batch_id: null,
            idempotency_key: inventoryMovementIdempotencyKey(
              returning ? "route-stop-zero-fill-return" : "route-stop-zero-fill-return-reversal",
              routeId,
              stopId,
              machineId,
              adjustment.productId,
              zeroFillStorageId,
              route.operator_id ?? "",
              adjustment.quantity,
              stopSubmissionId,
            ),
            source_type: returning ? "route_stop_zero_fill_return" : "route_stop_zero_fill_return_reversal",
            source_id: zeroFillReturnSourceId,
            created_by: route.operator_id,
            notes: returning
              ? "Assigned stop quantity returned to storage because the operator recorded an explicit zero fill."
              : "Reversed a prior explicit-zero storage return after the stop quantity was edited.",
          };
        });

        await upsertInventoryMovementsWithFallback({
          supabase,
          rows: zeroFillReturnRows,
          routeId,
          operationLabel: "reconcile explicit-zero stop return movements",
        });

        zeroFillReturnAdjustments.forEach((adjustment) => {
          const carriedDelta = adjustment.direction === "return" ? -adjustment.quantity : adjustment.quantity;
          logCarriedAfter.set(
            adjustment.productId,
            (logCarriedAfter.get(adjustment.productId) ?? 0) + carriedDelta,
          );
        });
      }

      const { data: refreshedRouteMovements, error: refreshedRouteMovementError } = await supabase
        .from("inventory_movements")
        .select("product_id, quantity, reason, from_entity_type, to_entity_type")
        .eq("related_route_id", routeId)
        .limit(5000);
      if (refreshedRouteMovementError) {
        throwActionError(refreshedRouteMovementError, "Could not reload the route summary after the zero-fill return.");
      }

      const refreshedRouteSummary = routeInventorySummaryByProduct(refreshedRouteMovements);
      for (const line of routeStockLines ?? []) {
        const productId = String(line.product_id ?? "");
        if (!zeroFillTrackedProductIds.has(productId)) continue;
        const returnedQty = Math.max(0, refreshedRouteSummary.get(productId)?.returnedQty ?? 0);
        const { error: stockLineReturnError } = await supabase
          .from("route_stock_lines")
          .update({ returned_qty: returnedQty, updated_at: new Date().toISOString() })
          .eq("id", line.id);
        if (stockLineReturnError) {
          throwActionError(stockLineReturnError, "Could not update the route summary after the zero-fill return.");
        }
      }

      console.info("[operator:complete-stop] Explicit-zero assigned quantities reconciled with storage", {
        route_id: routeId,
        route_stop_id: stopId,
        machine_id: machineId,
        storage_id: zeroFillStorageId,
        desired_returns: zeroFillReturnPlans.map((plan) => ({
          product_id: plan.productId,
          quantity: plan.quantity,
        })),
        saved_adjustments: zeroFillReturnAdjustments.map((adjustment) => ({
          product_id: adjustment.productId,
          quantity: adjustment.quantity,
          direction: adjustment.direction,
        })),
      });
    }

    const machineStorageMovementByProduct = new Map<string, { quantity: number; reasons: Set<string>; notes: string[] }>();`,
  },
]);

patchFile(adminRoutePagePath, [
  {
    label: "route summary movement source type",
    marker: "reason, movement_type, source_type, related_route_stop_id",
    oldText: '      .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, movement_type, related_route_stop_id, related_machine_id, notes, created_by, created_at, product:products(name), created_by_member:team_members(full_name)")',
    newText: '      .select("id, product_id, quantity, from_entity_type, from_entity_id, to_entity_type, to_entity_id, reason, movement_type, source_type, related_route_stop_id, related_machine_id, notes, created_by, created_at, product:products(name), created_by_member:team_members(full_name)")',
  },
  {
    label: "route outcome includes explicit-zero rows",
    marker: 'String(line.action_type ?? "") !== "missing_product_report"',
    oldText: '    const fills = (fillLines ?? []).filter((line: any) => String(line.machine_id ?? "") === machineId && Number(line.actual_qty ?? 0) > 0);',
    newText: '    const fills = (fillLines ?? []).filter((line: any) => String(line.machine_id ?? "") === machineId && String(line.action_type ?? "") !== "missing_product_report");',
  },
  {
    label: "route returned totals include net explicit-zero storage returns",
    marker: 'const zeroFillReturnMovementRows = (movements ?? []).filter((movement: any) => ["route_stop_zero_fill_return", "route_stop_zero_fill_return_reversal"].includes(String(movement.source_type ?? "")));',
    oldText: `  const damagedAdjustments = routeAdjustments.filter((row: any) => String(row.adjustment_type ?? "") === "damaged");
  const returnedAdjustments = routeAdjustments.filter((row: any) => String(row.adjustment_type ?? "") === "returned_from_machine");
  const machineStorageMovements = (movements ?? []).filter((movement: any) => {`,
    newText: `  const damagedAdjustments = routeAdjustments.filter((row: any) => String(row.adjustment_type ?? "") === "damaged");
  const returnedAdjustments = routeAdjustments.filter((row: any) => String(row.adjustment_type ?? "") === "returned_from_machine");
  const zeroFillReturnMovementRows = (movements ?? []).filter((movement: any) => ["route_stop_zero_fill_return", "route_stop_zero_fill_return_reversal"].includes(String(movement.source_type ?? "")));
  const zeroFillReturnByScope = new Map<string, any>();
  zeroFillReturnMovementRows.forEach((movement: any) => {
    const productId = String(movement.product_id ?? "");
    const stopScope = String(movement.related_route_stop_id ?? "");
    const machineScope = String(movement.related_machine_id ?? "");
    if (!productId) return;
    const key = [stopScope, machineScope, productId].join(":");
    const current = zeroFillReturnByScope.get(key) ?? { ...movement, quantity: 0 };
    const direction = String(movement.source_type ?? "") === "route_stop_zero_fill_return_reversal" ? -1 : 1;
    current.quantity = Number(current.quantity ?? 0) + direction * Number(movement.quantity ?? 0);
    zeroFillReturnByScope.set(key, current);
  });
  const zeroFillReturnMovements = Array.from(zeroFillReturnByScope.values())
    .map((movement: any) => ({ ...movement, quantity: Math.max(0, Number(movement.quantity ?? 0)) }))
    .filter((movement: any) => Number(movement.quantity ?? 0) > 0);
  const machineStorageMovements = (movements ?? []).filter((movement: any) => {`,
  },
  {
    label: "route returned quantity includes zero-fill return movements",
    marker: "zeroFillReturnMovements.reduce((sum: number, row: any) => sum + Number(row.quantity ?? 0), 0)",
    oldText: '  const returnedTotalQty = returnedAdjustments.reduce((sum: number, row: any) => sum + Number(row.quantity ?? 0), 0);',
    newText: `  const returnedTotalQty = returnedAdjustments.reduce((sum: number, row: any) => sum + Number(row.quantity ?? 0), 0)
    + zeroFillReturnMovements.reduce((sum: number, row: any) => sum + Number(row.quantity ?? 0), 0);`,
  },
  {
    label: "machine outcome includes zero-fill returned products",
    marker: "...zeroFillReturnMovements",
    oldText: '    const returned = returnedAdjustments.filter((row: any) => String(row.machine_id ?? "") === machineId || String(row.route_stop_id ?? "") === String(stop.id));',
    newText: `    const returned = [
      ...returnedAdjustments.filter((row: any) => String(row.machine_id ?? "") === machineId || String(row.route_stop_id ?? "") === String(stop.id)),
      ...zeroFillReturnMovements
        .filter((row: any) => String(row.related_machine_id ?? "") === machineId || String(row.related_route_stop_id ?? "") === String(stop.id))
        .map((row: any) => ({
          ...row,
          product_name: firstRelation(row.product)?.name ?? tr(locale, "Product", "منتج"),
        })),
    ];`,
  },
]);

patchFile(operatorRoutePagePath, [
  {
    label: "operator route summary preserves zero and shows returns",
    marker: 'Number(item.returned_qty ?? 0)} {t("returned")} · {Math.max(0, Number(item.picked_qty ?? item.planned_qty ?? 0) - Number(item.returned_qty ?? 0))} {t("remaining")}',
    oldText: '{item.picked_qty || item.planned_qty} / {item.planned_qty} {t("picked")}',
    newText: '{Number(item.picked_qty ?? item.planned_qty ?? 0)} / {Number(item.planned_qty ?? 0)} {t("picked")} · {Number(item.returned_qty ?? 0)} {t("returned")} · {Math.max(0, Number(item.picked_qty ?? item.planned_qty ?? 0) - Number(item.returned_qty ?? 0))} {t("remaining")}',
  },
]);

console.log("Applied explicit-zero stop return and route summary reconciliation fix.");
