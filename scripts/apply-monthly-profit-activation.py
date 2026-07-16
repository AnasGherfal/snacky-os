from pathlib import Path

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


actions_path = "src/lib/vms-import-actions.ts"
actions = read(actions_path)
actions = replace_once(
    actions,
    "monthly profit activation import",
    'import { isOptionalVmsImportBatchMetadataField, sanitizeVmsImportBatchPayload } from "@/lib/vms-import-batch-payload";',
    'import { isOptionalVmsImportBatchMetadataField, sanitizeVmsImportBatchPayload } from "@/lib/vms-import-batch-payload";\nimport { ensureMonthlyProfitBatchActivated } from "@/lib/vms-monthly-profit-activation";',
)

old_function_start = "async function deactivateOlderActiveMonthlyProfitBatches({"
old_function_end = "async function ensureConfirmedStockImportBatchIsUsable({"
if old_function_start in actions:
    start = actions.index(old_function_start)
    end = actions.index(old_function_end, start)
    actions = actions[:start] + actions[end:]

old_monthly_block = '''  if (reportType === "monthly_product_profit" && effectiveImportedRows > 0) {
    await deactivateOlderActiveMonthlyProfitBatches({
      supabase,
      currentBatchId: batch.id,
      reportStartDate: finalizedReportStartDate,
      reportEndDate: finalizedReportEndDate,
      fileHash,
      updatedAt: new Date().toISOString(),
    });
  }'''
new_monthly_block = '''  if (reportType === "monthly_product_profit" && effectiveImportedRows > 0) {
    const monthlyProfitActivation = await ensureMonthlyProfitBatchActivated({
      supabase,
      batchId: batch.id,
      actorId: profile.team_member_id ?? profile.id ?? null,
    });
    if (!monthlyProfitActivation.ok) {
      console.error("[vms-import] Monthly Product Profit rows were saved but activation repair failed", {
        batchId: batch.id,
        code: monthlyProfitActivation.code,
        message: monthlyProfitActivation.message,
        details: monthlyProfitActivation.details,
      });
      redirect(`/vms-import/${batch.id}?error=${encodeURIComponent(`${monthlyProfitActivation.message}${monthlyProfitActivation.details ? ` ${monthlyProfitActivation.details}` : ""}`)}`);
      return;
    }
  }'''
actions = replace_once(actions, "automatic monthly profit activation", old_monthly_block, new_monthly_block)

old_generic_enable = '''  } else if (action === "enable" || action === "restore") {
    const restoredReportType = beforeReportType ? canonicalImportedReportType(beforeReportType) : null;'''
new_generic_enable = '''  } else if ((action === "enable" || action === "restore") && beforeReportType === "monthly_product_profit") {
    const monthlyProfitActivation = await ensureMonthlyProfitBatchActivated({
      supabase,
      batchId,
      actorId,
    });
    if (!monthlyProfitActivation.ok) {
      redirect(`/vms-import/${batchId}?error=${encodeURIComponent(`${monthlyProfitActivation.message}${monthlyProfitActivation.details ? ` ${monthlyProfitActivation.details}` : ""}`)}`);
    }
    await logActivity({
      profile,
      action: "update",
      entityType: "vms_import",
      entityId: batchId,
      entityLabel: textValue(beforeBatch.file_name) || batchId,
      beforeData: beforeBatch,
      afterData: monthlyProfitActivation,
      summary: `Activated Monthly Product Profit import ${textValue(beforeBatch.file_name) || batchId}`,
    });
    revalidateVmsDataSourcePaths(batchId);
    revalidatePath("/product-planning");
    redirect(`/vms-import/${batchId}?success=${encodeURIComponent(`Activated ${monthlyProfitActivation.rowCount} Monthly Product Profit row(s) through ${monthlyProfitActivation.reportEndDate}.`)}`);
  } else if (action === "enable" || action === "restore") {
    const restoredReportType = beforeReportType ? canonicalImportedReportType(beforeReportType) : null;'''
actions = replace_once(actions, "generic monthly profit activation repair", old_generic_enable, new_generic_enable)

actions = replace_once(
    actions,
    "monthly planning data revalidation helper",
    '  revalidatePath("/vms-import");\n  if (batchId) revalidatePath(`/vms-import/${batchId}`);',
    '  revalidatePath("/vms-import");\n  if (batchId) revalidatePath(`/vms-import/${batchId}`);\n  revalidatePath("/product-planning");',
)
actions = replace_once(
    actions,
    "monthly planning final import revalidation",
    '  revalidatePath("/products-dashboard");\n  revalidatePath("/machines-dashboard");',
    '  revalidatePath("/products-dashboard");\n  revalidatePath("/product-planning");\n  revalidatePath("/machines-dashboard");',
)
write(actions_path, actions)

page_path = "src/app/vms-import/[batchId]/page.tsx"
page = read(page_path)
page = replace_once(
    page,
    "monthly activation page import",
    'import { reprocessVmsImportBatch, updateVmsImportBatchState } from "@/lib/vms-import-actions";',
    'import { reprocessVmsImportBatch, updateVmsImportBatchState } from "@/lib/vms-import-actions";\nimport { activateMonthlyProfitImportBatch } from "@/lib/vms-monthly-profit-actions";',
)
activation_input = '<input type="hidden" name="action" value={stringValue(batch.status) === "deleted" ? "restore" : "enable"} />'
input_index = page.index(activation_input)
form_marker = '<form action={updateVmsImportBatchState} className="space-y-3 rounded-lg border border-slate-200 p-3">'
form_index = page.rfind(form_marker, 0, input_index)
if form_index < 0:
    raise RuntimeError("monthly activation page form: could not locate activation form")
conditional_form = '<form action={reportType === "monthly_product_profit" ? activateMonthlyProfitImportBatch : updateVmsImportBatchState} className="space-y-3 rounded-lg border border-slate-200 p-3">'
page = page[:form_index] + conditional_form + page[form_index + len(form_marker):]
page = replace_once(
    page,
    "monthly activation explanation",
    ': "Restores active imported status and recalculates dashboard views."}',
    ': reportType === "monthly_product_profit"\n                      ? "Verifies saved Monthly Product Profit rows, activates this upload, and disables older partial uploads for the same month."\n                      : "Restores active imported status and recalculates dashboard views."}',
)
write(page_path, page)

for path, required in {
    actions_path: [
        'ensureMonthlyProfitBatchActivated',
        'Monthly Product Profit rows were saved but activation repair failed',
        'revalidatePath("/product-planning")',
    ],
    page_path: [
        'activateMonthlyProfitImportBatch',
        'disables older partial uploads for the same month',
    ],
}.items():
    source = read(path)
    missing = [value for value in required if value not in source]
    if missing:
        raise RuntimeError(f"{path}: missing expected integration markers: {missing}")

print("Monthly Product Profit activation integration applied.")
