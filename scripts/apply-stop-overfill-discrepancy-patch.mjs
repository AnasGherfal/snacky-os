import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "src/lib/operator-actions.ts");
let source = fs.readFileSync(sourcePath, "utf8");

if (source.includes("Actual field fill exceeds recorded carried quantity; completing with inventory discrepancy")) {
  console.log("Stop overfill discrepancy fix is already applied.");
  process.exit(0);
}

const oldText = `      if (quantity > available) {
        const product = submittedProductById.get(productId);
        throw new Error(
          \`Filled quantity cannot exceed carried quantity for \${product?.name ?? "selected product"}. Requested \${quantity}; carried for this stop \${available}.\`,
        );
      }
`;

const newText = `      if (quantity > available) {
        const shortage = quantity - available;
        console.warn("[operator:complete-stop] Actual field fill exceeds recorded carried quantity; completing with inventory discrepancy", {
          route_id: routeId,
          route_stop_id: stopId,
          product_id: productId,
          requested_quantity: quantity,
          recorded_carried_quantity: available,
          discrepancy_quantity: shortage,
        });
      }
`;

const first = source.indexOf(oldText);
const second = first < 0 ? -1 : source.indexOf(oldText, first + oldText.length);
if (first < 0 || second >= 0) {
  throw new Error("Could not safely locate the carried-quantity hard-stop block.");
}

source = source.slice(0, first) + newText + source.slice(first + oldText.length);
fs.writeFileSync(sourcePath, source);
console.log("Applied non-blocking stop overfill discrepancy fix.");
