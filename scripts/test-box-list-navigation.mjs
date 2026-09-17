import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source=fs.readFileSync(new URL('../src/components/CreatePurchaseListButton.tsx',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const item={productId:'p',name:'Product',suggestedQty:48,purchaseUnit:'box',unitsPerBox:24,boxesQty:2};
function render(props,{failWrite=false,failRead=false}={}) {
  let state='',saved=[],writes=0;const navigations=[];
  const jsx=(type,props)=>({type,props});
  const imports={'react/jsx-runtime':{jsx,jsxs:jsx},'react':{useState:()=>[state,value=>{state=value;}]},
    'lucide-react':{PackagePlus:'icon'},'next/navigation':{useRouter:()=>({push:path=>navigations.push(path)})},
    '@/components/I18nProvider':{useLanguage:()=>({locale:'en'})},
    '@/lib/restock-shopping-list':{writeRestockShoppingList:rows=>{writes++;if(failWrite)throw Error('blocked');saved=rows;},readRestockShoppingListStrict:()=>{if(failRead)throw Error('read failed');return saved;}}};
  const exports={};vm.runInNewContext(compiled,{exports,require:name=>{assert.ok(name in imports);return imports[name];}});
  const draw=()=>exports.CreatePurchaseListButton({items:[item],...props});
  const tree=draw();
  return {tree,draw,navigations,saved:()=>saved,writes:()=>writes};
}
test('Review buying list saves box metadata before navigating to the saved list',()=>{
  const result=render({destination:'review'});const button=result.tree.props.children[0];
  assert.match(JSON.stringify(button),/Review buying list/);assert.match(JSON.stringify(button),/2 boxes/);
  button.props.onClick();assert.deepEqual(result.navigations,['/restock-priority/shopping-list']);
  assert.equal(result.saved()[0].suggestedQty,48);assert.equal(result.saved()[0].boxesQty,2);
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
