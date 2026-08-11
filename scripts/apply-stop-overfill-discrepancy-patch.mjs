import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "src/lib/operator-actions.ts");
let source = fs.readFileSync(sourcePath, "utf8");

function replaceExactlyOnce(oldText, newText, label) {
  const first = source.indexOf(oldText);
  const second = first < 0 ? -1 : source.indexOf(oldText, first + oldText.length);
  if (first < 0 || second >= 0) {
    throw new Error(`Could not safely apply ${label}: expected exactly one source match.`);
  }
  source = source.slice(0, first) + newText + source.slice(first + oldText.length);
}

if (source.includes("const carriedShortageByProduct = new Map<string, number>()")) {
  console.log("Stop overfill discrepancy fix is already applied.");
  process.exit(0);
}

replaceExactlyOnce(
`    for (const [productId, quantity] of requestedBagUse) {
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
`,
`    const carriedShortageByProduct = new Map<string, number>();
    for (const [productId, quantity] of requestedBagUse) {
      const hasCanonicalPickup = canonicalPickupProductIds.has(productId);
      if (!hasCanonicalPickup && !legacyStockByProduct.has(productId)) {
        const product = submittedProductById.get(productId);
        throw new Error(\`Route stock is missing for \${product?.name ?? "selected product"}.\`);
      }
      const available = carriedAvailableByProduct.get(productId) ?? 0;
      if (quantity > available) {
        const shortage = quantity - available;
        carriedShortageByProduct.set(productId, shortage);
        console.warn("[operator:complete-stop] Actual field fill exceeds recorded carried quantity; completing with inventory discrepancy", {
          route_id: routeId,
          route_stop_id: stopId,
          product_id: productId,
          requested_quantity: quantity,
          recorded_carried_quantity: available,
          discrepancy_quantity: shortage,
        });
      }
    }
`,
  "non-blocking carried discrepancy validation",
);

replaceExactlyOnce(
`    const hasShortage = normalizedFilledItems.some((item) => {
      const assignedQty = Math.max(0, Number(item.assignedQty ?? 0));
      const actualQty = Math.max(0, Number(item.quantity ?? 0));
      return Boolean(item.unavailable) || actualQty < assignedQty;
    });
`,
`    const hasShortage = normalizedFilledItems.some((item) => {
      const assignedQty = Math.max(0, Number(item.assignedQty ?? 0));
      const actualQty = Math.max(0, Number(item.quantity ?? 0));
      return Boolean(item.unavailable) || actualQty < assignedQty || carriedShortageByProduct.has(String(item.productId));
    });
`,
  "carried discrepancy fill status",
);

replaceExactlyOnce(
`        const assignedQty = Math.max(0, Number(item.assignedQty ?? 0));
        const actualQty = Math.max(0, Number(item.quantity ?? 0));
        return {
`,
`        const assignedQty = Math.max(0, Number(item.assignedQty ?? 0));
        const actualQty = Math.max(0, Number(item.quantity ?? 0));
        const carriedShortage = carriedShortageByProduct.get(String(item.productId)) ?? 0;
        const carriedMismatchReason = carriedShortage > 0
          ? \`Inventory discrepancy: actual fill exceeds recorded carried quantity by \${carriedShortage} unit(s).\`
          : null;
        return {
`,
  "fill audit carried discrepancy context",
);

replaceExactlyOnce(
`          reason: item.unavailable ? (item.reason || "Product not in operator bag") : item.reason || null,
          notes: item.notes || null,
          needs_review: Boolean(item.unavailable) || actualQty !== assignedQty,
`,
`          reason: item.unavailable ? (item.reason || "Product not in operator bag") : (item.reason || carriedMismatchReason),
          notes: [item.notes || null, carriedMismatchReason].filter(Boolean).join(" | ") || null,
          needs_review: Boolean(item.unavailable) || actualQty !== assignedQty || carriedShortage > 0,
`,
  "fill audit carried discrepancy flag",
);

fs.writeFileSync(sourcePath, source);
console.log("Applied non-blocking stop overfill discrepancy fix.");
