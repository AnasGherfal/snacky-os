import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { historicalCell, groupInvestorHistory } from '../src/lib/investor-history.ts';
import { historicalPaymentPosition, historicalPaymentSummary } from '../src/lib/investor-history-payment.ts';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
// Synthetic records only. No real investor identity or financial data in Git.
const row = {
  id: 'sample-1', investor_user_id: 'investor-a', month_start: '2022-01-01',
  profit_lyd: 1000, cogs_refill_cost_lyd: null, other_opex_lyd: -1500,
  previous_month_lyd: null, net_profit_lyd: -500, exchange_rate_lyd_per_usd: 5,
  net_profit_usd: -100, investor_share_percent: 30, investor_share_usd: -30,
  source_label: 'Synthetic source', source_note: null,
  source_cells: { Month: 'January 2022', Profit: '1000', 'COGS / Refill Cost (LYD)': '',
    'Other OpEx (LYD)': '-1500', 'previous month': '', 'Net Profit (LYD)': '-500.00 LYD',
    'Exchange Rate (LYD per USD)': '5', 'Net Profit (USD)': '-$100.00', 'Investor Share 30% (USD)': '-$30.00' },
};
const confirmation = { confirmed_payable_usd: 0, confirmed_paid_usd: 0,
  payment_confirmed_at: '2022-04-05T12:00:00Z', payment_confirmation_note: 'Synthetic owner confirmation: nothing paid' };
const unpaidRows = [
  { ...row, ...confirmation },
  { ...row, ...confirmation, id: 'sample-2', month_start: '2022-02-01', previous_month_lyd: -500,
    investor_share_usd: 12, confirmed_payable_usd: 12,
    source_cells: { ...row.source_cells, Month: 'February 2022', 'previous month': '-500.00 LYD', 'Investor Share 30% (USD)': '$12.00' } },
  { ...row, ...confirmation, id: 'sample-3', month_start: '2022-03-01', investor_share_usd: 75.29, confirmed_payable_usd: 75.29,
    source_cells: { ...row.source_cells, Month: 'March 2022', 'Investor Share 30% (USD)': '$75.29' } },
];

test('historical cells preserve source labels, signs and blanks instead of inferring COGS or revenue', () => {
  assert.equal(historicalCell(row, 'Profit', row.profit_lyd), '1000');
  assert.equal(historicalCell(row, 'COGS / Refill Cost (LYD)', null), '—');
  assert.equal(historicalCell(row, 'previous month', null), '—');
  assert.equal(historicalCell(row, 'Investor Share 30% (USD)', -30), '-$30.00');
  assert.equal(historicalCell(row, 'Net Profit (LYD)', -500), '-500.00 LYD');
  assert.equal(historicalCell(row, 'Unspecified', null), '—');
  assert.equal(historicalCell(row, 'Invalid number', NaN), '—');
  assert.equal(historicalCell(row, 'Explicit zero', 0), '0.00');
});

test('provided USD rounding is displayed as supplied, never recomputed from the LYD total', () => {
  const differing = { ...row, net_profit_lyd: 999, net_profit_usd: 199.8,
    source_cells: { ...row.source_cells, 'Net Profit (USD)': '$199.81' } };
  assert.equal(historicalCell(differing, 'Net Profit (USD)', differing.net_profit_usd), '$199.81');
});

test('carried loss is retained once in the next source row without netting historical share values', () => {
  const feb = { ...row, id: 'sample-2', month_start: '2022-02-01', previous_month_lyd: -500,
    net_profit_lyd: 200, net_profit_usd: 40, investor_share_usd: 12,
    source_cells: { ...row.source_cells, Month: 'February 2022', 'previous month': '-500.00 LYD', 'Investor Share 30% (USD)': '$12.00' } };
  const groups = groupInvestorHistory([feb, { ...row, id: 'other', investor_user_id: 'investor-b' }, row]);
  assert.deepEqual(groups.get('investor-a').map(r => r.id), ['sample-1', 'sample-2']);
  assert.equal(groups.get('investor-a')[1].previous_month_lyd, -500);
  assert.equal(groups.get('investor-a')[1].investor_share_usd, 12);
  assert.equal(groups.get('investor-b').length, 1);
  assert.doesNotMatch(read('src/lib/investor-history.ts'), /reduce\(|Math\.max|\.rpc\(|\.insert\(/);
});

test('explicit unpaid positions never subtract the already-carried negative source share again', () => {
  const summary = historicalPaymentSummary(unpaidRows);
  assert.equal(summary.validScope, true);
  assert.equal(summary.confirmedCount, 3);
  assert.equal(summary.dueCents, 8729);
  assert.equal(summary.paidCents, 0);
  assert.equal(summary.remainingCents, 8729);
  assert.deepEqual(summary.positions.map(p => p.status), ['no_payout_due', 'unpaid', 'unpaid']);
  assert.equal(unpaidRows[0].investor_share_usd, -30);
  assert.equal(unpaidRows[1].previous_month_lyd, -500);
  assert.doesNotMatch(read('src/lib/investor-history-payment.ts'), /\.rpc\(|\.insert\(|row\.investor_share_usd|row\.net_profit_lyd/);
});

test('unknown payment positions stay unknown, and invalid confirmations cannot invent balances', () => {
  assert.deepEqual(historicalPaymentPosition(row), { confirmed: false, status: 'unconfirmed' });
  for (const bad of [null, '', -1, NaN, Infinity, '0.001', false]) {
    assert.equal(historicalPaymentPosition({ ...row, ...confirmation, confirmed_payable_usd: bad }).confirmed, false);
  }
  assert.equal(historicalPaymentPosition({ ...row, ...confirmation, confirmed_paid_usd: 1 }).confirmed, false);
  assert.equal(historicalPaymentPosition({ ...row, ...confirmation, payment_confirmed_at: null }).confirmed, false);
  assert.equal(historicalPaymentPosition({ ...row, ...confirmation, payment_confirmation_note: '' }).confirmed, false);
  assert.equal(historicalPaymentPosition({ ...unpaidRows[1], confirmed_paid_usd: 5 }).status, 'partially_paid');
  assert.equal(historicalPaymentPosition({ ...unpaidRows[1], confirmed_paid_usd: 12 }).status, 'paid');
  const mixed = historicalPaymentSummary([unpaidRows[0], { ...row, month_start: '2022-04-01' }]);
  assert.equal(mixed.unconfirmedCount, 1);
  assert.equal(historicalPaymentSummary([unpaidRows[0], unpaidRows[0]]).remainingCents, null);
  assert.equal(historicalPaymentSummary([unpaidRows[0], { ...unpaidRows[1], investor_user_id: 'other' }]).validScope, false);
});

function* walk(node) {
  if (Array.isArray(node)) { for (const item of node) yield* walk(item); return; }
  if (!node || typeof node !== 'object') return;
  yield node;
  yield* walk(node.props?.children);
}
function renderedText(node) {
  if (Array.isArray(node)) return node.map(renderedText).join(' ');
  if (node && typeof node === 'object') return renderedText(node.props?.children);
  return node === null || node === undefined || typeof node === 'boolean' ? '' : String(node);
}
function loadComponent(file, imports) {
  const code = ts.transpileModule(read(file), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  vm.runInNewContext(code, { exports, console, require(name) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    assert.ok(name in imports, name);
    return imports[name];
  } });
  return exports;
}
const historyImports = {
  '@/lib/investor-history': { historicalCell },
  '@/lib/investor-history-payment': { historicalPaymentSummary },
};

test('actual historical table renders signed USD source text, no payout button and correct direction', () => {
  const { InvestorHistoryTable } = loadComponent('src/components/InvestorHistoryTable.tsx', historyImports);
  for (const ar of [false, true]) {
    const tree = InvestorHistoryTable({ rows: [row], investorName: 'Synthetic investor', ar });
    const nodes = [...walk(tree)], text = renderedText(tree);
    assert.equal(tree.props.dir, ar ? 'rtl' : 'ltr');
    assert.ok(text.includes('-$30.00'));
    assert.ok(text.includes('-500.00 LYD'));
    assert.ok(text.includes('—'));
    assert.equal(nodes.filter(n => n.type === 'form' || n.type === 'button').length, 0);
    assert.equal(nodes.filter(n => n.type === 'th' && n.props.scope === 'col').length, 9);
    if (!ar) {
      assert.match(text, /payment status not supplied/);
      assert.match(text, /do not subtract it again/);
      assert.match(text, /excluded from the current LYD entitlement totals/);
    }
  }
});

test('confirmed history visibly shows zero paid, USD outstanding and no payout due for the loss month', () => {
  const { InvestorHistoryTable } = loadComponent('src/components/InvestorHistoryTable.tsx', historyImports);
  for (const ar of [false, true]) {
    const tree = InvestorHistoryTable({ rows: unpaidRows, investorName: 'Synthetic investor', ar });
    const text = renderedText(tree), nodes = [...walk(tree)];
    assert.equal(tree.props.dir, ar ? 'rtl' : 'ltr');
    assert.ok(text.includes('$87.29'));
    assert.ok(text.includes('$0.00'));
    assert.ok(text.includes('-$30.00'));
    assert.ok(text.includes(ar ? 'غير مدفوع' : 'Unpaid'));
    assert.ok(text.includes(ar ? 'لا توجد دفعة مستحقة' : 'No payout due'));
    assert.equal(nodes.filter(n => n.type === 'form' || n.type === 'button').length, 0);
    assert.equal(nodes.filter(n => n.type === 'time').length, 3);
    assert.doesNotMatch(text, /payment status not supplied/);
  }
});

test('both screens attach history outside the agreement-dependent pages', () => {
  assert.match(read('src/app/finance/investors/layout.tsx'), /InvestorHistoryLayout ownerOnly/);
  assert.match(read('src/app/investor/layout.tsx'), /<InvestorHistoryLayout>\{children\}/);
  const boundary = read('src/components/InvestorHistoryLayout.tsx');
  assert.match(boundary, /getAuthenticatedSupabaseServerClient/);
  assert.match(boundary, /query\.eq\('investor_user_id', profile\.id\)/);
  assert.match(boundary, /profile\.active_status !== 'active'/);
  assert.match(boundary, /!isOwnerAdminRole\(profile\)/);
  assert.match(boundary, /if \(result\.error\) throw result\.error/);
  assert.doesNotMatch(boundary, /getSupabaseAdminClient|investor_agreements|recordInvestorCommand/);
  assert.match(boundary, /This does not mean the history is empty/);
});
