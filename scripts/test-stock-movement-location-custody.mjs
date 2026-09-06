import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const movementPage = read("src/app/inventory/movements/new/page.tsx");
const movementForm = read("src/components/StockMovementForm.tsx");
const inventoryActions = read("src/lib/inventory-actions.ts");

function actionSource(name, nextName) {
  const startMarker = `export async function ${name}`;
  const start = inventoryActions.indexOf(startMarker);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = nextName
    ? inventoryActions.indexOf(`export async function ${nextName}`, start + startMarker.length)
    : inventoryActions.length;
  assert.ok(end > start, `${name} must end before ${nextName ?? "end of file"}`);
  return inventoryActions.slice(start, end);
}

const storageAdjustmentAction = actionSource("createStorageAdjustment", "createInventoryMovementCorrection");

test("storage adjustment data stays separated by physical storage location", () => {
  assert.match(
    movementPage,
    /from\("current_inventory_by_location"\)\s*\.select\("product_id, location_id, quantity_on_hand"\)\s*\.eq\("location_type", "storage"\)/,
  );
  assert.match(movementPage, /const storageByProductLocation = new Map<string, number>\(\)/);
  assert.match(movementPage, /storageQtyByLocationId:\s*Object\.fromEntries\(storages\.map/);
  assert.doesNotMatch(
    movementPage,
    /storageByProduct\.set\(productId,\s*\(storageByProduct\.get\(productId\)[\s\S]*quantity_on_hand/,
    "balances from different storage locations must never be summed into one adjustment quantity",
  );
});

test("simple adjustment requires a storage and displays that storage's product balance", () => {
  assert.match(movementForm, /storageQtyByLocationId:\s*Record<string,\s*number>/);
  assert.match(movementForm, /simpleStorageLocationId/);
  assert.match(
    movementForm,
    /<select(?=[^>]*\bname="storage_location_id")(?=[^>]*\brequired\b)[^>]*>/,
    "the selected storage must be submitted as a required field",
  );
  assert.match(movementForm, /storageQtyByLocationId\[storageLocationId\]/);
  assert.match(movementForm, /storageQuantityFor\(product, simpleStorageLocationId\)/);
  assert.doesNotMatch(movementForm, /\bstorageQty:\s*number/);
  assert.doesNotMatch(movementForm, /(?:product|selectedProduct)\??\.storageQty\b/);
});

test("storage adjustment action uses only the explicitly selected storage", () => {
  assert.match(
    storageAdjustmentAction,
    /const storage(?:Location)?Id\s*=\s*clean\(formData\.get\("storage_location_id"\)\)/,
  );
  assert.match(
    storageAdjustmentAction,
    /if \((?:!storage(?:Location)?Id|!isUuid\(storage(?:Location)?Id\))\) fail\("(?:Storage location is required|Choose a valid storage location)\."\)/,
  );
  assert.match(storageAdjustmentAction, /p_storage_location_id:\s*storage(?:Location)?Id/);
  assert.doesNotMatch(inventoryActions, /function getDefaultStorageId\b|\bgetDefaultStorageId\(/);
});

test("operator-bag and machine custody are not exposed through the adjustment form", () => {
  assert.doesNotMatch(inventoryActions, /export async function createStockMovement/);
  assert.doesNotMatch(inventoryActions, /rpc\("snacky_create_stock_movement_v1"/);
  assert.doesNotMatch(movementForm, /Transfer \/ Advanced Movement|from_location|to_location|related_route_id|admin_override/);
  assert.match(movementForm, /Use the source workflow for custody movements/);
  assert.match(movementForm, /Route pickup, machine fill, return, damage, and substitution inventory must be recorded from the related route or stop/);
  assert.match(movementForm, /href="\/routes"/);
});

test("quick product creation is a separate accessible form, never nested in the adjustment form", () => {
  const adjustmentFormStart = movementForm.indexOf("<form action={submitMovementAction}");
  const adjustmentFormEnd = movementForm.indexOf("</form>", adjustmentFormStart);
  const quickAddFormStart = movementForm.indexOf("<form action={quickAddAction}");
  const quickAddFormEnd = movementForm.indexOf("</form>", quickAddFormStart);

  assert.ok(adjustmentFormStart >= 0 && adjustmentFormEnd > adjustmentFormStart);
  assert.ok(quickAddFormStart > adjustmentFormEnd && quickAddFormEnd > quickAddFormStart,
    "HTML forms must be siblings so quick-add cannot accidentally submit the storage adjustment");
  assert.match(movementForm, /role="dialog" aria-modal="true" aria-labelledby="quick-add-product-title"/);
  assert.match(movementForm, /id="quick-add-product-title"/);
});
