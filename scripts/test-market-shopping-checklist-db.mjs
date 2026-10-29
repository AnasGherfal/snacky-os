// Optional local runner when native PostgreSQL is unavailable. CI uses psql.
// Install PGlite outside the app, then set SNACKY_PGLITE_MODULE to its index.js.
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const modulePath = process.env.SNACKY_PGLITE_MODULE;
if (!modulePath) throw new Error('Set SNACKY_PGLITE_MODULE to a separately installed PGlite module. No remote database URL is accepted.');
const {PGlite} = await import(pathToFileURL(resolve(modulePath)).href);
const scriptDir = dirname(fileURLToPath(import.meta.url));
async function expandSql(path) {
  const lines = (await readFile(path, 'utf8')).split('\n');
  const result = [];
  for (const line of lines) {
    const include = /^\\ir\s+(.+)$/.exec(line);
    if (include) result.push(await expandSql(resolve(dirname(path), include[1].trim())));
    else if (/^\\(?:set|echo)\b/.test(line)) continue;
    else result.push(line);
  }
  return result.join('\n');
}
const path = await mkdtemp(join(tmpdir(), 'snacky-market-checklist-db-'));
let db;
try {
  db = new PGlite(path);
  await db.exec('create database market_checklist_tests');
  await db.close();
  db = new PGlite(path, {database: 'market_checklist_tests'});
  const results = await db.exec(await expandSql(join(scriptDir, 'test-market-shopping-checklist-db.sql')));
  const summary = results.find(result => result.rows?.some(row => Object.hasOwn(row, 'passed_sql_assertions')));
  if (!summary) throw new Error('SQL fixture completed without its assertion summary.');
  console.log(`Market checklist database: ${summary.rows[0].passed_sql_assertions} SQL assertions passed.`);
  console.log('Actual migration + legacy buying/receipt migrations executed in isolated PGlite; no remote database contacted.');
} catch (error) {
  console.error('Market checklist SQL test failed:', error.message);
  for (const key of ['code', 'detail', 'where']) if (error[key]) console.error(`${key}: ${error[key]}`);
  process.exitCode = 1;
} finally {
  await db?.close();
  await rm(path, {recursive: true, force: true});
}
