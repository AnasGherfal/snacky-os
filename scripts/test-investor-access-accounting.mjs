import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { register } from 'node:module';
register('./ts-alias-loader.mjs',import.meta.url);
const {selectedTeamRoles,teamProductPermission}=await import('../src/lib/team-role-selection.ts');
const {calculateInvestorMonth,monthBounds}=await import('../src/lib/investor-profit.ts');
const {isInvestorCapitalPurchase}=await import('../src/lib/investor-expenses.ts');
const {getEffectivePermissions}=await import('../src/lib/authz.ts');
const {isProfitAffectingTransaction,transactionImpacts}=await import('../src/lib/finance-balance.ts');
const read=(path)=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
const expense=(id,category,amount,extra={})=>({id,category,amount,signed_amount:-amount,direction:'money_out',currency:'LYD',transaction_effect:'expense',transaction_status:'active',review_status:'confirmed',import_status:'confirmed',...extra});
const sales=[{net_sales_amount:45000,cogs_amount:24000,gross_profit_amount:21000,source:'vms',cost_missing:false}];
const costs=[expense('rent','Rent',1000),expense('salary','Salaries',2500),expense('maintenance','Maintenance',1500),expense('other','Utilities',1000)];

test('investor-only is an exact replacement, not added to old operator role',()=>{
 assert.deepEqual(selectedTeamRoles(['investor']),['investor']);
 assert.deepEqual(selectedTeamRoles(['operator','investor']),['operator','investor']);
 assert.deepEqual(getEffectivePermissions({id:'test',role:'investor',roles:['investor'],canAddProducts:false}),['investor.view']);
 assert.equal(teamProductPermission(['investor'],true),false);
 assert.throws(()=>selectedTeamRoles([]));assert.throws(()=>selectedTeamRoles(['bad-role']));
 const actions=read('src/lib/team-actions.ts'),form=read('src/components/TeamMemberForm.tsx');
 assert.match(actions,/selectedTeamRoles\(formData.getAll\("roles"\)\)/);
 assert.doesNotMatch(form,/name="role"|LocalDraftForm/);
 assert.match(actions,/profileResult.error/);
});

test('30% uses profit after rent, payroll and all other recorded operating costs',()=>{
 const value=calculateInvestorMonth({salesRows:sales,ledgerRows:costs,sharePercent:30});
 assert.equal(value.revenueLyd,45000);assert.equal(value.cogsLyd,24000);
 assert.equal(value.operatingExpensesLyd,6000);assert.equal(value.operatingProfitLyd,15000);
 assert.equal(value.investorShareDueLyd,4500);assert.equal(value.complete,true);
 assert.equal(value.expenseBreakdown.find(row=>row.key==='rent')?.amount,1000);
});

test('stock payments, investor capital, payouts and FX conversion are not deducted twice',()=>{
 const rows=[...costs,expense('stock','Products Restocking',10000,{source_type:'purchase_payment'}),expense('payout','Investor Profit Share',4500,{source_type:'investor_payment'}),expense('capital','Investor Capital',100000,{direction:'money_in',signed_amount:100000,transaction_effect:'income'}),expense('fx','Bank / Exchange',9000,{transaction_effect:'transfer'})];
 const value=calculateInvestorMonth({salesRows:sales,ledgerRows:rows,sharePercent:30});
 assert.equal(value.investorShareDueLyd,4500);assert.equal(value.stockPurchasesLyd,10000);
 assert.equal(isProfitAffectingTransaction(rows[6]),false);
 assert.deepEqual(transactionImpacts({...rows[6],account_id:'snacky_lyd'}),{snacky_lyd:100000});
});

test('new machines are explicit capex, not guessed from a machine rent/repair description',()=>{
 const rows=[...costs,expense('machine','Machine Purchase',22350)];
 const ordinary=calculateInvestorMonth({salesRows:sales,ledgerRows:rows,sharePercent:30});
 assert.equal(ordinary.capitalPurchasesLyd,22350);assert.equal(ordinary.operatingProfitLyd,15000);assert.equal(ordinary.investorShareDueLyd,4500);
 const agreed=calculateInvestorMonth({salesRows:sales,ledgerRows:rows,sharePercent:30,profitBasis:'operating_profit_after_capex'});
 assert.equal(agreed.operatingProfitLyd,15000);assert.equal(agreed.distributionBasisLyd,-7350);assert.equal(agreed.investorShareDueLyd,0);
 assert.equal(isInvestorCapitalPurchase(expense('r','Rent',1000,{description:'Rent for new machine'})),false);
 assert.equal(isInvestorCapitalPurchase(expense('m','Maintenance',1000,{description:'Machine equipment repair'})),false);
});

test('USD expenses use their historical LYD rate or prevent finalization',()=>{
 const converted=calculateInvestorMonth({salesRows:sales,ledgerRows:[expense('usd','Maintenance',100,{currency:'USD',exchange_rate_usd_to_lyd:9})],sharePercent:30});
 assert.equal(converted.operatingExpensesLyd,900);assert.equal(converted.investorShareDueLyd,6030);assert.equal(converted.complete,true);
 const missing=calculateInvestorMonth({salesRows:sales,ledgerRows:[expense('usd','Machine Purchase',2200,{currency:'USD'})],sharePercent:30});
 assert.equal(missing.complete,false);assert.match(missing.accountingWarnings.join(' '),/rate missing/);
});

test('losses, missing cost data and inconsistent source totals never imply a positive finalized return',()=>{
 const loss=calculateInvestorMonth({salesRows:[{net_sales_amount:500,cogs_amount:600,gross_profit_amount:-100}],ledgerRows:costs,sharePercent:30});
 assert.equal(loss.investorShareDueLyd,0);
 const missing=calculateInvestorMonth({salesRows:[{net_sales_amount:500,cogs_amount:null}],ledgerRows:[],sharePercent:30});assert.equal(missing.complete,false);
 const conflict=calculateInvestorMonth({salesRows:[{net_sales_amount:500,cogs_amount:300,gross_profit_amount:400}],ledgerRows:[],sharePercent:30});assert.equal(conflict.complete,false);
 assert.deepEqual(monthBounds('2024-02'),{start:'2024-02-01',end:'2024-02-29'});assert.equal(monthBounds('2026-13'),null);
});

test('owner and portal render the same monthly breakdown without investor write controls',()=>{
 const owner=read('src/app/finance/investors/page.tsx'),portal=read('src/app/investor/page.tsx'),card=read('src/components/InvestorStatementCard.tsx');
 assert.match(owner,/InvestorStatementCard/);assert.match(portal,/InvestorStatementCard/);
 assert.doesNotMatch(portal,/adminUserId=|InvestorMoneyForm|recordInvestorCommand/);
 assert.match(portal,/eq\('investor_user_id',profile.id\)/);
 assert.match(portal,/eq\('calculation_status','finalized'\)/);
 assert.match(card,/review_\$\{key\}/);assert.match(card,/rent_payroll/);assert.match(card,/generated_at/);
 assert.match(owner,/allRows/);assert.match(portal,/readAll/);
});

test('actual money commands use one SQL transaction, correct actor FK and safe retries',()=>{
 const sql=read('supabase/migrations/20260915170000_investor_access_and_ledger.sql');
 const actions=read('src/lib/investor-money-actions.ts');
 const form=read('src/components/InvestorMoneyForm.tsx');
 assert.match(sql,/pg_advisory_xact_lock/);assert.match(sql,/for update/);
 assert.match(sql,/manual_money_out/);assert.match(sql,/false,false,v_actor/);
 assert.match(sql,/Payment exceeds the remaining monthly entitlement/);
 assert.match(sql,/request_payload is distinct from v_request/);
 assert.match(sql,/finance_transaction_id uuid not null unique/);
 assert.match(actions,/snacky_record_investor_payment_v1/);assert.match(actions,/snacky_record_investor_contribution_v1/);
 assert.doesNotMatch(actions,/\.from\(['"]investor_payments['"]\)\.insert/);
 assert.match(form,/localStorage.setItem\(key,JSON.stringify\(request\)\)/);
 assert.match(form,/inFlight.current/);assert.match(form,/client_submission_id/);
});
