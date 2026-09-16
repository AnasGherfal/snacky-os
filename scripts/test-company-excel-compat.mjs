import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import {parseVmsUpload, sheetRowsToRecords, detectVmsReportTypeFromRows, findSalesReportPeriod} from '../src/lib/vms-parser.ts';
const rows=[
 ['Machine code','Product Number','Product name','Inventory quantity','Inventory capacity','Unit price','Date'],
 ['QA-M1','000123','مياه للشرب',0,12,2.5,'2026-09-16'],
 ['QA-M2','000456','شوكولاتة',3,10,4.75,'2026-09-15'],
];
for(const bookType of ['biff8','xlsx']){
 test(`real ${bookType} bytes preserve Arabic, zero stock, decimal values and textual identifiers`, async()=>{
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'مخزون');
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Title'],['Other sheet']]),'Other');
  const extension=bookType==='biff8'?'xls':'xlsx';
  const buffer=XLSX.write(book,{type:'buffer',bookType});
  const parsed=await parseVmsUpload(new File([buffer],`qa.${extension}`));
  assert.equal(parsed.fileType,extension);assert.deepEqual(parsed.sheets.map(s=>s.name),['مخزون','Other']);
  assert.deepEqual(parsed.sheets[0].rows, rows.map(r=>r.map(String)));
  const table=sheetRowsToRecords(parsed.sheets[0].rows,{reportType:'machine_stock_snapshot',headerRowIndex:0});
  assert.equal(table.records.length,2);assert.equal(table.records[0].inventory_quantity,'0');assert.equal(table.records[0].product_number,'000123');
 });
 test(`real ${bookType} workbook preserves a merged monthly title and report period`,async()=>{
  const data=[['Statistical statement of commodity profit(2026-03-01/2026-03-31)'],['Merchant ID','Merchant Name','Machine code','Machine name','Product Number','product name','Commodity price','Number of transaction','Transaction amount','Refund count','Refund amount','Total Transaction','Total Transaction amount','Cost Price','Cost Amount','Profits'],['QA','QA','QM1','QA location','0001','مياه',2.5,10,25,1,2.5,11,27.5,1.2,12,13]];
  const sheet=XLSX.utils.aoa_to_sheet(data);sheet['!merges']=[{s:{r:0,c:0},e:{r:0,c:15}}];
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'Profit');
  const buffer=XLSX.write(book,{type:'buffer',bookType});
  const parsed=await parseVmsUpload(new File([buffer],`profit.${bookType==='biff8'?'xls':'xlsx'}`));
  const sheetRows=parsed.sheets[0].rows;
  assert.equal(detectVmsReportTypeFromRows(sheetRows),'monthly_product_profit');
  const period=findSalesReportPeriod(sheetRows);assert.equal(period.reportStartDate,'2026-03-01');assert.equal(period.reportEndDate,'2026-03-31');
 });
}
