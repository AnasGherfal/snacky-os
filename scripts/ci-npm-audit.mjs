/** Keep npm's advisory and metavulnerability analysis; retry only incomplete audits.
 * The two policies mirror the existing CI gates: all severities/all dependencies,
 * and high-or-critical/production dependencies. An unavailable audit never passes.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

export function auditArguments(scope) {
  if (!['all', 'production'].includes(scope)) throw new Error('Choose all or production audit scope.');
  return ['audit', '--json', '--package-lock-only', '--registry=https://registry.npmjs.org',
    '--prefer-online', '--offline=false', '--audit=true', '--fetch-retries=2', '--fetch-timeout=30000', '--loglevel=http',
    '--include=prod', '--include=optional', '--include=peer',
    ...(scope === 'all' ? ['--include=dev', '--audit-level=info'] : ['--omit=dev', '--audit-level=high'])];
}

export function assessAudit(result, scope) {
  auditArguments(scope); // Validate the policy even when inspecting a failed command.
  let report;
  try { report = JSON.parse(result.stdout); } catch { return { state: 'unavailable', reason: 'npm did not return an audit report.' }; }
  const counts = report?.metadata?.vulnerabilities;
  if (!object(report) || report.error || report.auditReportVersion !== 2 || !object(report.vulnerabilities)
      || !object(counts) || !severities.every(key => count(counts[key])) || !count(counts.total)
      || counts.total !== severities.reduce((sum, key) => sum + counts[key], 0)
      || counts.total !== Object.keys(report.vulnerabilities).length
      || !count(report.metadata?.dependencies?.total) || report.metadata.dependencies.total === 0) {
    return { state: 'unavailable', reason: 'npm returned an incomplete/error response, not a completed security assessment.' };
  }
  const actual = Object.fromEntries(severities.map(key => [key, 0]));
  for (const entry of Object.values(report.vulnerabilities)) {
    if (!object(entry) || !severities.includes(entry.severity)) return { state: 'unavailable', reason: 'Invalid vulnerability data.' };
    actual[entry.severity] += 1;
  }
  if (severities.some(key => actual[key] !== counts[key])) return { state: 'unavailable', reason: 'Inconsistent vulnerability counts.' };
  const blocking = scope === 'all' ? counts.total : counts.high + counts.critical;
  // A genuine finding is final: do not retry it until it disappears.
  if (blocking > 0) return { state: 'blocked', reason: `${blocking} finding(s) exceed the ${scope} audit policy.`, report };
  if (result.error || result.signal || result.status !== 0) return { state: 'unavailable', reason: 'npm did not finish successfully.' };
  return { state: 'passed', reason: `Completed ${scope} audit: no findings exceed policy.`, report };
}

export async function runAudit({ scope, execute, save = () => {}, wait = sleep, attempts = 3, log = console.error }) {
  const args = auditArguments(scope);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('Use one to three audit attempts.');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await execute(args);
    const assessment = assessAudit(result, scope);
    save(attempt, result, assessment);
    log(`[audit ${attempt}/${attempts}] ${assessment.reason}`);
    if (assessment.state === 'passed') return { ...assessment, exitCode: 0 };
    if (assessment.state === 'blocked') return { ...assessment, exitCode: 1 };
    if (attempt < attempts) await wait(attempt * 15000);
  }
  return { state: 'unavailable', exitCode: 2, reason: 'Security audit unavailable after bounded retries. Release remains blocked.' };
}

async function main() {
  const [scope, output, ...extra] = process.argv.slice(2);
  if (!output || extra.length) throw new Error('Usage: node scripts/ci-npm-audit.mjs all|production diagnostics/report.json');
  auditArguments(scope);
  const outputPath = resolve(output);
  mkdirSync(dirname(outputPath), { recursive: true });
  // Never leave an old successful artifact in place when the next scan fails.
  rmSync(outputPath, { force: true });
  const lockBefore = readFileSync('package-lock.json');
  const packageBefore = readFileSync('package.json');
  const result = await runAudit({ scope,
    execute: args => spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024, shell: false,
    }),
    save(attempt, command, assessment) {
      writeFileSync(`${outputPath}.attempt-${attempt}.json`, command.stdout || JSON.stringify({ error: 'No npm report returned.' }));
      writeFileSync(`${outputPath}.attempt-${attempt}.log`, String(command.stderr ?? '') + `\n${command.error?.message ?? ''}`);
      if (assessment.report) writeFileSync(outputPath, JSON.stringify(assessment.report, null, 2) + '\n');
    },
  });
  if (!lockBefore.equals(readFileSync('package-lock.json')) || !packageBefore.equals(readFileSync('package.json'))) {
    throw new Error('Audit changed package manifests. Release blocked.');
  }
  writeFileSync(`${outputPath}.status.json`, JSON.stringify({ scope, state: result.state, exitCode: result.exitCode, reason: result.reason }, null, 2) + '\n');
  console.log(result.reason);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
