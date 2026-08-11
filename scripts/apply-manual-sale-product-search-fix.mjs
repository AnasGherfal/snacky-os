import fs from "node:fs";

const file = "src/components/operator/ManualRouteSalesSection.tsx";
let source = fs.readFileSync(file, "utf8");

const originalState = '  const [sourceMode, setSourceMode] = useState<"preferred" | "all">("preferred");\n';
source = source.replace(originalState, "");

const originalChoices = '  const productChoices = sourceMode === "preferred" ? preferredProducts : allProducts;\n';
const newChoices = `  const preferredProductIds = useMemo(() => new Set(preferredProducts.map((product) => product.id)), [preferredProducts]);\n  const productChoices = useMemo(() => {\n    const seen = new Set<string>();\n    return [...preferredProducts, ...allProducts].filter((product) => {\n      if (!product.id || seen.has(product.id)) return false;\n      seen.add(product.id);\n      return true;\n    });\n  }, [preferredProducts, allProducts]);\n`;
if (!source.includes(originalChoices)) throw new Error("Could not find productChoices block");
source = source.replace(originalChoices, newChoices);

const oldButtons = `              <div className="flex flex-wrap gap-2">\n                <button type="button" onClick={() => setSourceMode("preferred")} className={sourceMode === "preferred" ? "btn-primary" : "btn-secondary"}>\n                  {tr("Priority products", "المنتجات ذات الأولوية") }\n                </button>\n                <button type="button" onClick={() => setSourceMode("all")} className={sourceMode === "all" ? "btn-primary" : "btn-secondary"}>\n                  {tr("Other storage products", "منتجات مخزنية أخرى")}\n                </button>\n              </div>\n\n`;
if (!source.includes(oldButtons)) throw new Error("Could not find source mode buttons");
source = source.replace(oldButtons, `              <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">\n                {tr("Search every active product in Snacky OS. Products related to this machine or route appear first.", "ابحث في جميع المنتجات النشطة في سناكي. منتجات هذه الماكينة أو الجولة تظهر أولاً.")}\n              </div>\n\n`);

const oldPicker = `              <ManualSaleProductPicker\n                products={productChoices}\n                value={productId}\n                onChange={handleSelectProduct}\n                label={sourceMode === "preferred" ? tr("Product", "المنتج") : tr("Other storage products", "منتجات مخزنية أخرى")}\n              />`;
const newPicker = `              <ManualSaleProductPicker\n                products={productChoices}\n                preferredProductIds={preferredProductIds}\n                value={productId}\n                onChange={handleSelectProduct}\n                label={tr("Product", "المنتج")}\n              />`;
if (!source.includes(oldPicker)) throw new Error("Could not find picker invocation");
source = source.replace(oldPicker, newPicker);

const oldSignature = `function ManualSaleProductPicker({\n  products,\n  value,\n  onChange,\n  label,\n}: {\n  products: ManualRouteSaleProductOption[];\n  value: string;\n  onChange: (productId: string) => void;\n  label: string;\n}) {`;
const newSignature = `function ManualSaleProductPicker({\n  products,\n  preferredProductIds,\n  value,\n  onChange,\n  label,\n}: {\n  products: ManualRouteSaleProductOption[];\n  preferredProductIds: Set<string>;\n  value: string;\n  onChange: (productId: string) => void;\n  label: string;\n}) {`;
if (!source.includes(oldSignature)) throw new Error("Could not find picker signature");
source = source.replace(oldSignature, newSignature);

const oldFilter = `  const filtered = useMemo(() => {\n    const needle = query.trim().toLowerCase();\n    if (!needle) return products.slice(0, 8);\n    return products.filter((product) => [product.name, product.sku, product.barcode, product.category, product.brand].some((field) => String(field ?? "").toLowerCase().includes(needle))).slice(0, 8);\n  }, [products, query]);`;
const newFilter = `  const filtered = useMemo(() => {\n    const needle = query.trim().toLowerCase();\n    const matches = needle\n      ? products.filter((product) => [product.name, product.sku, product.barcode, product.category, product.brand]\n          .some((field) => String(field ?? "").toLowerCase().includes(needle)))\n      : products;\n\n    return [...matches]\n      .sort((left, right) => {\n        const preferredDiff = Number(preferredProductIds.has(right.id)) - Number(preferredProductIds.has(left.id));\n        if (preferredDiff) return preferredDiff;\n        const availableDiff = Number(right.availableQty > 0) - Number(left.availableQty > 0);\n        if (availableDiff) return availableDiff;\n        return left.name.localeCompare(right.name);\n      })\n      .slice(0, needle ? 50 : 20);\n  }, [products, preferredProductIds, query]);`;
if (!source.includes(oldFilter)) throw new Error("Could not find picker filter");
source = source.replace(oldFilter, newFilter);

const oldPlaceholder = '          placeholder={selected ? `${selected.name} - ${selected.sku ?? t("No SKU", "No SKU")}` : t("Search name, SKU, barcode, category, or brand", "Search name, SKU, barcode, category, or brand")}';
const newPlaceholder = '          placeholder={selected ? `${selected.name} - ${selected.sku ?? tr("No SKU", "بدون رمز")}` : tr("Search all products by name, SKU, barcode, category, or brand", "ابحث في كل المنتجات بالاسم أو الرمز أو الباركود أو التصنيف أو العلامة")}';
if (!source.includes(oldPlaceholder)) throw new Error("Could not find search placeholder");
source = source.replace(oldPlaceholder, newPlaceholder);

const oldNoSku = '{product.sku ?? t("No SKU", "No SKU")} - {tr("Bag available", "المتاح في الحقيبة")}: {product.availableQty}';
const newNoSku = '{product.sku ?? tr("No SKU", "بدون رمز")} - {tr("Bag available", "المتاح في الحقيبة")}: {product.availableQty}';
source = source.replace(oldNoSku, newNoSku);

const oldResultStart = '          {filtered.map((product) => (';
const newResultStart = `          {query.trim() ? (\n            <p className="px-3 pb-1 text-xs text-slate-500">\n              {tr("Showing", "عرض")} {filtered.length} {tr("matching products", "منتج مطابق")}\n            </p>\n          ) : null}\n          {filtered.map((product) => (`;
if (!source.includes(oldResultStart)) throw new Error("Could not find result map");
source = source.replace(oldResultStart, newResultStart);

const oldName = '<span className="block truncate font-medium">{product.name}</span>';
const newName = `<span className="flex items-center gap-2">\n                    <span className="block min-w-0 flex-1 truncate font-medium">{product.name}</span>\n                    {preferredProductIds.has(product.id) ? (\n                      <span className={\`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold \${product.id === value ? "bg-white/15 text-white" : "bg-sky-100 text-sky-700"}\`}>\n                        {tr("Route / machine", "الجولة / الماكينة")}\n                      </span>\n                    ) : null}\n                  </span>`;
if (!source.includes(oldName)) throw new Error("Could not find product name row");
source = source.replace(oldName, newName);

fs.writeFileSync(file, source);
console.log("Applied manual sale full-catalog product search fix");
