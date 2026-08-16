import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "src/app/routes/new/RouteCreateForm.tsx");
let source = fs.readFileSync(sourcePath, "utf8");

function replaceExactlyOnce(oldText, newText, label) {
  const first = source.indexOf(oldText);
  const second = first < 0 ? -1 : source.indexOf(oldText, first + oldText.length);
  if (first < 0 || second >= 0) throw new Error(`Could not safely apply ${label}: expected exactly one source match.`);
  source = source.slice(0, first) + newText + source.slice(first + oldText.length);
}

if (source.includes("Use recommended quantities for this machine")) {
  console.log("Route creation recommendation UX fix is already applied.");
  process.exit(0);
}

replaceExactlyOnce(
`                  onChange={(event) => {
                    setManualMachineId(event.target.value);
                    setMachineIds((current) => current.includes(event.target.value) ? current : [...current, event.target.value]);
                  }}`,
`                  onChange={(event) => {
                    const machineId = event.target.value;
                    setManualMachineId(machineId);
                    if (machineId) {
                      setMachineIds((current) => current.includes(machineId) ? current : [...current, machineId]);
                      setRecommendationMachineFilter(machineId);
                      setRecommendationSearch("");
                      setRecommendationPriorityFilter("");
                      setRecommendationPage(1);
                    }
                  }}`,
  "machine selection recommendation focus",
);

replaceExactlyOnce(
`                    <button
                      key={machineId}
                      type="button"
                      onClick={() => setManualMachineId(machineId)}`,
`                    <button
                      key={machineId}
                      type="button"
                      onClick={() => {
                        setManualMachineId(machineId);
                        setRecommendationMachineFilter(machineId);
                        setRecommendationSearch("");
                        setRecommendationPriorityFilter("");
                        setRecommendationPage(1);
                      }}`,
  "machine chip recommendation focus",
);

replaceExactlyOnce(
`                <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
                  <FormField label={\`Search \${machineLabel(selectedManualMachine)} products\`}>`,
`                <div className={selectedManualRecommendationGroups.some((group) => group.recommendedTotal > 0) ? "rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-4" : "rounded-2xl border border-slate-200 bg-white p-4"}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr(locale, "Recommended refill", "التعبئة الموصى بها")}</div>
                      {selectedManualRecommendationGroups.some((group) => group.recommendedTotal > 0) ? (
                        <>
                          <div className="mt-1 text-lg font-semibold text-slate-950">
                            {tr(locale, "Snacky OS found", "وجد Snacky OS")} {selectedManualRecommendationGroups.filter((group) => group.recommendedTotal > 0).length} {tr(locale, "products to refill", "منتجات تحتاج تعبئة")}
                          </div>
                          <div className="mt-1 text-sm text-slate-600">
                            {tr(locale, "Recommended total", "الإجمالي الموصى به")}: {selectedManualRecommendationGroups.reduce((sum, group) => sum + Math.max(0, group.recommendedTotal), 0)} {tr(locale, "units", "وحدة")}
                          </div>
                        </>
                      ) : (
                        <div className="mt-1 text-sm text-slate-600">
                          {machineDiagnosticsById.get(selectedManualMachineId)?.reasonMessage ?? tr(locale, "No refill is currently recommended for this machine.", "لا توجد تعبئة موصى بها حاليًا لهذا الجهاز.")}
                        </div>
                      )}
                    </div>
                    {selectedManualRecommendationGroups.some((group) => group.recommendedTotal > 0) ? (
                      <button
                        type="button"
                        className="btn-primary shrink-0"
                        onClick={() => selectRecommendationGroups(selectedManualRecommendationGroups)}
                        disabled={saving}
                      >
                        {tr(locale, "Use recommended quantities for this machine", "استخدم الكميات الموصى بها لهذا الجهاز")}
                      </button>
                    ) : null}
                  </div>
                  {selectedManualRecommendationGroups.some((group) => group.recommendedTotal > 0) ? (
                    <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {selectedManualRecommendationGroups
                        .filter((group) => group.recommendedTotal > 0)
                        .sort((a, b) => b.recommendedTotal - a.recommendedTotal || a.productName.localeCompare(b.productName))
                        .slice(0, 12)
                        .map((group) => {
                          const selected = isRecommendationGroupSelected(group);
                          return (
                            <button
                              key={group.groupKey}
                              type="button"
                              onClick={() => toggleRecommendationGroup(group)}
                              className={selected ? "rounded-xl border border-emerald-400 bg-white p-3 text-left shadow-sm" : "rounded-xl border border-emerald-200 bg-white/80 p-3 text-left"}
                              disabled={saving}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate font-semibold text-slate-900">{group.productName}</span>
                                <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-800">{group.recommendedTotal}</span>
                              </div>
                              <div className="mt-1 text-xs text-slate-500">
                                {selected ? tr(locale, "Added to route", "تمت إضافته للجولة") : tr(locale, "Tap to add recommendation", "اضغط لإضافة التوصية")}
                              </div>
                            </button>
                          );
                        })}
                    </div>
                  ) : null}
                </div>

                <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
                  <FormField label={\`Search \${machineLabel(selectedManualMachine)} products\`}>`,
  "machine recommendation quick panel",
);

fs.writeFileSync(sourcePath, source);
console.log("Applied route creation recommendation UX fix.");
