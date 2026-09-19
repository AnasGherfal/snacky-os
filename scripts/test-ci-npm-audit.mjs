import assert from 'node:assert/strict';
import test from 'node:test';
import { auditArguments, assessAudit, runAudit } from './ci-npm-audit.mjs';

function report(findings = []) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: findings.length };
  const vulnerabilities = {};
  findings.forEach((severity, i) => { counts[severity]++; vulnerabilities[`package-${i}`] = { severity }; });
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: counts, dependencies: { total: 460 } } };
}
const command = (data = report(), status = 0, extra = {}) => ({ stdout: JSON.stringify(data), stderr: '', status, signal: null, ...extra });

test('retains both dependency scopes, optional/peer coverage and original thresholds', () => {
  const all = auditArguments('all'), prod = auditArguments('production');
  assert.ok(all.includes('--include=dev')); assert.ok(all.includes('--audit-level=info'));
  assert.ok(prod.includes('--omit=dev')); assert.ok(prod.includes('--audit-level=high'));
  for (const args of [all, prod]) {
    assert.equal(args[0], 'audit'); assert.ok(args.includes('--package-lock-only'));
    for (const flag of ['--include=optional', '--include=peer', '--include=prod']) assert.ok(args.includes(flag));
    assert.ok(!args.includes('fix')); assert.ok(!args.includes('--force')); assert.ok(!args.includes('--audit-level=none'));
  }
  assert.throws(() => auditArguments('none'));
});

test('zero-exit registry errors, empty JSON and missing coverage never pass', () => {
  for (const data of [{}, [], null, { error: { code: 400 } }, { metadata: { vulnerabilities: { total: 0 } } },
    { ...report(), error: 'registry failed' }, { ...report(), auditReportVersion: 1 }]) {
    assert.equal(assessAudit(command(data), 'all').state, 'unavailable');
  }
  const emptyTree = report(); emptyTree.metadata.dependencies.total = 0;
  assert.equal(assessAudit(command(emptyTree), 'all').state, 'unavailable');
  assert.equal(assessAudit({ stdout: 'bad json', status: 0 }, 'all').state, 'unavailable');
});

test('reports must have consistent nonnegative counts and named vulnerability data', () => {
  for (const change of [r => r.metadata.vulnerabilities.high = -1, r => r.metadata.vulnerabilities.total = 1,
    r => r.vulnerabilities.hidden = { severity: 'critical' }, r => delete r.metadata.vulnerabilities.low,
    r => r.metadata.dependencies.total = '460', r => r.vulnerabilities.pkg = { severity: 'unknown' }]) {
    const r = report(); change(r); assert.equal(assessAudit(command(r), 'all').state, 'unavailable');
  }
});

test('full gate blocks any severity, including low and informational', () => {
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    assert.equal(assessAudit(command(report([severity]), 1), 'all').state, 'blocked');
    assert.equal(assessAudit(command(report([severity]), 0), 'all').state, 'blocked');
  }
});

test('production gate retains high/critical threshold without hiding other findings', () => {
  for (const severity of ['high', 'critical']) assert.equal(assessAudit(command(report([severity]), 1), 'production').state, 'blocked');
  const r = report(['low', 'moderate']);
  const result = assessAudit(command(r), 'production');
  assert.equal(result.state, 'passed'); assert.deepEqual(result.report, r);
});

test('nonzero exits, signals and timeouts cannot claim a clean scan', () => {
  for (const c of [command(report(), 1), command(report(), null), command(report(), 0, { signal: 'SIGTERM' }),
    command(report(), 0, { error: { code: 'ETIMEDOUT' } })]) assert.equal(assessAudit(c, 'all').state, 'unavailable');
});

test('a temporary registry error retries the same command and preserves every attempt', async () => {
  const calls = [], saved = [], waits = [];
  const result = await runAudit({ scope: 'all', log() {}, wait: async ms => waits.push(ms),
    execute: async args => { calls.push([...args]); return calls.length === 1 ? command({ error: '400 Bad Request' }, 1) : command(); },
    save: (n, c, assessment) => saved.push([n, c, assessment.state]),
  });
  assert.equal(result.exitCode, 0); assert.deepEqual(calls[0], calls[1]); assert.deepEqual(waits, [15000]);
  assert.deepEqual(saved.map(x => x[2]), ['unavailable', 'passed']);
});

test('genuine findings are not retried, even after a temporary endpoint failure', async () => {
  let calls = 0;
  const result = await runAudit({ scope: 'all', log() {}, wait: async () => {}, execute: async () => {
    calls++; return calls === 1 ? command({ error: 'offline' }, 1) : command(report(['high']), 1);
  } });
  assert.equal(calls, 2); assert.equal(result.exitCode, 1); assert.equal(result.state, 'blocked');
});

test('persistent endpoint failures remain red after bounded retries', async () => {
  let calls = 0; const waits = [];
  const result = await runAudit({ scope: 'production', log() {}, wait: async ms => waits.push(ms),
    execute: async () => { calls++; return command({ error: { code: '400', message: 'Invalid package tree' } }, 1); },
  });
  assert.equal(calls, 3); assert.deepEqual(waits, [15000, 30000]); assert.equal(result.exitCode, 2);
  assert.equal(result.state, 'unavailable');
});
