import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "src/lib/operator-actions.ts");
let source = fs.readFileSync(sourcePath, "utf8");

const alreadyPatched =
  source.includes("const { data: routeInventoryMovements") &&
  source.includes("const requestedMachineStorage = new Map<string, number>()") &&
  source.includes("const requestedBagUse = new Map(requestedFills)") &&
  source.includes("const canonicalPickupProductIds = new Set<string>()");

if (alreadyPatched) {
  console.log("Stop carried-quantity fix is already applied.");
  process.exit(0);
}

function replaceExactlyOnce(oldText, newText, label) {
  const first = source.indexOf(oldText);
  const second = first < 0 ? -1 : source.indexOf(oldText, first + oldText.length);
  if (first < 0 || second >= 0) {
    throw new Error(`Could not safely apply ${label}: expected exactly one source match.`);
  }
  source = source.slice(0, first) + newText + source.slice(first + oldText.length);
}

replaceExactlyOnce(
`    const { data: existingRouteFills, error: fillsError } = await supabase
      .from("inventory_movements")
      .select("product_id, quantity, related_route_stop_id, reason, from_entity_type, to_entity_type")
      .eq("related_route_id", routeId)
      .in("reason", ["operator_bag_to_machine", "manual_correction"]);
    if (fillsError) throwActionError(fillsError, "Could not verify previous machine fills.");
`,
`    // Use the same route movement ledger that powers the operator's visible bag balance.
    // route_stock_lines is retained only as a legacy fallback for routes created before pickup movements existed.
    const { data: routeInventoryMovements, error: routeInventoryMovementsError } = await supabase
      .from("inventory_movements")
      .select("product_id, quantity, related_route_stop_id, reason, from_entity_type, to_entity_type")
      .eq("related_route_id", routeId)
      .limit(5000);
    if (routeInventoryMovementsError) throwActionError(routeInventoryMovementsError, "Could not verify carried route stock.");
    const routeMovementRows = routeInventoryMovements ?? [];
    const existingRouteFills = routeMovementRows.filter((movement: any) =>
      ["operator_bag_to_machine", "manual_correction"].includes(String(movement.reason ?? "")),
    );
`,
  "route movement query",
);

replaceExactlyOnce(
`    const actualFillLines = [
      ...normalizedFilledItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      ...normalizedExtraItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
    ];

    const requestedFills = new Map<string, number>();
    actualFillLines.forEach((item) => {
      const productId = String(item.productId);
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      if (productId && quantity > 0) requestedFills.set(productId, (requestedFills.get(productId) ?? 0) + quantity);
    });
`,
`    // Assigned fills go into machine slots. Explicit machine-storage rows are a separate
    // destination and must never be posted again as normal machine fills.
    const actualFillLines = normalizedFilledItems.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    }));

    const requestedFills = new Map<string, number>();
    actualFillLines.forEach((item) => {
      const productId = String(item.productId);
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      if (productId && quantity > 0) requestedFills.set(productId, (requestedFills.get(productId) ?? 0) + quantity);
    });

    const requestedMachineStorage = new Map<string, number>();
    normalizedExtraItems.forEach((item) => {
      const productId = String(item.productId);
      const quantity = Math.max(0, Number(item.quantity ?? 0));
      if (productId && quantity > 0) {
        requestedMachineStorage.set(productId, (requestedMachineStorage.get(productId) ?? 0) + quantity);
      }
    });

    const requestedBagUse = new Map(requestedFills);
    requestedMachineStorage.forEach((quantity, productId) => {
      requestedBagUse.set(productId, (requestedBagUse.get(productId) ?? 0) + quantity);
    });
`,
  "fill and machine-storage separation",
);

const validationStart = `    const stockByProduct = new Map((routeStockLines ?? []).map((line: any) => [String(line.product_id), unitQuantity(line.picked_qty) - unitQuantity(line.returned_qty)]));
`;
const validationEnd = `    const assignedProductIds = new Set(normalizedFilledItems.map((item) => String(item.productId)));
`;
const startIndex = source.indexOf(validationStart);
const endIndex = source.indexOf(validationEnd, startIndex);
if (startIndex < 0 || endIndex < 0) {
  throw new Error("Could not safely locate the carried-quantity validation block.");
}

const replacementValidation = `    const legacyStockByProduct = new Map(
      (routeStockLines ?? []).map((line: any) => [
        String(line.product_id),
        unitQuantity(line.picked_qty) - unitQuantity(line.returned_qty),
      ]),
    );
    const routeBagBalances = routeBagBalanceFromMovements(routeMovementRows);
    const canonicalPickupProductIds = new Set<string>();
    routeMovementRows.forEach((movement: any) => {
      const productId = String(movement.product_id ?? "");
      if (!productId) return;
      const isPickupIntoBag =
        movement.to_entity_type === "operator_bag" &&
        movement.from_entity_type !== "operator_bag" &&
        (movement.from_entity_type === "storage" || movement.reason === "storage_to_operator_bag");
      if (isPickupIntoBag) canonicalPickupProductIds.add(productId);
    });

    const currentStopMachineStorageByProduct = new Map<string, number>();
    routeMovementRows.forEach((movement: any) => {
      if (String(movement.related_route_stop_id ?? "") !== stopId) return;
      const productId = String(movement.product_id ?? "");
      const quantity = unitQuantity(movement.quantity);
      if (!productId || quantity <= 0) return;
      if (movement.from_entity_type === "operator_bag" && movement.to_entity_type === "machine_storage") {
        currentStopMachineStorageByProduct.set(
          productId,
          (currentStopMachineStorageByProduct.get(productId) ?? 0) + quantity,
        );
      }
      if (movement.from_entity_type === "machine_storage" && movement.to_entity_type === "operator_bag") {
        currentStopMachineStorageByProduct.set(
          productId,
          (currentStopMachineStorageByProduct.get(productId) ?? 0) - quantity,
        );
      }
    });

    const currentStopCommittedByProduct = new Map<string, number>();
    new Set([...currentStopFilled.keys(), ...currentStopMachineStorageByProduct.keys()]).forEach((productId) => {
      currentStopCommittedByProduct.set(
        productId,
        Math.max(0, currentStopFilled.get(productId) ?? 0) +
          Math.max(0, currentStopMachineStorageByProduct.get(productId) ?? 0),
      );
    });

    const submittedProductIds = Array.from(
      new Set([
        ...normalizedFilledItems.map((item) => item.productId),
        ...normalizedExtraItems.map((item) => item.productId),
      ]),
    );
    const { data: submittedProducts, error: submittedProductsError } = submittedProductIds.length
      ? await supabase.from("products").select("id, name").in("id", submittedProductIds)
      : { data: [], error: null };
    if (submittedProductsError) throwActionError(submittedProductsError, "Could not verify submitted products.");
    const submittedProductById = new Map((submittedProducts ?? []).map((product: any) => [String(product.id), product]));
    const missingSubmittedProductIds = submittedProductIds.filter((productId) => !submittedProductById.has(productId));
    if (missingSubmittedProductIds.length) {
      logMissingProductRelations = Array.from(new Set([...logMissingProductRelations, ...missingSubmittedProductIds]));
      throw new Error("Submitted product not found. Remove it from the stop and add it again.");
    }

    const routeProductIds = new Set([
      ...legacyStockByProduct.keys(),
      ...routeBagBalances.keys(),
      ...filledSoFar.keys(),
      ...currentStopMachineStorageByProduct.keys(),
      ...submittedProductIds,
    ]);
    const carriedAvailableByProduct = new Map<string, number>();
    routeProductIds.forEach((productId) => {
      const currentStopCommitted = currentStopCommittedByProduct.get(productId) ?? 0;
      const canonicalAvailable = Math.max(0, routeBagBalances.get(productId) ?? 0) + currentStopCommitted;
      const filledByOtherStops = (filledSoFar.get(productId) ?? 0) - (currentStopFilled.get(productId) ?? 0);
      const legacyAvailable = Math.max(0, (legacyStockByProduct.get(productId) ?? 0) - filledByOtherStops);
      const available = canonicalPickupProductIds.has(productId) ? canonicalAvailable : legacyAvailable;
      const requested = requestedBagUse.get(productId) ?? 0;
      carriedAvailableByProduct.set(productId, available);
      logCarriedBefore.set(productId, available);
      logCarriedAfter.set(productId, available - requested);
    });

    for (const [productId, quantity] of requestedBagUse) {
      const hasCanonicalPickup = canonicalPickupProductIds.has(productId);
      if (!hasCanonicalPickup && !legacyStockByProduct.has(productId)) {
        const product = submittedProductById.get(productId);
        throw new Error(\`Route stock is missing for \${product?.name ?? "selected product"}.\`);
      }
      const available = carriedAvailableByProduct.get(productId) ?? 0;
      if (quantity > available) {
        const product = submittedProductById.get(productId);
        throw new Error(
          \`Filled quantity cannot exceed carried quantity for \${product?.name ?? "selected product"}. Requested \${quantity}; carried for this stop \${available}.\`,
        );
      }
    }

`;
source = source.slice(0, startIndex) + replacementValidation + source.slice(endIndex);

replaceExactlyOnce(
  `  if (message.includes("cannot exceed")) return "Could not complete stop because filled quantity exceeds carried quantity.";
`,
  `  if (message.includes("cannot exceed")) return \`Could not complete stop. \${message}\`;
`,
  "public carried-quantity error",
);

const requiredMarkers = [
  "const { data: routeInventoryMovements",
  "const requestedMachineStorage = new Map<string, number>()",
  "const requestedBagUse = new Map(requestedFills)",
  "const canonicalPickupProductIds = new Set<string>()",
  "Requested ${quantity}; carried for this stop ${available}",
  "const actualFillLines = normalizedFilledItems.map",
];
for (const marker of requiredMarkers) {
  if (!source.includes(marker)) throw new Error(`Patched source is missing required marker: ${marker}`);
}

fs.writeFileSync(sourcePath, source);
console.log("Applied stop carried-quantity validation fix.");
