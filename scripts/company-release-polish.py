# One-shot exact-match presentation/read-selector patch. No database or data writes.
from pathlib import Path

def replace(path,old,new,count=1):
 p=Path(path);s=p.read_text();assert s.count(old)==count,(path,old,s.count(old));p.write_text(s.replace(old,new))

replace('src/app/dashboard/page.tsx','operator:team_members(full_name)','operator:team_members!routes_operator_id_fkey(full_name)',2)
replace('src/components/CompanyEditor.tsx','  companyWorkPaths,','  companyWorkPaths,\n  companyWorkLabel,')
replace('src/components/CompanyEditor.tsx','                  {path}\n                </option>','                  {companyWorkLabel(path, ar)}\n                </option>')
replace('src/components/CompanyHub.tsx',"{data.total} {tr('materials', 'مادة')}","{data.total} {tr(data.total === 1 ? 'material' : 'materials', 'مادة')}")
p=Path('src/lib/company-hub.ts');s=p.read_text();assert 'export function companyWorkLabel' not in s
p.write_text(s+'''
/** Human-readable choices; stored values remain the canonical existing routes. */
const companyWorkLabels: Record<string, [string, string]> = {
  '/my-work': ['My Work', 'عملي اليوم'],
  '/my-work/team': ['Team Work', 'عمل الفريق'],
  '/locations-pipeline': ['Leads & Visits', 'الجهات والزيارات'],
  '/locations-pipeline/new': ['Add a lead', 'إضافة جهة'],
  '/issues': ['Customer Issues', 'مشاكل العملاء'],
  '/issues/new': ['Add a customer issue', 'إضافة مشكلة عميل'],
  '/relationships': ['Existing Locations', 'المواقع الحالية'],
  '/relationships/obligations': ['Location Payments', 'دفعات المواقع'],
  '/follow-ups': ['Follow-ups', 'المتابعات'],
  '/follow-ups/new': ['Add a follow-up', 'إضافة متابعة'],
  '/operator/routes': ['My Routes', 'مساراتي'],
  '/operator/issues/actions': ['Assigned customer actions', 'إجراءات العملاء المسندة إليّ'],
  '/inventory': ['Storage Inventory', 'مخزون المخزن'],
  '/purchases': ['Purchases', 'المشتريات'],
  '/finance': ['Finance', 'المالية'],
  '/team': ['Team', 'الفريق'],
};
export function companyWorkLabel(path: string, ar: boolean): string {
  return companyWorkLabels[path]?.[ar ? 1 : 0] ?? path;
}
''')
# Original importer already canonicalizes the legacy stock label. Preserve the
# persisted-batch/row assertions while requiring that specific current contract.
replace('scripts/company-e2e/native.mjs','writeFileSync(temp,text);','''assert.ok(readFileSync('src/lib/vms-import-actions.ts','utf8').includes('return isMachineStockReport(reportType) ? "machine_stock_snapshot" : reportType;'),'Re-review any importer canonical type change');
const oldType='assert.equal(batch.report_type, expectations.reportType);';
assert.equal(text.split(oldType).length,2);
text=text.replace(oldType,'assert.equal(batch.report_type, expectations.reportType === "stock" ? "machine_stock_snapshot" : expectations.reportType);');
writeFileSync(temp,text);''')
