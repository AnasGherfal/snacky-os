// Test-only observer: capture visible synthetic data and failing page state.
// Does not modify requests, application code, permissions, responses or assertions.
import {createRequire} from 'node:module';
import {writeFileSync,mkdirSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {chromium}=require('../../.qa/browser/node_modules/playwright');
const launch=chromium.launch.bind(chromium);
chromium.launch=async(...args)=>{
 const browser=await launch(...args),close=browser.close.bind(browser);
 browser.close=async(...args)=>{
  mkdirSync('diagnostics/company-e2e',{recursive:true});let i=0;
  for(const context of browser.contexts())for(const page of context.pages()){
   try{const n=i++;const state={url:page.url(),title:await page.title(),language:await page.locator('html').getAttribute('lang'),forms:await page.locator('form').count(),text:(await page.locator('body').innerText()).slice(0,12000)};
    writeFileSync(`diagnostics/company-e2e/final-page-${n}.json`,JSON.stringify(state,null,2));
    await page.screenshot({path:`diagnostics/company-e2e/final-page-${n}.png`,fullPage:true,timeout:10000});
   }catch{}
  }
  return close(...args);
 };
 return browser;
};
