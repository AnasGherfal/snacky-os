import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "src/app/routes/[id]/page.tsx");
let source = fs.readFileSync(sourcePath, "utf8");

const wrongSelect = '.select("id, route_id, route_stop_id, machine_id, product_id, product_name, quantity, unit_price_lyd, total_amount_lyd, payment_method, sale_time, status")';
const correctSelect = '.select("id, route_id, route_stop_id, machine_id, product_id, product_name, quantity, unit_sale_price_lyd, total_amount_lyd, payment_method, sale_time, status")';

if (source.includes(correctSelect) && !source.includes(wrongSelect)) {
  console.log("Route summary manual-sales query is already fixed.");
  process.exit(0);
}

const matches = source.split(wrongSelect).length - 1;
if (matches !== 1) {
  throw new Error(`Expected exactly one incorrect manual-sales select, found ${matches}.`);
}

source = source.replace(wrongSelect, correctSelect);
fs.writeFileSync(sourcePath, source);
console.log("Fixed route summary manual-sales query column.");
