import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
const read = path => fs.readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("owner has one monthly statement, a compact action workspace and no duplicate dashboard charts",()=>{
 const page=read("src/app/finance/investors/page.tsx");
 assert.match(page,/isOwnerAdminRole\(profile\)/);
 assert.match(page,/InvestorYearOverview/);
 assert.match(page,/InvestorAdminReview/);
 assert.match(page,/InvestorAdminAgreement/);
 assert.match(page,/InvestorAdminTabs/);
 assert.match(page,/selected\.payout_cap_usd!=null/);
 assert.doesNotMatch(page,/ChartCard|TrendChart/);
 assert.doesNotMatch(page,/Create investor login.*PageHeader/s);
 assert.doesNotMatch(page,/statements\.filter\(s=>s.calculation_status!=='finalized'\)\.map/);
 assert.match(page,/statements\.find\(s=>s.month_start.slice\(0,7\)===reviewMonth\)/);
});

test("three actionable tabs keep their own controls hidden until chosen",()=>{
 const tabs=read("src/components/InvestorAdminTabs.tsx");
 for(const text of ['id: "review"','id: "payment"','id: "manage"']) assert.match(tabs,new RegExp(text));
 assert.equal((tabs.match(/id: "(review|payment|manage)"/g)||[]).length,3);
 assert.match(tabs,/useState<Tab>/);
 assert.match(tabs,/hidden=\{active !== tab.id\}/);
 assert.match(tabs,/aria-selected=\{active === tab.id\}/);
 assert.match(tabs,/dir=\{ar \? "rtl" : "ltr"\}/);
});

test("owner month review has one selected month, a refresh action and explicit approval safeguards",()=>{
 const page=read("src/app/finance/investors/page.tsx");
 const review=read("src/components/InvestorAdminReview.tsx");
 const selector=read("src/components/InvestorAdminMonthSwitcher.tsx");
 const actions=read("src/lib/investor-actions.ts");
 assert.match(review,/InvestorAdminMonthSwitcher/);
 assert.match(review,/action=\{generateInvestorStatement\}/);
 assert.match(review,/action=\{finalizeInvestorStatement\}/);
 assert.match(review,/statement\?\.source_complete === true/);
 assert.match(review,/type="checkbox" required/);
 assert.match(review,/rent_payroll/);
 assert.match(review,/review_\$\{key\}/);
 assert.match(actions,/p_review_checks:checks/);
 assert.match(actions,/month\?:string/);
 assert.match(actions,/bounds.start.slice\(0,7\)/);
 assert.match(actions,/text\(fd,'review_month'\)/);
 assert.match(selector,/router.replace/);
 assert.match(page,/availableMonths/);
});

test("payment retains its atomic command, one LYD transfer and useful tab on redirect",()=>{
 const overview=read("src/components/InvestorYearOverview.tsx");
 const batch=read("src/components/InvestorLydBatchForm.tsx");
 const action=read("src/lib/investor-lyd-payout-actions.ts");
 assert.match(overview,/InvestorAdminTabs/);
 assert.match(overview,/InvestorLydBatchForm/);
 assert.match(overview,/embedded\/>/);
 assert.match(batch,/embedded\?:boolean/);
 assert.match(batch,/open=\{embedded\}/);
 assert.match(action,/snacky_record_investor_lyd_payout_batch_v1/);
 assert.match(action,/tab:"payment"/);
});

test("owner raw source records are tucked inside Review; investor statement is clean",()=>{
 const overview=read("src/components/InvestorYearOverview.tsx");
 const table=read("src/components/InvestorMonthlyTable.tsx");
 const investor=read("src/app/investor/page.tsx");
 assert.match(table,/export function InvestorOwnerEvidence/);
 assert.match(overview,/review=\{<div className="space-y-5">/);
 assert.match(overview,/InvestorOwnerEvidence/);
 assert.match(overview,/InvestorMonthlyTable/);
 assert.match(investor,/admin=\{false\}/);
 assert.doesNotMatch(investor,/InvestorAdminTabs|InvestorOwnerEvidence/);
});
