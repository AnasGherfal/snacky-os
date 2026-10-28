import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {randomUUID} from 'node:crypto';
import {marketItemsFromRecommendations,marketSuggestionsKey,marketDraftKey,parseMarketDraft} from '../src/lib/market-checklist.ts';

const source=fs.readFileSync(new URL('../src/components/CreatePurchaseListButton.tsx',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const item={productId:'p',name:'Product',suggestedQty:48,purchaseUnit:'box',unitsPerBox:24,boxesQty:2};
function render(props,{failWrite=false,failRead=false,values=new Map()}={}) {
  let state='',saved=[],writes=0;const navigations=[];
  const jsx=(type,props)=>({type,props});
  const imports={'react/jsx-runtime':{jsx,jsxs:jsx},'react':{useState:()=>[state,value=>{state=value;}]},
    'lucide-react':{PackagePlus:'icon'},'next/navigation':{useRouter:()=>({push:path=>navigations.push(path)})},
    '@/components/I18nProvider':{useLanguage:()=>({locale:'en'})},
    '@/lib/market-checklist':{marketItemsFromRecommendations,marketSuggestionsKey,parseMarketDraft},
    '@/lib/restock-shopping-list':{writeRestockShoppingList:rows=>{writes++;if(failWrite)throw Error('blocked');saved=rows;},readRestockShoppingListStrict:()=>{if(failRead)throw Error('read failed');return saved;}}};
  const localStorage={setItem:(key,value)=>{if(failWrite)throw Error('blocked');values.set(key,value);},getItem:key=>{if(failRead)throw Error('read failed');return values.get(key)??null;}};
  const exports={};vm.runInNewContext(compiled,{exports,crypto:{randomUUID},localStorage,require:name=>{assert.ok(name in imports,name);return imports[name];}});
  const draw=()=>exports.CreatePurchaseListButton({items:[item],...props});
  const tree=draw();
  return {tree,draw,navigations,values,saved:()=>saved,writes:()=>writes};
}
test('Build shopping checklist keeps the legacy saved-list handoff when no account context is provided',()=>{
  const result=render({destination:'review'});const button=result.tree.props.children[0];
  assert.match(JSON.stringify(button),/Build shopping checklist/);assert.match(JSON.stringify(button),/2 boxes/);
  button.props.onClick();assert.deepEqual(result.navigations,['/restock-priority/shopping-list']);
  assert.equal(result.saved()[0].suggestedQty,48);assert.equal(result.saved()[0].boxesQty,2);
});
test('account-scoped suggestions preserve the working checklist and open an explicit merge review',()=>{
  const userId='10000000-0000-4000-8000-000000000001';
  const productId='10000000-0000-4000-8000-000000000002';
  const savedDraft=JSON.stringify({version:1,items:[{id:'10000000-0000-4000-8000-000000000003',product_id:null,label:'Chips, any flavour',quantity:3,unit:'boxes',flexibility:'any_brand',acquired_quantity:2,unavailable:false,note:'Found two boxes'}]});
  const values=new Map([[marketDraftKey(userId),savedDraft]]);
  const result=render({destination:'review',userId,items:[{...item,productId}]},{values});
  result.tree.props.children[0].props.onClick();
  assert.deepEqual(result.navigations,['/restock-priority/shopping-list?suggestions=1']);
  assert.equal(values.get(marketDraftKey(userId)),savedDraft,'Refreshing recommendations must not overwrite manual edits or ticks');
  assert.equal(result.writes(),0,'The new checklist path does not write exact receipt prefill');
  const suggestions=parseMarketDraft(values.get(marketSuggestionsKey(userId))).items;
  assert.equal(suggestions.length,1);assert.equal(suggestions[0].product_id,productId);
  assert.equal(suggestions[0].quantity,2);assert.equal(suggestions[0].unit,'boxes');
  assert.equal(suggestions[0].acquired_quantity,0);
});
for(const failure of [{failWrite:true},{failRead:true}])test('failed account-scoped suggestions do not navigate or alter the working checklist '+JSON.stringify(failure),()=>{
  const userId='10000000-0000-4000-8000-000000000001';
  const values=new Map([[marketDraftKey(userId),'existing checklist remains untouched']]);
  const result=render({destination:'review',userId,items:[{...item,productId:'10000000-0000-4000-8000-000000000002'}]},{...failure,values});
  result.tree.props.children[0].props.onClick();
  assert.deepEqual(result.navigations,[]);assert.equal(values.get(marketDraftKey(userId)),'existing checklist remains untouched');
  assert.match(JSON.stringify(result.draw()),/No draft was opened/);
});
test('Create purchase draft uses a distinct visible label and the existing restock entry route',()=>{
  const result=render({label:'Create purchase draft'});const button=result.tree.props.children[0];
  assert.match(JSON.stringify(button),/Create purchase draft/);button.props.onClick();
  assert.deepEqual(result.navigations,['/purchases/new?source=restock']);
});
for (const failure of [{failWrite:true},{failRead:true}])test('failed list persistence never opens a draft or reports a successful handoff '+JSON.stringify(failure),()=>{
  const result=render({},failure);result.tree.props.children[0].props.onClick();
  assert.deepEqual(result.navigations,[]);assert.match(JSON.stringify(result.draw()),/No draft was opened/);
});
test('zero buying quantities do not enable a draft action',()=>{
  const result=render({items:[]});assert.equal(result.tree.props.children[0].props.disabled,true);assert.equal(result.writes(),0);
});
