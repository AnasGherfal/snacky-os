import fs from "node:fs";

const file = "src/components/operator/ManualRouteSalesSection.tsx";
let source = fs.readFileSync(file, "utf8");

const choicesOld = '  const productChoices = sourceMode === "preferred" ? preferredProducts : allProducts;';
if (!source.includes(choicesOld)) throw new Error("productChoices source not found");
source = source.replace(choicesOld, '  const productChoices = allProducts;');

const buttonsOld = `              <div className="flex flex-wrap gap-2">\n                <button type="button" onClick={() => setSourceMode("preferred")} className={sourceMode === "preferred" ? "btn-primary" : "btn-secondary"}>\n                  {tr("Priority products", "المنتجات ذات الأولوية") }\n                </button>\n                <button type="button" onClick={() => setSourceMode("all")} className={sourceMode === "all" ? "btn-primary" : "btn-secondary"}>\n                  {tr("Other storage products", "منتجات مخزنية أخرى")}\n                </button>\n              </div>\n\n`;
if (!source.includes(buttonsOld)) throw new Error("source mode buttons not found");
source = source.replace(buttonsOld, `              <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">\n                {tr("Search the full active product catalog. Machine and route products are still shown first when relevant.", "ابحث في جميع المنتجات النشطة. منتجات الماكينة والجولة تبقى ظاهرة كخيارات مفضلة عند ارتباطها بالموقع.")}\n              </div>\n\n`);

const pickerLabelOld = '                label={sourceMode === "preferred" ? tr("Product", "المنتج") : tr("Other storage products", "منتجات مخزنية أخرى")}';
if (!source.includes(pickerLabelOld)) throw new Error("picker label not found");
source = source.replace(pickerLabelOld, '                label={tr("Product", "المنتج")}');

const filterOld = `  const filtered = useMemo(() => {\n    const needle = query.trim().toLowerCase();\n    if (!needle) return products.slice(0, 8);\n    return products.filter((product) => [product.name, product.sku, product.barcode, product.category, product.brand].some((field) => String(field ?? "").toLowerCase().includes(needle))).slice(0, 8);\n  }, [products, query]);`;
const filterNew = `  const filtered = useMemo(() => {\n    const needle = query.trim().toLowerCase();\n    if (!needle) return products.slice(0, 20);\n    return products\n      .filter((product) => [product.name, product.sku, product.barcode, product.category, product.brand]\n        .some((field) => String(field ?? "").toLowerCase().includes(needle)))\n      .slice(0, 50);\n  }, [products, query]);`;
if (!source.includes(filterOld)) throw new Error("product filter not found");
source = source.replace(filterOld, filterNew);

source = source.replace(
  'placeholder={selected ? `${selected.name} - ${selected.sku ?? t("No SKU", "No SKU")}` : t("Search name, SKU, barcode, category, or brand", "Search name, SKU, barcode, category, or brand")}',
  'placeholder={selected ? `${selected.name} - ${selected.sku ?? tr("No SKU", "بدون رمز")}` : tr("Search all products by name, SKU, barcode, category, or brand", "ابحث في كل المنتجات بالاسم أو الرمز أو الباركود أو التصنيف أو العلامة")}',
);

source = source.replace('  const [sourceMode, setSourceMode] = useState<"preferred" | "all">("preferred");\n', '');

fs.writeFileSync(file, source);
console.log("Manual-sale full catalog search fix applied");
