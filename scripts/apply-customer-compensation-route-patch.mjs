import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function patchFile(relativePath, patches, assertions) {
  const file = path.join(root, relativePath);
  let source = fs.readFileSync(file, "utf8");

  for (const { oldText, newText, label } of patches) {
    if (source.includes(newText)) continue;
    const first = source.indexOf(oldText);
    const second = first < 0 ? -1 : source.indexOf(oldText, first + oldText.length);
    if (first < 0 || second >= 0) throw new Error(`Could not safely patch ${label} in ${relativePath}`);
    source = source.slice(0, first) + newText + source.slice(first + oldText.length);
  }

  for (const { text, label } of assertions) {
    if (!source.includes(text)) throw new Error(`Missing ${label} after patching ${relativePath}`);
  }

  fs.writeFileSync(file, source);
}

patchFile(
  "src/app/operator/routes/[id]/stops/[stopId]/page.tsx",
  [
    {
      label: "saved final photo reuse",
      oldText: `    const canReuseCompletedProof = stopData.stopStatus === ROUTE_STOP_COMPLETED_STATUS && stopData.hasCompletionPhoto;`,
      newText: `    const canReuseSavedProof = Boolean(stopData.hasCompletionPhoto);`,
    },
    {
      label: "saved final photo completion guard",
      oldText: `    if (!finalPhotoFile && !canReuseCompletedProof) {`,
      newText: `    if (!finalPhotoFile && !canReuseSavedProof) {`,
    },
    {
      label: "completion button proof readiness",
      oldText: `  const canSubmitStop = !submitting && (cleaningDone || isEditingCompletedStop) && compressorReadyForSubmit;`,
      newText: `  const canSubmitStop = !submitting && (cleaningDone || isEditingCompletedStop) && compressorReadyForSubmit && stopExecutionSummary.proofReady;`,
    },
    {
      label: "independent final machine photo UI",
      oldText: `            <div>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setFinalPhotoFile(file);
                  setFinalPhotoName(file?.name ?? "");
                }}
                className="field-input"
              />
              {finalPhotoFile ? <p className="mt-2 text-sm text-slate-600">{tr("Selected", "المحدد")}: {finalPhotoFile.name}</p> : null}
              {!finalPhotoFile && stopData.hasCompletionPhoto ? <p className="mt-2 text-sm text-slate-600">{tr("A completion photo is already saved for this stop. Add a new photo only if you want to replace it.", "تم حفظ صورة إنهاء لهذا الموقع بالفعل. أضف صورة جديدة فقط عند الرغبة في استبدالها.")}</p> : null}
              {!finalPhotoFile && !stopData.hasCompletionPhoto ? <p className="mt-2 text-sm text-amber-700">{tr("Final photo is required before completion.", "الصورة النهائية مطلوبة قبل الإنهاء.")}</p> : null}
            </div>`,
      newText: `            <div>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent("snacky:open-machine-photo"))}
                className="btn-secondary w-full"
              >
                {stopData.hasCompletionPhoto
                  ? tr("Replace saved machine photo", "استبدال صورة الماكينة المحفوظة")
                  : tr("Save final machine photo", "حفظ صورة الماكينة النهائية")}
              </button>
              {stopData.hasCompletionPhoto ? (
                <p className="mt-2 text-sm font-medium text-emerald-700">
                  {tr("The final machine photo is saved independently and will be reused when this stop is completed.", "صورة الماكينة النهائية محفوظة بشكل مستقل وسيتم استخدامها عند إنهاء الموقع.")}
                </p>
              ) : (
                <p className="mt-2 text-sm text-amber-700">
                  {tr("Save the final machine photo now. It will remain attached after refresh, app close, or connection failure.", "احفظ صورة الماكينة النهائية الآن. ستبقى مرتبطة بالموقع بعد التحديث أو إغلاق التطبيق أو انقطاع الاتصال.")}
                </p>
              )}
            </div>`,
    },
  ],
  [
    { text: "const canReuseSavedProof = Boolean(stopData.hasCompletionPhoto);", label: "saved proof reuse guard" },
    { text: 'new CustomEvent("snacky:open-machine-photo")', label: "machine photo quick-action trigger" },
    { text: "&& stopExecutionSummary.proofReady;", label: "proof-ready completion gate" },
  ],
);

patchFile(
  "src/components/operator/RouteStopQuickActions.tsx",
  [
    {
      label: "compensation reason labels",
      oldText: `function clientId() {
  return \`${Date.now()}-${Math.random().toString(16).slice(2)}\`;
}
`,
      newText: `function clientId() {
  return \`${Date.now()}-${Math.random().toString(16).slice(2)}\`;
}

function compensationReasonLabel(value: string, locale: string) {
  const labels: Record<string, [string, string]> = {
    paid_no_product: ["Paid but product did not dispense", "دفع ولم يخرج المنتج"],
    product_jammed: ["Product jammed", "المنتج عالق"],
    wrong_product: ["Wrong product dispensed", "خرج منتج خاطئ"],
    dispensing_damage: ["Product damaged during dispensing", "تلف المنتج أثناء خروجه"],
    previous_unresolved_issue: ["Previous unresolved vending issue", "مشكلة بيع سابقة لم تُحل"],
    damaged_or_stuck: ["Product damaged or stuck", "المنتج تالف أو عالق"],
    other: ["Other", "سبب آخر"],
  };
  const label = labels[value] ?? [value.replaceAll("_", " "), value.replaceAll("_", " ")];
  return locale === "ar" ? label[1] : label[0];
}
`,
    },
    {
      label: "external machine photo opener",
      oldText: `  const scope = routeScope();

  useEffect(() => {`,
      newText: `  const scope = routeScope();

  useEffect(() => {
    const openMachinePhoto = () => setPhotoOpen(true);
    window.addEventListener("snacky:open-machine-photo", openMachinePhoto);
    return () => window.removeEventListener("snacky:open-machine-photo", openMachinePhoto);
  }, []);

  useEffect(() => {`,
    },
    {
      label: "expanded compensation reasons",
      oldText: `                  <option value="paid_no_product">{tr("Paid but nothing came out", "دفع ولم يخرج المنتج")}</option>
                  <option value="wrong_product">{tr("Wrong product dispensed", "خرج منتج خاطئ")}</option>
                  <option value="damaged_or_stuck">{tr("Product damaged or stuck", "المنتج تالف أو عالق")}</option>
                  <option value="other">{tr("Other", "سبب آخر")}</option>`,
      newText: `                  <option value="paid_no_product">{tr("Paid but product did not dispense", "دفع ولم يخرج المنتج")}</option>
                  <option value="product_jammed">{tr("Product jammed", "المنتج عالق")}</option>
                  <option value="wrong_product">{tr("Wrong product dispensed", "خرج منتج خاطئ")}</option>
                  <option value="dispensing_damage">{tr("Product damaged during dispensing", "تلف المنتج أثناء خروجه")}</option>
                  <option value="previous_unresolved_issue">{tr("Previous unresolved vending issue", "مشكلة بيع سابقة لم تُحل")}</option>
                  <option value="other">{tr("Other", "سبب آخر")}</option>`,
    },
    {
      label: "compensation reason in stop history",
      oldText: `                      {record.claimed_amount_lyd != null ? <div className="mt-1 text-slate-600">{tr("Claimed payment", "المبلغ المدفوع حسب العميل")}: {Number(record.claimed_amount_lyd).toLocaleString()} LYD</div> : null}`,
      newText: `                      <div className="mt-1 text-slate-600">{compensationReasonLabel(record.claim_type, locale)}</div>
                      {record.claimed_amount_lyd != null ? <div className="mt-1 text-slate-600">{tr("Claimed payment", "المبلغ المدفوع حسب العميل")}: {Number(record.claimed_amount_lyd).toLocaleString()} LYD</div> : null}`,
    },
  ],
  [
    { text: 'value="product_jammed"', label: "product jammed reason" },
    { text: 'value="dispensing_damage"', label: "dispensing damage reason" },
    { text: 'value="previous_unresolved_issue"', label: "previous unresolved issue reason" },
    { text: 'window.addEventListener("snacky:open-machine-photo"', label: "machine photo event listener" },
    { text: "compensationReasonLabel(record.claim_type, locale)", label: "reason display in stop history" },
  ],
);

console.log("Applied customer compensation and independently saved machine-photo route updates.");
