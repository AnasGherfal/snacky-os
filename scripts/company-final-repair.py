# Exact-match repair of two defects reproduced by real-stack tests.
# No migration, database permission or live data change.
from pathlib import Path
p=Path('src/app/dashboard/page.tsx');s=p.read_text()
old='status, started_at, updated_at, completed_at';assert s.count(old)==2
p.write_text(s.replace(old,'status, started_at, completed_at'))
p=Path('src/lib/vms-import-actions.ts');s=p.read_text()
anchor='import { logActivity }';assert s.count(anchor)==1
s=s.replace(anchor,'import { weeklyImportRow } from "@/lib/vms-weekly-import-row";\n'+anchor)
old='    if (reportType === "vms_order_details_weekly") {\n      const slotCode =';assert s.count(old)==1
weekly='''    if (reportType === "vms_order_details_weekly") {
      const transaction = weeklyImportRow({
        row, originalRow, batchId: batch.id, rowNumber,
        machineId: machine?.id ?? null, productId: productId ?? null,
      });
      const amount = orderDetailsGrossSalesAmount(row) ?? 0;
      const status = transaction.transaction_status;
      if (status === "successful_sale") {
        summary.successfulSalesRows = (summary.successfulSalesRows ?? 0) + 1;
        summary.estimatedSuccessfulSales = (summary.estimatedSuccessfulSales ?? 0) + amount;
      } else if (status === "failed_vend") {
        summary.failedVendRows = (summary.failedVendRows ?? 0) + 1;
        summary.failedVendAmount = (summary.failedVendAmount ?? 0) + amount;
      } else if (status === "refunded") {
        summary.refundedRows = (summary.refundedRows ?? 0) + 1;
        summary.refundedAmount = (summary.refundedAmount ?? 0) + amount;
      } else if (status === "failed_payment") {
        summary.failedPaymentRows = (summary.failedPaymentRows ?? 0) + 1;
      } else {
        summary.needsReviewTransactionRows = (summary.needsReviewTransactionRows ?? 0) + 1;
      }
      const warnings: string[] = [];
      if (!identifier) warnings.push("missing machine id");
      else if (!machine) warnings.push("unknown machine: " + identifier);
      if (!productId) warnings.push("unmapped product: " + productLabel);
      if (status === "needs_review") warnings.push("transaction status needs review");
      transactionRawRows.push(transaction);
      summary.importedRows += 1;
      finishRow("imported", warnings);
      continue;
    }

    if (reportType === "planogram") {
      const slotCode ='''
s=s.replace(old,weekly);p.write_text(s)
# Add concrete transaction semantics and no-layout-mutation assertions to the real
# weekly import fixture. The original file already has Cargo Lane Number values.
p=Path('scripts/company-e2e/native.mjs');s=p.read_text()
old='writeFileSync(temp,text);';assert s.count(old)==1
new='''const weeklyStart='    const detailPreviewPath = await uploadPreview({';
assert.equal(text.split(weeklyStart).length,2);
text=text.replace(weeklyStart,`    const {data: beforeWeeklySlots, error: beforeWeeklyError}=await service.from("machine_slots").select("id,machine_id,slot_code,product_id,capacity").in("machine_id",created.machineIds).order("id");
    assert.ifError(beforeWeeklyError);
`+weeklyStart);
const weeklyEnd='    await fetchHtml(detailImportPath, owner.cookie);';
assert.equal(text.split(weeklyEnd).length,2);
text=text.replace(weeklyEnd,weeklyEnd+`
    const {data: weeklyRows,error: weeklyError}=await service.from("vms_transactions_raw").select("order_number,cargo_lane_number,payment_amount,quantity,transaction_status").eq("import_batch_id",detailPreviewState.importBatchId);
    assert.ifError(weeklyError);assert.equal(weeklyRows.length,3);
    assert.equal(weeklyRows.reduce((sum,r)=>sum+Number(r.payment_amount),0),11);
    assert.equal(weeklyRows.reduce((sum,r)=>sum+Number(r.quantity),0),4);
    assert.ok(weeklyRows.every(r=>r.transaction_status==="successful_sale"));
    assert.deepEqual(weeklyRows.map(r=>r.cargo_lane_number).sort(),["A1","A4","B1"]);
    const {data: afterWeeklySlots,error: afterWeeklyError}=await service.from("machine_slots").select("id,machine_id,slot_code,product_id,capacity").in("machine_id",created.machineIds).order("id");
    assert.ifError(afterWeeklyError);assert.deepEqual(afterWeeklySlots,beforeWeeklySlots,"Sales imports must not change machine layouts");
`);
writeFileSync(temp,text);'''
s=s.replace(old,new);p.write_text(s)
