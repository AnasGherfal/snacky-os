import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {planWholeBoxes, verifiedBoxSize, boxPurchaseRecommendations, boxShoppingItem, boxDraftLine} from '../src/lib/purchase-boxes.ts';
import {writeRestockShoppingList, readRestockShoppingListStrict, RESTOCK_SHOPPING_LIST_STORAGE_KEY} from '../src/lib/restock-shopping-list.ts';
const product = {id:'p',name:'Product',active:true,case_quantity:24,last_purchase_cost_lyd:2};
const suggestion = {productId:'p',name:'Product',suggestedQty:25};
function storage() {
  const values = new Map();
  globalThis.window = {localStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}};
  return values;
}
test('round the shortage UP to whole boxes, never split storage quantities into partial buying boxes',()=>{
  assert.deepEqual(planWholeBoxes(25,24),{caseQuantity:24,suggestedBoxesQty:2,purchaseUnits:48,boxSizeMissing:false});
  assert.equal(planWholeBoxes(1,24).suggestedBoxesQty,1);
  assert.equal(planWholeBoxes(24,24).suggestedBoxesQty,1);
  assert.equal(planWholeBoxes(0,24).suggestedBoxesQty,0);
  assert.equal(planWholeBoxes(114,24).purchaseUnits,120);
  assert.equal(planWholeBoxes(211,15).purchaseUnits,225);
  assert.equal(planWholeBoxes(684,12).suggestedBoxesQty,57);
  assert.equal(planWholeBoxes(24.1,24).suggestedBoxesQty,2);
});
test('default-one, missing and invalid sizes never imply buying individual units',()=>{
  for (const value of [undefined,null,0,1,-1,2.5,'',NaN,Infinity]) {
    assert.equal(verifiedBoxSize(value),null);
    assert.equal(planWholeBoxes(25,value).suggestedBoxesQty,null);
  }
  assert.equal(planWholeBoxes(0,null).purchaseUnits,0);
  assert.throws(()=>planWholeBoxes(NaN,24));
  assert.throws(()=>planWholeBoxes(-1,24));
});
test('box recommendation keeps sales ordering and charges for all received units',()=>{
  const rows=[{productId:'p',suggestedBuyQty:25,lastPurchaseCost:2},{productId:'missing',suggestedBuyQty:5,lastPurchaseCost:2}];
  const result=boxPurchaseRecommendations(rows,[product]);
  assert.equal(result[0].suggestedBuyQty,25);
  assert.equal(result[0].purchaseUnits,48);
  assert.equal(result[0].estimatedBuyCost,96);
  assert.equal(result[1].boxSizeMissing,true);
  assert.equal(result[1].estimatedBuyCost,null);
  assert.deepEqual(result.map(row=>row.productId),['p','missing']);
});
test('saved list round-trip preserves boxes while internal quantity remains units',()=>{
  storage();
  const item=boxShoppingItem(suggestion,product);
  assert.equal(item.suggestedQty,48);assert.equal(item.boxesQty,2);
  writeRestockShoppingList([item]);
  assert.deepEqual(readRestockShoppingListStrict(),[{...item,priorityScore:0,status:null}]);
  const line=boxDraftLine(readRestockShoppingListStrict()[0],product);
  assert.equal(line.boxesQty,2);assert.equal(line.unitsPerBox,24);assert.equal(line.looseUnitsQty,0);
  assert.equal(line.unitCost,2);
  assert.equal(line.boxesQty*line.unitsPerBox+line.looseUnitsQty,48);
  delete globalThis.window;
});
test('changed or missing packaging blocks a saved box draft instead of silently changing it',()=>{
  const item=boxShoppingItem(suggestion,product);
  assert.throws(()=>boxDraftLine(item,{...product,case_quantity:30}),/packaging changed/);
  assert.throws(()=>boxDraftLine(item,{...product,case_quantity:1}),/set the units per box/);
  assert.throws(()=>boxDraftLine(item,{...product,active:false}),/no longer available/);
  assert.equal(boxDraftLine(suggestion,product).boxesQty,2);
});
test('invalid saved box counts fail strictly instead of becoming loose units or an empty list',()=>{
  const values=storage();
  values.set(RESTOCK_SHOPPING_LIST_STORAGE_KEY,JSON.stringify([{...suggestion,purchaseUnit:'box',unitsPerBox:24,boxesQty:1.5}]));
  assert.throws(()=>readRestockShoppingListStrict(),/inconsistent/);
  values.set(RESTOCK_SHOPPING_LIST_STORAGE_KEY,'bad JSON');
  assert.throws(()=>readRestockShoppingListStrict());
  delete globalThis.window;
});
function renderer(file,imports) {
  const states=[], effects=[];let cursor=0;
  const hooks={useState:initial=>{const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return [states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},useEffect:fn=>effects.push(fn),useMemo:fn=>fn()};
  const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const exports={};
  const jsx=(type,props)=>({type,props});
  const modules={'@/components/BuyingListClient':{ShareBuyingList:()=>null},'react':hooks,'react/jsx-runtime':{jsx,jsxs:jsx},'next/link':{default:'a'},...imports};
  vm.runInNewContext(output,{exports,require:name=>{assert.ok(name in modules,name);return modules[name];}});
  return {exports,render:fn=>{cursor=0;return fn();},effects:()=>{effects.splice(0).forEach(fn=>fn());}};
}
function nodes(tree) {const all=[];function walk(node){if(Array.isArray(node))return node.forEach(walk);if(!node||typeof node!=='object')return;all.push(node);walk(node.props?.children);}walk(tree);return all;}
test('actual restock form boundary seeds whole boxes and disables the legacy loose-unit prefill',()=>{
  storage();writeRestockShoppingList([boxShoppingItem(suggestion,product)]);
  const r=renderer('src/components/BoxAwarePurchaseForm.tsx',{
    '@/components/PurchaseForm':{PurchaseForm:'purchase-form'},'@/components/I18nProvider':{useLanguage:()=>({locale:'en'})},
    '@/lib/purchase-boxes':{boxDraftLine},'@/lib/restock-shopping-list':{readRestockShoppingListStrict},
  });
  const props={products:[product],suppliers:[],action:async()=>({ok:true,message:''}),prefillSource:'restock'};
  r.render(()=>r.exports.BoxAwarePurchaseForm(props));r.effects();
  const form=nodes(r.render(()=>r.exports.BoxAwarePurchaseForm(props))).find(node=>node.type==='purchase-form');
  assert.equal(form.props.prefillSource,null);assert.equal(form.props.initialLines[0].boxesQty,2);assert.equal(form.props.initialLines[0].looseUnitsQty,0);
  const manual=nodes(r.render(()=>r.exports.BoxAwarePurchaseForm({...props,prefillSource:null}))).find(node=>node.type==='purchase-form');
  assert.equal(manual.props.initialLines,undefined);
  delete globalThis.window;
});
test('actual Buying List edits integer box counts and saves the corresponding units',()=>{
  storage();writeRestockShoppingList([boxShoppingItem(suggestion,product)]);
  const r=renderer('src/components/RestockBuyingList.tsx',{
    '@/components/I18nProvider':{useLanguage:()=>({locale:'ar'})},'@/components/CreatePurchaseListButton':{CreatePurchaseListButton:'draft-button'},
    '@/lib/purchase-boxes':{boxShoppingItem},'@/lib/restock-shopping-list':{writeRestockShoppingList,readRestockShoppingListStrict,clearRestockShoppingList:()=>{}},
  });
  r.render(()=>r.exports.RestockBuyingList({products:[product]}));r.effects();
  const tree=r.render(()=>r.exports.RestockBuyingList({products:[product]}));
  assert.equal(tree.props.dir,'rtl');
  const input=nodes(tree).find(node=>node.type==='input');
  assert.equal(input.props.value,2);assert.equal(input.props.step,'1');
  input.props.onChange({target:{value:'3'}});
  assert.equal(readRestockShoppingListStrict()[0].suggestedQty,72);
  assert.equal(readRestockShoppingListStrict()[0].boxesQty,3);
  input.props.onChange({target:{value:'1.5'}});
  assert.equal(readRestockShoppingListStrict()[0].boxesQty,3);
  delete globalThis.window;
});
