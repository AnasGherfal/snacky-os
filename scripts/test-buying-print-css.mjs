import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const postcss=require('postcss');
const localByDefault=require('next/dist/compiled/postcss-modules-local-by-default');
const compile=css=>postcss([localByDefault({mode:'pure'})]).process(css,{from:'BuyingLists.module.css'});
test('buying print CSS compiles with the same pure-module rule used by Next',async()=>{
 const css=readFileSync('src/components/BuyingLists.module.css','utf8');
 const result=await compile(css);assert.ok(result.css.includes('snacky-buying'));
 await assert.rejects(()=>compile(':global(body:has([data-buying-print])) {background:white}'),/not pure/);
});
test('buying print uses scoped normal-flow pagination rather than an absolute sheet',()=>{
 const css=readFileSync('src/components/BuyingLists.module.css','utf8');
 assert.match(css,/@page snacky-buying/);assert.match(css,/page:snacky-buying;position:static/);
 assert.doesNotMatch(css,/@page\s*\{/);
 assert.match(css,/\.printSheet\s*\*\s*\{visibility:visible/);
});
