from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, value: str) -> None:
    (ROOT / path).write_text(value, encoding="utf-8")


def replace_once(source: str, label: str, before: str, after: str) -> str:
    count = source.count(before)
    if count == 0 and after in source:
        return source
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return source.replace(before, after, 1)


def regex_once(source: str, label: str, pattern: str, replacement: str) -> str:
    updated, count = re.subn(pattern, replacement, source, count=1, flags=re.S)
    if count == 0 and replacement in source:
        return source
    if count != 1:
        raise RuntimeError(f"{label}: expected one regex match, found {count}")
    return updated


# Route stop page: additive UI and client-side gate only.
route_path = "src/app/operator/routes/[id]/stops/[stopId]/page.tsx"
route = read(route_path)
route = replace_once(
    route,
    "route safety imports",
    'import { ManualRouteSalesSection, type ManualRouteSaleProductOption } from "@/components/operator/ManualRouteSalesSection";',
    'import { CompressorSafetyProofCard } from "@/components/operator/CompressorSafetyProofCard";\nimport { ManualRouteSalesSection, type ManualRouteSaleProductOption } from "@/components/operator/ManualRouteSalesSection";\nimport { RouteStopQuickActions } from "@/components/operator/RouteStopQuickActions";',
)
route = replace_once(
    route,
    "compressor state",
    '  const [finalPhotoFile, setFinalPhotoFile] = useState<File | null>(null);',
    '  const [finalPhotoFile, setFinalPhotoFile] = useState<File | null>(null);\n  const [compressorSafetyInstalled, setCompressorSafetyInstalled] = useState(false);\n  const [compressorProofReady, setCompressorProofReady] = useState(false);',
)
route = replace_once(
    route,
    "compressor completion gate",
    '''    if (!finalPhotoFile && !canReuseCompletedProof) {
      setError("Please take or upload the final machine photo before completing the stop.");
      return;
    }

    localDraft.saveNow();''',
    '''    if (!finalPhotoFile && !canReuseCompletedProof) {
      setError("Please take or upload the final machine photo before completing the stop.");
      return;
    }
    if (compressorSafetyInstalled && !compressorProofReady && stopData.stopStatus !== ROUTE_STOP_COMPLETED_STATUS) {
      setError("Save the compressor ON photo before completing this stop.");
      document.getElementById("compressor-safety")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    localDraft.saveNow();''',
)
route = replace_once(
    route,
    "compressor submit readiness",
    '  const canSubmitStop = !submitting && (cleaningDone || isEditingCompletedStop);',
    '  const compressorReadyForSubmit = !compressorSafetyInstalled || compressorProofReady || isEditingCompletedStop;\n  const canSubmitStop = !submitting && (cleaningDone || isEditingCompletedStop) && compressorReadyForSubmit;',
)
route = replace_once(
    route,
    "quick actions placement",
    '        {!localDraft.pendingDraft ? <DraftSaveStatus status={localDraft.status} /> : null}',
    '        {!localDraft.pendingDraft ? <DraftSaveStatus status={localDraft.status} /> : null}\n        <RouteStopQuickActions />',
)
route = replace_once(
    route,
    "compressor metric",
    '          <Metric label={t("Proof photo")} value={stopExecutionSummary.proofReady ? t("Ready") : t("Needed")} tone={stopExecutionSummary.proofReady ? "neutral" : "warn"} />',
    '          <Metric label={t("Proof photo")} value={stopExecutionSummary.proofReady ? t("Ready") : t("Needed")} tone={stopExecutionSummary.proofReady ? "neutral" : "warn"} />\n          <Metric label={t("Compressor proof")} value={!compressorSafetyInstalled ? t("Setup pending") : compressorProofReady ? t("Ready") : t("Needed")} tone={compressorSafetyInstalled && !compressorProofReady ? "warn" : "neutral"} />',
)
route = replace_once(
    route,
    "compressor card placement",
    '''        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">{t("Refill proof")}</h2>''',
    '''        <CompressorSafetyProofCard
          routeId={routeId}
          stopId={stopId}
          machineId={stopData.machineId}
          completed={isEditingCompletedStop}
          onStateChange={({ installed, ready }) => {
            setCompressorSafetyInstalled(installed);
            setCompressorProofReady(ready);
          }}
        />

        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">{t("Refill proof")}</h2>''',
)

# Replace the adjustment section's two always-open forms with one quick selected form.
function_start = route.index("function InventoryAdjustmentsSection({")
function_end = route.index("function InventoryAdjustmentForm({", function_start)
section = route[function_start:function_end]
section = replace_once(
    section,
    "adjustment active state",
    '  const returnedQuantity = returnedAdjustments.reduce((sum, adjustment) => sum + Number(adjustment.quantity ?? 0), 0);',
    '''  const returnedQuantity = returnedAdjustments.reduce((sum, adjustment) => sum + Number(adjustment.quantity ?? 0), 0);
  const [activeAdjustmentType, setActiveAdjustmentType] = useState<InventoryAdjustmentType | null>(null);

  useEffect(() => {
    const openAdjustment = (event: Event) => {
      const requested = (event as CustomEvent<{ adjustmentType?: InventoryAdjustmentType }>).detail?.adjustmentType;
      setActiveAdjustmentType(requested === "returned_from_machine" ? "returned_from_machine" : "damaged");
    };
    window.addEventListener("snacky:open-inventory-adjustment", openAdjustment);
    return () => window.removeEventListener("snacky:open-inventory-adjustment", openAdjustment);
  }, []);''',
)
section = replace_once(
    section,
    "adjustment section anchor",
    '    <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">',
    '    <section id="inventory-adjustments" className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">',
)
old_forms_pattern = r'''      <div className="mt-4 grid gap-4 xl:grid-cols-2">\n        <InventoryAdjustmentForm\n          adjustmentType="damaged".*?\n      </div>\n\n      <div className="mt-6">'''
new_forms = '''      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setActiveAdjustmentType("damaged")} className={activeAdjustmentType === "damaged" ? "btn-primary" : "btn-secondary"}>{t("Damaged")}</button>
        <button type="button" onClick={() => setActiveAdjustmentType("returned_from_machine")} className={activeAdjustmentType === "returned_from_machine" ? "btn-primary" : "btn-secondary"}>{t("Return from machine")}</button>
      </div>

      {activeAdjustmentType ? (
        <div className="mt-4">
          <InventoryAdjustmentForm
            key={activeAdjustmentType}
            adjustmentType={activeAdjustmentType}
            title={activeAdjustmentType === "damaged" ? t("Add damaged product") : t("Add returned product")}
            description={activeAdjustmentType === "damaged" ? t("Record items that broke, expired, melted, or cannot be sold.") : t("Record products removed from the machine and brought back.")}
            routeId={routeId}
            stopId={stopId}
            machineId={machineId}
            machineProducts={machineProducts}
            allProducts={allProducts}
            reasonOptions={activeAdjustmentType === "damaged" ? damagedReasonOptions : returnedReasonOptions}
            submitLabel={activeAdjustmentType === "damaged" ? t("Save damaged product") : t("Save returned product")}
            onSaved={(adjustment) => {
              onSaved(adjustment);
              setActiveAdjustmentType(null);
            }}
          />
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
          {t("Choose Damaged or Return from machine. Then search and save only that product.")}
        </div>
      )}

      <div className="mt-6">'''
section = regex_once(section, "single adjustment form", old_forms_pattern, new_forms)
route = route[:function_start] + section + route[function_end:]
write(route_path, route)

# Manual sale quick action listener.
manual_path = "src/components/operator/ManualRouteSalesSection.tsx"
manual = read(manual_path)
manual = replace_once(manual, "manual sale useEffect import", 'import { useMemo, useRef, useState } from "react";', 'import { useEffect, useMemo, useRef, useState } from "react";')
manual = replace_once(
    manual,
    "manual sale open event",
    '  const routeLocked = isRouteLocked(routeStatus);\n\n  const productChoices',
    '''  const routeLocked = isRouteLocked(routeStatus);

  useEffect(() => {
    const openManualSale = () => {
      setExpanded(true);
      setShowForm(true);
    };
    window.addEventListener("snacky:open-manual-sale", openManualSale);
    return () => window.removeEventListener("snacky:open-manual-sale", openManualSale);
  }, []);

  const productChoices''',
)
manual = replace_once(manual, "manual sale section id", '<section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">', '<section id="manual-route-sales" className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">')
write(manual_path, manual)

# Server-side compressor proof postcondition. Missing migration keeps old route usable.
actions_path = "src/lib/operator-actions.ts"
actions = read(actions_path)
actions = replace_once(
    actions,
    "server compressor proof gate",
    '''    const hasExistingCompletionPhoto = Boolean(existingProof?.machine_photo_url || existingProof?.machine_photo_path);
    if (!hasNewCompletionPhoto && !hasExistingCompletionPhoto) throw new Error("Take or upload a final machine photo before completing the stop.");

    const [{ data: machine, error: machineError }, { data: operatorMember, error: operatorError }] = await Promise.all([''',
    '''    const hasExistingCompletionPhoto = Boolean(existingProof?.machine_photo_url || existingProof?.machine_photo_path);
    if (!hasNewCompletionPhoto && !hasExistingCompletionPhoto) throw new Error("Take or upload a final machine photo before completing the stop.");

    const { data: compressorProof, error: compressorProofError } = await supabase
      .from("route_stop_safety_checks")
      .select("compressor_confirmed, proof_photo_url, proof_photo_path")
      .eq("route_stop_id", stopId)
      .maybeSingle();
    if (compressorProofError && !isMissingTable(compressorProofError, "route_stop_safety_checks")) {
      throwActionError(compressorProofError, "Could not verify compressor safety proof.");
    }
    if (!compressorProofError && (!compressorProof?.compressor_confirmed || (!compressorProof.proof_photo_url && !compressorProof.proof_photo_path))) {
      throw new Error("Save the compressor ON photo before completing this stop.");
    }

    const [{ data: machine, error: machineError }, { data: operatorMember, error: operatorError }] = await Promise.all([''',
)
write(actions_path, actions)

# Sales dashboard: keep VMS source truth and add a separate combined operational total card.
sales_path = "src/app/sales/page.tsx"
sales = read(sales_path)
sales = replace_once(
    sales,
    "operational sales import",
    'import { KpiSection, BarList } from "@/components/KpiDashboard";',
    'import { KpiSection, BarList } from "@/components/KpiDashboard";\nimport { OperationalSalesSummary } from "@/components/OperationalSalesSummary";',
) if 'import { KpiSection, BarList } from "@/components/KpiDashboard";' in sales else replace_once(
    sales,
    "operational sales import",
    'import { BarList, KpiSection } from "@/components/KpiDashboard";',
    'import { BarList, KpiSection } from "@/components/KpiDashboard";\nimport { OperationalSalesSummary } from "@/components/OperationalSalesSummary";',
)
sales = replace_once(
    sales,
    "operational sales placement",
    '      <div className="space-y-6">\n        <section className="surface-card space-y-4">',
    '''      <div className="space-y-6">
        <OperationalSalesSummary
          dateFrom={selectedRange.start}
          dateTo={selectedRange.end}
          vmsRevenue={summary.revenueAmount}
          vmsUnits={summary.successfulUnitsSold}
        />
        <section className="surface-card space-y-4">''',
)
write(sales_path, sales)

# Navigation and cache refreshes.
tabs_path = "src/components/module-tabs-config.ts"
tabs = read(tabs_path)
tabs = replace_once(tabs, "product activity report tab", '  { label: "Cash Reconciliation", href: "/reports/cash-reconciliation" },', '  { label: "Cash Reconciliation", href: "/reports/cash-reconciliation" },\n  { label: "Product Activity", href: "/reports/route-product-activity" },')
write(tabs_path, tabs)

manual_api_path = "src/app/api/operator/routes/[id]/stops/[stopId]/manual-sales/route.ts"
manual_api = read(manual_api_path)
manual_api = replace_once(
    manual_api,
    "manual sales report refresh",
    '  revalidatePath("/inventory/movements");\n}',
    '  revalidatePath("/inventory/movements");\n  revalidatePath("/sales");\n  revalidatePath("/reports");\n  revalidatePath("/reports/route-product-activity");\n}',
)
write(manual_api_path, manual_api)

adjustment_api_path = "src/app/api/operator/routes/[id]/stops/[stopId]/adjustments/route.ts"
adjustment_api = read(adjustment_api_path)
adjustment_api = replace_once(
    adjustment_api,
    "adjustment activity refresh",
    '    revalidatePath("/reports/inventory-adjustments");',
    '    revalidatePath("/reports/inventory-adjustments");\n    revalidatePath("/reports/route-product-activity");',
)
write(adjustment_api_path, adjustment_api)

# Verify integration markers and protect the route completion payload.
requirements = {
    route_path: [
        "CompressorSafetyProofCard",
        "RouteStopQuickActions",
        "compressorReadyForSubmit",
        'fetchWithTimeout(`/api/operator/routes/${routeId}/stops/${stopId}`',
        "clientSubmissionId: clientSubmissionIdRef.current",
        'window.addEventListener("snacky:open-inventory-adjustment"',
    ],
    manual_path: ['id="manual-route-sales"', 'window.addEventListener("snacky:open-manual-sale"'],
    actions_path: ["route_stop_safety_checks", "Save the compressor ON photo before completing this stop."],
    sales_path: ["OperationalSalesSummary", "summary.revenueAmount", "summary.successfulUnitsSold"],
    tabs_path: ["Product Activity", "/reports/route-product-activity"],
}
for path, markers in requirements.items():
    value = read(path)
    missing = [marker for marker in markers if marker not in value]
    if missing:
        raise RuntimeError(f"{path}: missing integration markers {missing}")

print("Route safety and product activity integration applied.")
