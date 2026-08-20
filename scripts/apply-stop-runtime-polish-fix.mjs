import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quickActionsPath = path.join(root, "src/components/operator/RouteStopQuickActions.tsx");
const manualSalesPath = path.join(root, "src/components/operator/ManualRouteSalesSection.tsx");
const operatorActionsPath = path.join(root, "src/lib/operator-actions.ts");

function patchExactlyOnce(filePath, oldText, newText, marker, label) {
  let source = fs.readFileSync(filePath, "utf8");
  if (source.includes(marker)) return;
  const first = source.indexOf(oldText);
  const second = first < 0 ? -1 : source.indexOf(oldText, first + oldText.length);
  if (first < 0 || second >= 0) {
    throw new Error(`Could not safely apply ${label}: expected exactly one source match in ${path.relative(root, filePath)}.`);
  }
  source = source.slice(0, first) + newText + source.slice(first + oldText.length);
  fs.writeFileSync(filePath, source);
}

patchExactlyOnce(
  quickActionsPath,
  `      window.setTimeout(() => window.location.reload(), 500);`,
  `      // snacky:machine-photo-save-no-reload
      // The persisted-photo event updates the stop UI immediately; do not reload the page.`,
  "snacky:machine-photo-save-no-reload",
  "machine photo save without page reload",
);

patchExactlyOnce(
  manualSalesPath,
  `    return [...allProducts]
      .filter((product) => !needle || [product.name, product.sku, product.barcode, product.category, product.brand].some((value) => String(value ?? "").toLowerCase().includes(needle)))
      .sort((a, b) => {
        const preference = Number(preferredProductIds.has(b.id)) - Number(preferredProductIds.has(a.id));
        if (preference) return preference;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 24);`,
  `    // snacky:manual-sales-full-catalog
    // Manual sales search the complete catalog supplied by the stop API. Machine-preferred
    // products are only sorted first; they never restrict or truncate the selectable catalog.
    return [...allProducts]
      .filter((product) => !needle || [product.name, product.sku, product.barcode, product.category, product.brand].some((value) => String(value ?? "").toLowerCase().includes(needle)))
      .sort((a, b) => {
        const preference = Number(preferredProductIds.has(b.id)) - Number(preferredProductIds.has(a.id));
        if (preference) return preference;
        return a.name.localeCompare(b.name);
      });`,
  "snacky:manual-sales-full-catalog",
  "manual sales full catalog",
);

patchExactlyOnce(
  operatorActionsPath,
  `    const zeroFillReturnPlans = buildExplicitZeroFillReturnPlans(normalizedFilledItems);
    const { data: existingZeroFillMovements, error: existingZeroFillError } = await supabase
      .from("inventory_movements")`,
  `    const zeroFillReturnPlans = buildExplicitZeroFillReturnPlans(normalizedFilledItems);
    // snacky:zero-fill-privileged-ledger-client
    // The operator has already passed route/stop authorization above. Use the server ledger
    // client for the actual inventory write/read so RLS cannot leave the route summary changed
    // while the physical storage ledger remains unchanged.
    const zeroFillLedgerClient = getSupabaseAdminClient() ?? supabase;
    const { data: existingZeroFillMovements, error: existingZeroFillError } = await zeroFillLedgerClient
      .from("inventory_movements")`,
  "snacky:zero-fill-privileged-ledger-client",
  "zero-fill privileged ledger client",
);

patchExactlyOnce(
  operatorActionsPath,
  `        const storageLookup = await supabase.rpc(
          "snacky_route_leftover_storage_location_id",
          { p_route_id: routeId },
        );`,
  `        const storageLookup = await zeroFillLedgerClient.rpc(
          "snacky_route_leftover_storage_location_id",
          { p_route_id: routeId },
        );`,
  "const storageLookup = await zeroFillLedgerClient.rpc(",
  "zero-fill storage lookup through ledger client",
);

patchExactlyOnce(
  operatorActionsPath,
  `        const zeroFillReturnRows = zeroFillReturnAdjustments.map((adjustment) => {
          const returning = adjustment.direction === "return";`,
  `        const zeroFillProductIds = Array.from(new Set(zeroFillReturnAdjustments.map((adjustment) => adjustment.productId)));
        const { data: zeroFillStorageBeforeRows, error: zeroFillStorageBeforeError } = zeroFillProductIds.length
          ? await zeroFillLedgerClient
              .from("current_inventory_by_location")
              .select("product_id, quantity_on_hand")
              .eq("location_type", "storage")
              .eq("location_id", zeroFillStorageId)
              .in("product_id", zeroFillProductIds)
          : { data: [], error: null };
        if (zeroFillStorageBeforeError) {
          throwActionError(zeroFillStorageBeforeError, "Could not verify storage before the zero-fill return.");
        }
        const zeroFillStorageBeforeByProduct = new Map(
          (zeroFillStorageBeforeRows ?? []).map((row: any) => [String(row.product_id ?? ""), Number(row.quantity_on_hand ?? 0)]),
        );
        const zeroFillExpectedStorageDeltaByProduct = new Map<string, number>();

        const zeroFillReturnRows = zeroFillReturnAdjustments.map((adjustment) => {
          const returning = adjustment.direction === "return";
          zeroFillExpectedStorageDeltaByProduct.set(
            adjustment.productId,
            (zeroFillExpectedStorageDeltaByProduct.get(adjustment.productId) ?? 0) + (returning ? adjustment.quantity : -adjustment.quantity),
          );`,
  "zeroFillExpectedStorageDeltaByProduct",
  "zero-fill storage verification setup",
);

patchExactlyOnce(
  operatorActionsPath,
  `        await upsertInventoryMovementsWithFallback({
          supabase,
          rows: zeroFillReturnRows,
          routeId,
          operationLabel: "reconcile explicit-zero stop return movements",
        });

        zeroFillReturnAdjustments.forEach((adjustment) => {`,
  `        await upsertInventoryMovementsWithFallback({
          supabase: zeroFillLedgerClient,
          rows: zeroFillReturnRows,
          routeId,
          operationLabel: "reconcile explicit-zero stop return movements",
        });

        // snacky:zero-fill-storage-ledger-verification
        const { data: zeroFillStorageAfterRows, error: zeroFillStorageAfterError } = zeroFillProductIds.length
          ? await zeroFillLedgerClient
              .from("current_inventory_by_location")
              .select("product_id, quantity_on_hand")
              .eq("location_type", "storage")
              .eq("location_id", zeroFillStorageId)
              .in("product_id", zeroFillProductIds)
          : { data: [], error: null };
        if (zeroFillStorageAfterError) {
          throwActionError(zeroFillStorageAfterError, "Could not verify storage after the zero-fill return.");
        }
        const zeroFillStorageAfterByProduct = new Map(
          (zeroFillStorageAfterRows ?? []).map((row: any) => [String(row.product_id ?? ""), Number(row.quantity_on_hand ?? 0)]),
        );
        for (const productId of zeroFillProductIds) {
          const beforeQty = zeroFillStorageBeforeByProduct.get(productId) ?? 0;
          const expectedDelta = zeroFillExpectedStorageDeltaByProduct.get(productId) ?? 0;
          const afterQty = zeroFillStorageAfterByProduct.get(productId) ?? 0;
          if (afterQty !== beforeQty + expectedDelta) {
            throw new Error(
              "Storage return verification failed for product " + productId + ". Expected storage " + (beforeQty + expectedDelta) + ", found " + afterQty + ".",
            );
          }
        }

        zeroFillReturnAdjustments.forEach((adjustment) => {`,
  "snacky:zero-fill-storage-ledger-verification",
  "zero-fill storage write and verification",
);

patchExactlyOnce(
  operatorActionsPath,
  `      const { data: refreshedRouteMovements, error: refreshedRouteMovementError } = await supabase
        .from("inventory_movements")`,
  `      const { data: refreshedRouteMovements, error: refreshedRouteMovementError } = await zeroFillLedgerClient
        .from("inventory_movements")`,
  "refreshedRouteMovementError } = await zeroFillLedgerClient",
  "zero-fill refreshed ledger read",
);

console.log("Applied machine-photo no-reload, verified zero-fill storage return, and full manual-sales catalog fixes.");
