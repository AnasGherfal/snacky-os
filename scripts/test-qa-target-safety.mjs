import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assertDisposableQaTarget, assertRenderedQaPage } from './qa-target-safety.mjs';
const local = { appUrl:'http://localhost:3001', databaseUrl:'http://127.0.0.1:54321' };
test('real fixture writes require both loopback app and loopback Supabase',()=>{
  assert.deepEqual(assertDisposableQaTarget(local),{appOrigin:local.appUrl,databaseOrigin:local.databaseUrl});
  for(const change of [
    {appUrl:'https://snacky-os.vercel.app'},
    {databaseUrl:'https://thrthmeyhuhxnmizjhqx.supabase.co'},
    {databaseUrl:'http://localhost.attacker.example:54321'},
    {databaseUrl:'http://localhost:54322'},
    {appUrl:'http://localhost:3001/private'},
    {appUrl:'http://name:secret@localhost:3001'},
    {appUrl:'http://localhost:3001?next=https://example.com'},
    {deploymentEnvironment:'production'},
  ])assert.throws(()=>assertDisposableQaTarget({...local,...change}));
});
const rendered={status:200,finalUrl:'http://localhost:3001/inventory',contentType:'text/html; charset=utf-8',body:'<!doctype html><html><main>Verified stock</main></html>'};
test('404, denied, login, empty and error pages never count as successful smoke checks',()=>{
  assert.doesNotThrow(()=>assertRenderedQaPage(rendered,local.appUrl,'Inventory'));
  for(const bad of [
    {status:404},{status:403},{status:500},{status:302},
    {finalUrl:'http://localhost:3001/login'},
    {finalUrl:'http://localhost:3001/unauthorized'},
    {finalUrl:'http://localhost:3001/change-password'},
    {finalUrl:'https://example.com/inventory'},
    {contentType:'application/json'},
    {body:'<html>Sign in</html>'},
    {body:'<main>Application error</main>'},
    {body:'<main>NEXT_HTTP_ERROR_FALLBACK;404</main>'},
  ])assert.throws(()=>assertRenderedQaPage({...rendered,...bad},local.appUrl,'Inventory'));
});
test('smoke fixtures guard the target before creating any accounts and track partial creation',()=>{
  const source=readFileSync('scripts/smoke-authenticated-pages.mjs','utf8');
  assert.ok(source.indexOf('if (canRun) assertDisposableQaTarget')<source.indexOf('async function createQaUser'));
  assert.ok(source.indexOf('created.authUserIds.push(authUser.user.id)')<source.indexOf('.from("team_members")'));
  assert.match(source,/assertRenderedQaPage/);
  assert.doesNotMatch(source,/response\.status < 500/);
});
