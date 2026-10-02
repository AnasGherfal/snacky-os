import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const api = fs.readFileSync(path.join(repoRoot, "src/app/api/operator/routes/[id]/stops/[stopId]/route.ts"), "utf8");
const page = fs.readFileSync(path.join(repoRoot, "src/app/operator/routes/[id]/stops/[stopId]/page.tsx"), "utf8");
const manualSales = fs.readFileSync(path.join(repoRoot, "src/components/operator/ManualRouteSalesSection.tsx"), "utf8");

test("operator stop initial payload defers the full active product catalog", () => {
  assert.match(api, /const catalogOnly = new URL\(request\.url\)\.searchParams\.get\("catalog"\) === "all"/);
  assert.match(api, /if \(catalogOnly\) \{[\s\S]*return NextResponse\.json\(\{ productOptions \}\)/);
  assert.match(api, /const initialProductIds = new Set<string>/);
  assert.match(api, /const initialProductOptions = productOptions\.filter/);
  assert.match(api, /productOptions: initialProductOptions/);
  assert.match(api, /productCatalogDeferred: initialProductOptions\.length < productOptions\.length/);
});

test("operator stop loads the full catalog only on demand", () => {
  assert.match(page, /const \[fullProductCatalog, setFullProductCatalog\] = useState<ProductOption\[\] \| null>\(null\)/);
  assert.match(page, /\?catalog=all/);
  assert.match(page, /onRequestAllProducts=\{loadFullProductCatalog\}/);
  assert.match(page, /onLoadAllProducts=\{loadFullProductCatalog\}/);
  assert.match(page, /allProductsLoading=\{productCatalogLoading\}/);
});

test("manual sales can start from priority products while the full catalog loads", () => {
  assert.match(manualSales, /onRequestAllProducts\?: \(\) => Promise<ManualRouteSaleProductOption\[\]>/);
  assert.match(manualSales, /const productChoices = allProducts\.length \? allProducts : preferredProducts/);
  assert.match(manualSales, /void ensureFullProductCatalog\(\)/);
  assert.match(manualSales, /allProductsLoading/);
});
