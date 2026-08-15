import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "src/app/routes/new/RouteCreateForm.tsx");
let source = fs.readFileSync(file, "utf8");

function once(oldText, newText, label) {
  if (source.includes(newText)) return;
  const first = source.indexOf(oldText);
  const second = first < 0 ? -1 : source.indexOf(oldText, first + oldText.length);
  if (first < 0 || second >= 0) throw new Error(`Could not safely patch ${label}`);
  source = source.slice(0, first) + newText + source.slice(first + oldText.length);
}

once(
`      setRecommendationKeys(Array.isArray(draft.recommendationKeys) ? draft.recommendationKeys : []);
      setFinalTakeByRecommendationGroup(draft.finalTakeByRecommendationGroup ?? {});`,
`      // Route creation now has one machine-scoped product plan. Legacy drafts must not
      // restore the old separate recommendation selection and double-count quantities.
      setRecommendationKeys([]);
      setFinalTakeByRecommendationGroup({});`,
"legacy recommendation draft reset",
);

once(
`  const manualSearchQuery = deferredSearch.trim().toLowerCase();

  const machineScopedProductCandidates = useMemo(() => {`,
`  const manualSearchQuery = deferredSearch.trim().toLowerCase();

  // Search belongs to the machine currently being edited. Never carry a product search
  // from one machine into another machine's picker.
  useEffect(() => {
    setSearch("");
    setBarcode("");
    setNotFoundQuery("");
  }, [selectedManualMachineId]);

  const machineScopedProductCandidates = useMemo(() => {`,
"machine-scoped search reset",
);

once(
`      <FormSection title="Manual machine refill items">
        <p className="text-sm text-slate-500">{tr(locale, "Manual products must be assigned to a machine stop. The route pick list is calculated from these stop plans plus selected recommendations.", "يجب ربط المنتجات اليدوية بموقع جهاز. تُحسب قائمة التحميل من خطط المواقع هذه بالإضافة إلى التوصيات المختارة.")}</p>`,
`      <FormSection title={tr(locale, "Build machine stops", "تجهيز أجهزة الجولة")}>
        <p className="text-sm text-slate-500">{tr(locale, "Choose a machine, then add every product and quantity for that machine in one place. Snacky OS shows recommendations inside the same product list instead of using a second selection workflow.", "اختر جهازًا ثم أضف كل المنتجات والكميات الخاصة بهذا الجهاز من مكان واحد. يعرض Snacky OS التوصيات داخل نفس قائمة المنتجات بدل وجود طريقة اختيار ثانية.")}</p>`,
"unified section heading",
);

once(
`                          onClick={() => addProductQty(candidate.product.id, 1)}
                          className="rounded-lg border border-slate-200 bg-white p-3 text-left transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"`,
`                          onClick={() => {
                            const nextQty = candidate.recommendedQty > 0
                              ? candidate.recommendedQty
                              : Math.max(1, candidate.selectedQty + 1);
                            setDesiredManualQty(selectedManualMachineId, candidate.product.id, nextQty);
                          }}
                          className={\`rounded-lg border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 \${candidate.selectedQty > 0 ? "border-emerald-300 bg-emerald-50/70" : "border-slate-200 bg-white hover:border-slate-400"}\`}`, 
"recommended product one-tap quantity",
);

once(
`                                {candidate.recommendedQty > 0 ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-800">Recommended {candidate.recommendedQty}</span> : null}
                                {candidate.selectedQty > 0 ? <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-900">Selected {candidate.selectedQty}</span> : null}`, 
`                                {candidate.recommendedQty > 0 ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-800">{tr(locale, "Suggested", "المقترح")} {candidate.recommendedQty}</span> : null}
                                {candidate.selectedQty > 0 ? <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-900">{tr(locale, "Assigned", "المحدد")} {candidate.selectedQty}</span> : null}
                                <span className="rounded-full bg-slate-100 px-2 py-1 font-medium text-slate-700">
                                  {candidate.recommendedQty > 0 ? tr(locale, "Tap to use suggested qty", "اضغط لاستخدام الكمية المقترحة") : tr(locale, "Tap to add", "اضغط للإضافة")}
                                </span>`,
"recommendation action labels",
);

once(
`                  {!sortedManualStopItems.length ? (`,
`                  {!selectedManualItems.length ? (`,
"selected machine empty state",
);

once(
`                    sortedManualStopItems.map((item) => {`,
`                    selectedManualItems.map((item) => {`,
"selected machine item table",
);

once(
`                        {tr(locale, "No manual machine refill items selected yet.", "لم يتم تحديد أي عناصر تعبئة يدوية للجهاز بعد.")}`, 
`                        {selectedManualMachine
                          ? tr(locale, "No products assigned to this machine yet.", "لم يتم تحديد منتجات لهذا الجهاز بعد.")
                          : tr(locale, "Choose a machine first.", "اختر جهازًا أولاً.")}`, 
"machine-specific empty copy",
);

once(
`      <FormSection title="Refill recommendation rows">`,
`      <div className="hidden" aria-hidden="true">
      <FormSection title="Refill recommendation rows">`,
"hide legacy recommendation selector start",
);

once(
`      </FormSection>
      </div>

      <FormSection title={creationMode === "stops_only" ? tr(locale, "Choose planned machine stops", "اختر مواقع الأجهزة المخططة") : tr(locale, "Add machine stops manually", "إضافة مواقع الأجهزة يدويًا")}>`,
`      </FormSection>
      </div>
      </div>

      <FormSection title={creationMode === "stops_only" ? tr(locale, "Choose planned machine stops", "اختر مواقع الأجهزة المخططة") : tr(locale, "Route machines", "أجهزة الجولة")}>`,
"hide legacy recommendation selector end",
);

if (!source.includes('title={tr(locale, "Build machine stops", "تجهيز أجهزة الجولة")}')) throw new Error("Unified builder heading missing");
if (!source.includes('!selectedManualItems.length')) throw new Error("Machine-scoped selected table missing");
if (!source.includes('className="hidden" aria-hidden="true"')) throw new Error("Legacy recommendation selector was not hidden");

fs.writeFileSync(file, source);
console.log("Applied unified machine-scoped route builder UX.");
