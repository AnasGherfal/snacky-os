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
    marker: 'import { buildExplicitZeroFillReturnPlans } from "@/lib/route-stop-zero-return";',
    oldText: 'import { summarizeRouteInventoryMovements } from "@/lib/route-inventory-summary";',
    newText: 'import { summarizeRouteInventoryMovements } from "@/lib/route-inventory-summary";\nimport { buildExplicitZeroFillReturnPlans } from "@/lib/route-stop-zero-return";',
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
    marker: "// Explicit-zero assigned fills are returned to storage immediately.",
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

    // Explicit-zero assigned fills are returned to storage immediately.
    // This records the field truth that the operator brought none of this stop's assigned quantity,
    // while partial underfills remain in the route bag for the normal leftovers workflow.
    const zeroFillReturnPlans = buildExplicitZeroFillReturnPlans(normalizedFilledItems);
    if (zeroFillReturnPlans.length) {
      const { data: zeroFillStorageId, error: zeroFillStorageError } = await supabase.rpc(
        "snacky_route_leftover_storage_location_id",
        { p_route_id: routeId },
      );
      if (zeroFillStorageError) {
        throwActionError(zeroFillStorageError, "Could not load storage for the zero-fill return.");
      }
      if (!zeroFillStorageId) throw new Error("No active storage location found for the zero-fill return.");

      const zeroFillReturnSourceId = routeSourceUuid(
        stopId,
        "route-stop-zero-fill-return:" + routeId + ":" + stopId,
      );
      const zeroFillReturnRows = zeroFillReturnPlans.map((plan) => ({
        product_id: plan.productId,
        quantity: plan.quantity,
        from_entity_type: "operator_bag" as const,
        from_entity_id: route.operator_id,
        to_entity_type: "storage" as const,
        to_entity_id: zeroFillStorageId,
        reason: "operator_bag_to_storage" as const,
        related_route_id: routeId,
        related_route_stop_id: stopId,
        related_machine_id: machineId,
        related_pickup_batch_id: null,
        idempotency_key: inventoryMovementIdempotencyKey(
          "route-stop-zero-fill-return",
          routeId,
          stopId,
          machineId,
          plan.productId,
          zeroFillStorageId,
          route.operator_id ?? "",
          plan.quantity,
        ),
        source_type: "route_stop_zero_fill_return",
        source_id: zeroFillReturnSourceId,
        created_by: route.operator_id,
        notes: "Assigned stop quantity returned to storage because the operator recorded an explicit zero fill.",
      }));

      await upsertInventoryMovementsWithFallback({
        supabase,
        rows: zeroFillReturnRows,
        routeId,
        operationLabel: "create explicit-zero stop return movements",
      });

      zeroFillReturnPlans.forEach((plan) => {
        logCarriedAfter.set(
          plan.productId,
          (logCarriedAfter.get(plan.productId) ?? 0) - plan.quantity,
        );
      });

      const { data: refreshedReturnMovements, error: refreshedReturnError } = await supabase
        .from("inventory_movements")
        .select("product_id, quantity")
        .eq("related_route_id", routeId)
        .eq("reason", "operator_bag_to_storage")
        .limit(5000);
      if (refreshedReturnError) {
        throwActionError(refreshedReturnError, "Could not reload returned route stock after the zero fill.");
      }

      const zeroFillReturnedByProduct = productQuantitiesFromMovements(refreshedReturnMovements);
      const zeroFillProductIds = new Set(zeroFillReturnPlans.map((plan) => plan.productId));
      for (const line of routeStockLines ?? []) {
        const productId = String(line.product_id ?? "");
        if (!zeroFillProductIds.has(productId)) continue;
        const returnedQty = Math.max(0, zeroFillReturnedByProduct.get(productId) ?? 0);
        const { error: stockLineReturnError } = await supabase
          .from("route_stock_lines")
          .update({ returned_qty: returnedQty, updated_at: new Date().toISOString() })
          .eq("id", line.id);
        if (stockLineReturnError) {
          throwActionError(stockLineReturnError, "Could not update the route summary after the zero-fill return.");
        }
      }

      console.info("[operator:complete-stop] Explicit-zero assigned quantities returned to storage", {
        route_id: routeId,
        route_stop_id: stopId,
        machine_id: machineId,
        storage_id: zeroFillStorageId,
        returned_items: zeroFillReturnPlans.map((plan) => ({
          product_id: plan.productId,
          quantity: plan.quantity,
        })),
        movement_count: zeroFillReturnRows.length,
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
    label: "route returned totals include explicit-zero storage returns",
    marker: 'const zeroFillReturnMovements = (movements ?? []).filter((movement: any) => String(movement.source_type ?? "") === "route_stop_zero_fill_return");',
    oldText: `  const damagedAdjustments = routeAdjustments.filter((row: any) => String(row.adjustment_type ?? "") === "damaged");
  const returnedAdjustments = routeAdjustments.filter((row: any) => String(row.adjustment_type ?? "") === "returned_from_machine");
  const machineStorageMovements = (movements ?? []).filter((movement: any) => {`,
    newText: `  const damagedAdjustments = routeAdjustments.filter((row: any) => String(row.adjustment_type ?? "") === "damaged");
  const returnedAdjustments = routeAdjustments.filter((row: any) => String(row.adjustment_type ?? "") === "returned_from_machine");
  const zeroFillReturnMovements = (movements ?? []).filter((movement: any) => String(movement.source_type ?? "") === "route_stop_zero_fill_return");
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
