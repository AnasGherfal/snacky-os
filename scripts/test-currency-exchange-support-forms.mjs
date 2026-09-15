import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as validation from '../src/lib/business-record-validation.ts';
const source = fs.readFileSync('src/components/BusinessRecordForm.tsx','utf8');
const code = ts.transpileModule(source,{ compilerOptions: { module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX }}).outputText;
const ID='11111111-1111-4111-8111-111111111111';
function* walk(node) { if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; } if (!node || typeof node!=='object') return; yield node; yield* walk(node.props?.children); }
function harness({kind='exchange',stored,storageFails=false,respond,locale='en'}={}) {
  const slots=[]; let cursor=0; const effects=[];
  const storage=new Map(stored === undefined ? [] : [[`snacky:business-record:v1:${kind}:test-user`,stored]]);
  const state={ calls:[],navigations:[],uuids:0,storage };
  const hooks={
    useState(initial) { const index=cursor++; if (!(index in slots)) slots[index]=typeof initial==='function'?initial():initial; return [slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}]; },
    useRef(initial) { const index=cursor++; if (!(index in slots)) slots[index]={current:initial}; return slots[index]; },
    useEffect(effect,deps) { const index=cursor++; if (!slots[index] || deps.some((value,i)=>value!==slots[index][i])) {slots[index]=deps;effects.push(effect);} },
  };
  const execute=async fd=>{ const values=Object.fromEntries(fd); state.calls.push(values); return respond?respond(values):{ok:true,id:ID,href:kind==='exchange'?`/finance/exchange?recorded=${ID}`:`/issues?created=${ID}`}; };
  const jsx=(type,props)=>({type,props});
  const imports={react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'next/link':{default:'a'},'next/navigation':{useRouter:()=>({push:href=>state.navigations.push(href),refresh(){}})},'@/components/I18nProvider':{useLanguage:()=>({locale})},'@/lib/business-record-actions':{recordCurrencyExchange:execute,createCustomerIssue:execute},'@/lib/business-record-validation':validation};
  const exports={};
  vm.runInNewContext(code,{exports,FormData,console,crypto:{randomUUID(){state.uuids++;return ID;}},window:{localStorage:{getItem(key){if(storageFails)throw Error('Unavailable');return storage.get(key)??null;},setItem(key,value){if(storageFails)throw Error('Unavailable');storage.set(key,value);},removeItem(key){if(storageFails)throw Error('Unavailable');storage.delete(key);}}},require(id){assert.ok(imports[id],id);return imports[id];}});
  const render=()=>{cursor=0;const nodes=[...walk(exports.BusinessRecordForm({kind,userId:'test-user',today:validation.businessDate(),machines:[]}))]; for(const effect of effects.splice(0))effect(); return nodes;};
  const find=predicate=>{const result=render().find(predicate);assert.ok(result);return result;};
  render();
  return {state,render,find,submit:()=>find(node=>node.type==='form').props.action(),change:(name,value)=>find(node=>node.props?.name===name).props.onChange({target:{value}})};
}
test('exchange saves actual amounts only after confirm, and prevents another submission after success',async()=>{
  const h=harness();assert.equal(h.state.calls.length,0);h.change('source_amount','9000');h.change('destination_amount','1000');h.change('source_account_id','owner_lyd');
  await h.submit();assert.equal(h.state.calls.length,1);assert.equal(h.state.calls[0].source_amount,'9000');assert.equal(h.state.calls[0].destination_amount,'1000');assert.equal(h.state.calls[0].source_account_id,'owner_lyd');assert.equal(h.state.storage.size,0);await h.submit();assert.equal(h.state.calls.length,1);
});
test('uncertain exchange keeps identical request through retries and remount',async()=>{
  const h=harness({respond:async()=>{throw Error('lost response');}});h.change('source_amount','9000');h.change('destination_amount','1000');await h.submit();await h.submit();
  assert.deepEqual(h.state.calls[0],h.state.calls[1]);assert.equal(h.state.uuids,1);assert.equal(h.find(node=>node.type==='fieldset').props.disabled,true);
  const restored=harness({stored:[...h.state.storage.values()][0]});await restored.submit();assert.deepEqual(restored.state.calls[0],h.state.calls[0]);assert.equal(restored.state.uuids,0);
});
test('double-click guard and unavailable storage retain one in-memory request',async()=>{
  let finish;const h=harness({storageFails:true,respond:()=>new Promise(resolve=>{finish=resolve;})});h.change('source_amount','9000');h.change('destination_amount','1000');const first=h.submit();await h.submit();assert.equal(h.state.calls.length,1);finish({ok:false,message:'Retry',retrySameRequest:true});await first;const retry=h.submit();assert.deepEqual(h.state.calls[0],h.state.calls[1]);finish({ok:true,id:ID,href:'/finance/exchange'});await retry;
});
test('corrupt saved requests block and Arabic support form needs no image or route',async()=>{
  for(const stored of ['{}','broken','null']) {const h=harness({stored});await h.submit();assert.equal(h.state.calls.length,0);assert.equal(h.state.uuids,0);}
  const h=harness({kind:'issue',locale:'ar'});assert.equal(h.find(node=>node.type==='form').props.dir,'rtl');h.change('description','المنتج لم ينزل');await h.submit();assert.equal(h.state.calls.length,1);assert.equal(h.state.calls[0].machine_id,'');assert.ok(!h.render().some(node=>node.props?.type==='file'));assert.equal(h.state.navigations[0],`/issues?created=${ID}`);
});
test('every balance consumer is explicitly audited for native FX receipt fields',()=>{
  function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):/\.tsx?$/.test(entry.name)?[path.join(dir,entry.name)]:[]);}
  for(const file of files('src')){
    const text=fs.readFileSync(file,'utf8');
    if (/(computeFinanceBalances(?:FromCutoff)?|transactionImpacts)\s*\(/.test(text) && !file.endsWith('finance-balance.ts')) {
      const loader=text.includes('loadFinanceLedgerRows');
      console.log('BALANCE_READ_MODEL',file,loader?'canonical ledger loader':text.match(/\.select\([\s\S]*?\)/g)?.join(' | ').slice(0,7000));
      if(!loader) assert.ok(text.includes('transfer_destination_amount') || text.includes('.select("*")'),`Load the received currency amount in ${file}`);
    }
  }
});
